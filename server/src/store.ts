// Tiny JSON-file store for Relist accounts and app sessions.
//
// Why a file store: Relist serves one household — a handful of accounts.
// A JSON document under DATA_DIR keeps the home-server deployment trivial
// (no database to run), and every write is atomic (tmp file + rename) so a
// crash mid-write cannot corrupt the accounts file. Browser profiles live
// next to it under <dataDir>/profiles/<userId>/.
//
// Sessions are stored as SHA-256 hashes of the cookie token, never the raw
// token, so reading the data file does not hand out a live session.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type {
  CloneEdits,
  ClonePicks,
  StoredClone,
  SyncedListing,
} from "./cloneTypes.js";
import {
  isTerminalJobStatus,
  type JobHistoryEntry,
  type RecreateJob,
} from "./jobTypes.js";
import type { FacebookStatus } from "./facebookStatus.js";
import { SESSION_TTL_MS } from "./config.js";

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  facebookStatus: FacebookStatus;
  facebookConnectedAt: string | null;
  createdAt: string;
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

interface StoreData {
  users: UserRecord[];
  sessions: SessionRecord[];
  /** Sprint 2: each user's synced listings, keyed by user id. A user id
   *  only ever appears here from that user's own session work — reads
   *  always go through the caller's own id. */
  listings: Record<string, SyncedListing[]>;
  /** Last successful sync time, independent of listing count. */
  listingsSyncedAt?: Record<string, string>;
  /** Sprint 2: clone recoveries + saved picks/edits, per user per listing. */
  clones: Record<string, Record<string, StoredClone>>;
  /** Sprint 3: recreate jobs, per user. The job record IS the state
   *  machine's durable state — it is saved after every transition, so a
   *  server restart resumes each job from its stored status. */
  jobs: Record<string, RecreateJob[]>;
  /** Sprint 3: completed recreates, per user, newest last. */
  history: Record<string, JobHistoryEntry[]>;
  facebookIdentityHashes?: Record<string, string>;
}

function emptyData(): StoreData {
  return {
    users: [], sessions: [], listings: {}, listingsSyncedAt: {}, clones: {}, jobs: {}, history: {},
    facebookIdentityHashes: {},
  };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function profileDirFor(dataDir: string, userId: string): string {
  return path.join(dataDir, "profiles", userId);
}

export class Store {
  private readonly filePath: string;
  private data: StoreData = emptyData();
  private loaded = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly expiredSessionsNotified = new Set<string>();
  private readonly sessionRevocationListeners = new Set<(tokenHash: string) => void>();

  constructor(private readonly dataDir: string) {
    this.filePath = path.join(dataDir, "relist-data.json");
  }

  async load(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.dataDir, 0o700);
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.data = emptyData();
        this.loaded = true;
        return;
      }
      throw error;
    }

    await chmod(this.filePath, 0o600);

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Store file has an invalid shape");
    }
    const record = parsed as Partial<StoreData>;
    if (!Array.isArray(record.users) || !Array.isArray(record.sessions)) {
      throw new Error("Store file is missing required account data");
    }
    for (const key of ["listings", "listingsSyncedAt", "clones", "jobs", "history"] as const) {
      if (record[key] !== undefined && (typeof record[key] !== "object" || record[key] === null || Array.isArray(record[key]))) {
        throw new Error(`Store file has invalid ${key} data`);
      }
    }
    this.data = { ...emptyData(), ...record };
    this.loaded = true;
  }

  private save(): Promise<void> {
    const write = async (): Promise<void> => {
      const tmpPath = `${this.filePath}.tmp-${randomUUID()}`;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(tmpPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify(this.data, null, 2), "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(tmpPath, this.filePath);
        await chmod(this.filePath, 0o600);
        const directory = await open(this.dataDir, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (error) {
        if (handle) {
          await handle.close().catch(() => undefined);
        }
        await rm(tmpPath, { force: true }).catch(() => undefined);
        throw error;
      }
    };
    const result = this.saveQueue.then(write, write);
    this.saveQueue = result.catch(() => undefined);
    return result;
  }

  onSessionRevoked(listener: (tokenHash: string) => void): () => void {
    this.sessionRevocationListeners.add(listener);
    return () => this.sessionRevocationListeners.delete(listener);
  }

  private notifySessionRevoked(tokenHash: string): void {
    for (const listener of this.sessionRevocationListeners) {
      listener(tokenHash);
    }
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error("Store.load() must be called before use");
    }
  }

  async createUser(input: { name: string; email: string; passwordHash: string }): Promise<UserRecord> {
    this.ensureLoaded();
    const user: UserRecord = {
      id: randomUUID(),
      name: input.name,
      email: input.email.toLowerCase(),
      passwordHash: input.passwordHash,
      facebookStatus: "not_connected",
      facebookConnectedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.data.users.push(user);
    await this.save();
    return user;
  }

  findUserByEmail(email: string): UserRecord | undefined {
    this.ensureLoaded();
    const target = email.toLowerCase();
    return this.data.users.find((user) => user.email === target);
  }

  findUserById(id: string): UserRecord | undefined {
    this.ensureLoaded();
    return this.data.users.find((user) => user.id === id);
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    this.ensureLoaded();
    const user = this.findUserById(userId);
    if (!user) return;
    user.passwordHash = passwordHash;
    await this.save();
  }

  async setFacebookStatus(userId: string, status: FacebookStatus): Promise<void> {
    this.ensureLoaded();
    const user = this.findUserById(userId);
    if (!user) {
      return;
    }
    user.facebookStatus = status;
    if (status === "connected") {
      user.facebookConnectedAt = new Date().toISOString();
    }
    if (status === "not_connected") {
      user.facebookConnectedAt = null;
    }
    await this.save();
  }

  getFacebookIdentityHash(userId: string): string | null {
    this.ensureLoaded();
    return this.data.facebookIdentityHashes?.[userId] ?? null;
  }

  async setFacebookIdentity(userId: string, identity: string): Promise<boolean> {
    this.ensureLoaded();
    const identityHash = createHash("sha256").update(identity).digest("hex");
    const current = this.data.facebookIdentityHashes?.[userId];
    if (current === identityHash) return false;
    delete this.data.listings[userId];
    delete this.data.listingsSyncedAt?.[userId];
    delete this.data.clones[userId];
    delete this.data.jobs[userId];
    delete this.data.history[userId];
    const hashes = this.data.facebookIdentityHashes ?? {};
    hashes[userId] = identityHash;
    this.data.facebookIdentityHashes = hashes;
    await this.save();
    return true;
  }

  async createSession(userId: string): Promise<string> {
    this.ensureLoaded();
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    const record: SessionRecord = {
      tokenHash: hashToken(token),
      userId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    };
    this.data.sessions.push(record);
    await this.save();
    return token;
  }

  findUserBySessionToken(token: string): UserRecord | undefined {
    this.ensureLoaded();
    const tokenHash = hashToken(token);
    const record = this.data.sessions.find((session) => session.tokenHash === tokenHash);
    if (!record) {
      return undefined;
    }
    if (Date.parse(record.expiresAt) < Date.now()) {
      if (!this.expiredSessionsNotified.has(tokenHash)) {
        this.expiredSessionsNotified.add(tokenHash);
        this.notifySessionRevoked(tokenHash);
      }
      return undefined;
    }
    return this.findUserById(record.userId);
  }

  async deleteSession(token: string): Promise<void> {
    this.ensureLoaded();
    const tokenHash = hashToken(token);
    this.data.sessions = this.data.sessions.filter((session) => session.tokenHash !== tokenHash);
    await this.save();
    this.notifySessionRevoked(tokenHash);
  }

  // -- Sprint 2: synced listings + clone records (all per-user) -----------

  getListings(userId: string): SyncedListing[] {
    this.ensureLoaded();
    return this.data.listings[userId] ?? [];
  }

  async setListings(userId: string, listings: SyncedListing[]): Promise<void> {
    const syncedAt = listings.at(-1)?.syncedAt;
    if (!syncedAt) {
      throw new Error("An empty sync must provide its successful sync timestamp");
    }
    await this.setListingsSync(userId, listings, syncedAt);
  }

  getListingsSyncedAt(userId: string): string | null {
    this.ensureLoaded();
    const stored = this.data.listingsSyncedAt?.[userId];
    if (stored) return stored;
    return this.data.listings[userId]?.at(-1)?.syncedAt ?? null;
  }

  async setListingsSync(userId: string, listings: SyncedListing[], syncedAt: string): Promise<void> {
    this.ensureLoaded();
    const next = new Date(syncedAt);
    if (!Number.isFinite(next.getTime()) || next.toISOString() !== syncedAt) {
      throw new Error("Listings sync timestamp must be a valid ISO date");
    }
    const previousListings = this.data.listings[userId];
    const previousSyncedAt = this.data.listingsSyncedAt?.[userId];
    this.data.listings[userId] = listings;
    this.data.listingsSyncedAt ??= {};
    this.data.listingsSyncedAt[userId] = syncedAt;
    try {
      await this.save();
    } catch (error) {
      if (previousListings === undefined) delete this.data.listings[userId];
      else this.data.listings[userId] = previousListings;
      if (previousSyncedAt === undefined) delete this.data.listingsSyncedAt[userId];
      else this.data.listingsSyncedAt[userId] = previousSyncedAt;
      throw error;
    }
  }

  getClone(userId: string, listingId: string): StoredClone | undefined {
    this.ensureLoaded();
    return this.data.clones[userId]?.[listingId];
  }

  async saveClone(userId: string, listingId: string, record: StoredClone): Promise<void> {
    this.ensureLoaded();
    const perUser = this.data.clones[userId] ?? {};
    perUser[listingId] = record;
    this.data.clones[userId] = perUser;
    await this.save();
  }

  /** Save the person's picks/edits for one listing, creating the record
   *  (with no recovery yet) when this is the first save. */
  async saveClonePicks(
    userId: string,
    listingId: string,
    input: { picks: ClonePicks; edits: CloneEdits; photoSelection: string[] | null },
  ): Promise<StoredClone> {
    this.ensureLoaded();
    const existing = this.getClone(userId, listingId);
    const record: StoredClone = {
      recovery: existing ? existing.recovery : null,
      picks: input.picks,
      edits: input.edits,
      photoSelection: input.photoSelection,
      updatedAt: new Date().toISOString(),
    };
    const perUser = this.data.clones[userId] ?? {};
    perUser[listingId] = record;
    this.data.clones[userId] = perUser;
    await this.save();
    return record;
  }

  // -- Sprint 3: recreate jobs + history (all per-user) ------------------

  async createJob(job: RecreateJob): Promise<RecreateJob> {
    this.ensureLoaded();
    const perUser = this.data.jobs[job.userId] ?? [];
    perUser.push(job);
    this.data.jobs[job.userId] = perUser;
    await this.save();
    return job;
  }

  getJob(userId: string, jobId: string): RecreateJob | undefined {
    this.ensureLoaded();
    return (this.data.jobs[userId] ?? []).find((job) => job.id === jobId);
  }

  listJobs(userId: string): RecreateJob[] {
    this.ensureLoaded();
    return [...(this.data.jobs[userId] ?? [])];
  }

  /** Every user's non-terminal jobs — the runner's resume sweep after a
   *  restart. Callers only ever act through each job's own userId. */
  listAllActiveJobs(): RecreateJob[] {
    this.ensureLoaded();
    const active: RecreateJob[] = [];
    for (const jobs of Object.values(this.data.jobs)) {
      for (const job of jobs) {
        if (!isTerminalJobStatus(job.status)) {
          active.push(job);
        }
      }
    }
    return active;
  }

  /** The user's one active (non-terminal) job, if any — the per-user
   *  job lock is "an active job exists", checked before creating one. */
  findActiveJob(userId: string): RecreateJob | undefined {
    this.ensureLoaded();
    return (this.data.jobs[userId] ?? []).find((job) => !isTerminalJobStatus(job.status));
  }

  async updateJob(job: RecreateJob): Promise<void> {
    this.ensureLoaded();
    const perUser = this.data.jobs[job.userId] ?? [];
    const index = perUser.findIndex((entry) => entry.id === job.id);
    if (index === -1) {
      perUser.push(job);
    } else {
      perUser[index] = job;
    }
    this.data.jobs[job.userId] = perUser;
    await this.save();
  }

  async addHistory(userId: string, entry: JobHistoryEntry): Promise<void> {
    this.ensureLoaded();
    const perUser = this.data.history[userId] ?? [];
    perUser.push(entry);
    this.data.history[userId] = perUser;
    await this.save();
  }

  listHistory(userId: string): JobHistoryEntry[] {
    this.ensureLoaded();
    return [...(this.data.history[userId] ?? [])];
  }
}
