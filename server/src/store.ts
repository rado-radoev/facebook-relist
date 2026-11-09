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
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  /** Sprint 2: clone recoveries + saved picks/edits, per user per listing. */
  clones: Record<string, Record<string, StoredClone>>;
  /** Sprint 3: recreate jobs, per user. The job record IS the state
   *  machine's durable state — it is saved after every transition, so a
   *  server restart resumes each job from its stored status. */
  jobs: Record<string, RecreateJob[]>;
  /** Sprint 3: completed recreates, per user, newest last. */
  history: Record<string, JobHistoryEntry[]>;
}

function emptyData(): StoreData {
  return { users: [], sessions: [], listings: {}, clones: {}, jobs: {}, history: {} };
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

  constructor(private readonly dataDir: string) {
    this.filePath = path.join(dataDir, "relist-data.json");
  }

  async load(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      // Tolerate data files written before Sprint 2 (no listings/clones).
      this.data = { ...emptyData(), ...parsed };
    } catch {
      this.data = emptyData();
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    // A unique tmp path per save: concurrent writers (e.g. the Sprint 3
    // job runner alongside a request) must never rename each other's
    // tmp file out from under them. Each rename is still atomic, and
    // every save serializes the same in-memory state, so the last
    // rename wins with a complete document.
    const tmpPath = `${this.filePath}.tmp-${randomUUID()}`;
    await writeFile(tmpPath, JSON.stringify(this.data, null, 2), "utf8");
    await rename(tmpPath, this.filePath);
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
      return undefined;
    }
    return this.findUserById(record.userId);
  }

  async deleteSession(token: string): Promise<void> {
    this.ensureLoaded();
    const tokenHash = hashToken(token);
    this.data.sessions = this.data.sessions.filter((session) => session.tokenHash !== tokenHash);
    await this.save();
  }

  // -- Sprint 2: synced listings + clone records (all per-user) -----------

  getListings(userId: string): SyncedListing[] {
    this.ensureLoaded();
    return this.data.listings[userId] ?? [];
  }

  async setListings(userId: string, listings: SyncedListing[]): Promise<void> {
    this.ensureLoaded();
    this.data.listings[userId] = listings;
    await this.save();
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
