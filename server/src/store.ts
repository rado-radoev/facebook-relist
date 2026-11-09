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
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function profileDirFor(dataDir: string, userId: string): string {
  return path.join(dataDir, "profiles", userId);
}

export class Store {
  private readonly filePath: string;
  private data: StoreData = { users: [], sessions: [] };
  private loaded = false;

  constructor(private readonly dataDir: string) {
    this.filePath = path.join(dataDir, "relist-data.json");
  }

  async load(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.data = JSON.parse(raw) as StoreData;
    } catch {
      this.data = { users: [], sessions: [] };
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const tmpPath = `${this.filePath}.tmp`;
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
}
