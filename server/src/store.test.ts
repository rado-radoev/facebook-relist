import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { profileDirFor, Store } from "./store.js";

let dataDir: string;
let store: Store;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "relist-store-"));
  store = new Store(dataDir);
  await store.load();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("Store users", () => {
  it("creates and finds a user by email, case-insensitively", async () => {
    const user = await store.createUser({
      name: "Test One",
      email: "One@Example.com",
      passwordHash: "scrypt:fake",
    });
    expect(store.findUserByEmail("one@example.com")?.id).toBe(user.id);
    expect(store.findUserById(user.id)?.name).toBe("Test One");
    expect(user.facebookStatus).toBe("not_connected");
  });

  it("tracks facebook status per user without leaking across users", async () => {
    const first = await store.createUser({ name: "A", email: "a@example.com", passwordHash: "x" });
    const second = await store.createUser({ name: "B", email: "b@example.com", passwordHash: "x" });
    await store.setFacebookStatus(first.id, "login_in_progress");
    expect(store.findUserById(first.id)?.facebookStatus).toBe("login_in_progress");
    expect(store.findUserById(second.id)?.facebookStatus).toBe("not_connected");
  });

  it("persists users to disk across Store instances", async () => {
    const user = await store.createUser({ name: "A", email: "a@example.com", passwordHash: "x" });
    const reopened = new Store(dataDir);
    await reopened.load();
    expect(reopened.findUserById(user.id)?.email).toBe("a@example.com");
  });
});

describe("Store sessions", () => {
  it("resolves a user from a session token and forgets it on delete", async () => {
    const user = await store.createUser({ name: "A", email: "a@example.com", passwordHash: "x" });
    const token = await store.createSession(user.id);
    expect(store.findUserBySessionToken(token)?.id).toBe(user.id);
    await store.deleteSession(token);
    expect(store.findUserBySessionToken(token)).toBeUndefined();
  });

  it("does not resolve an unknown token", () => {
    expect(store.findUserBySessionToken("nope")).toBeUndefined();
  });
});

describe("profileDirFor", () => {
  it("gives each user a distinct profile directory", () => {
    const first = profileDirFor("/data", "user-1");
    const second = profileDirFor("/data", "user-2");
    expect(first).toBe(path.join("/data", "profiles", "user-1"));
    expect(first).not.toBe(second);
  });
});
