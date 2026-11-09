import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
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

  it("clears account-scoped listing data when Facebook identity changes", async () => {
    const user = await store.createUser({ name: "A", email: "clear@example.com", passwordHash: "x" });
    await store.setListings(user.id, [{
      id: "old-listing", title: "Old", price: "$1", status: "active", statusText: "Active",
      photoUrl: "", url: "https://www.facebook.com/marketplace/item/old", listedDate: null,
      syncedAt: new Date(0).toISOString(),
    }]);
    await store.setFacebookStatus(user.id, "connected");
    await store.setFacebookIdentity(user.id, "10001");
    await store.setListings(user.id, [{
      id: "second-listing", title: "Second", price: "$2", status: "active", statusText: "Active",
      photoUrl: "", url: "https://www.facebook.com/marketplace/item/second", listedDate: null,
      syncedAt: new Date(0).toISOString(),
    }]);
    await store.setFacebookIdentity(user.id, "10002");
    expect(store.getListings(user.id)).toEqual([]);
    expect(store.getFacebookIdentityHash(user.id)).toBe(createHash("sha256").update("10002").digest("hex"));
  });

  it("tracks facebook status per user without leaking across users", async () => {
    const first = await store.createUser({ name: "A", email: "a@example.com", passwordHash: "x" });
    const second = await store.createUser({ name: "B", email: "b@example.com", passwordHash: "x" });
    await store.setFacebookStatus(first.id, "login_in_progress");
    expect(store.findUserById(first.id)?.facebookStatus).toBe("login_in_progress");
    expect(store.findUserById(second.id)?.facebookStatus).toBe("not_connected");
  });

  it("fails closed when the persisted store is corrupt", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dataDir, "relist-data.json"), "{not-json", "utf8");
    const reopened = new Store(dataDir);
    await expect(reopened.load()).rejects.toThrow();
  });

  it("restricts permissions on a corrupt existing store before failing closed", async () => {
    const { chmod, stat, writeFile } = await import("node:fs/promises");
    const file = path.join(dataDir, "relist-data.json");
    await writeFile(file, "{not-json", "utf8");
    await chmod(file, 0o666);
    const reopened = new Store(dataDir);
    await expect(reopened.load()).rejects.toThrow();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("keeps a valid existing store private instead of trusting its old mode", async () => {
    const { chmod, stat } = await import("node:fs/promises");
    const user = await store.createUser({ name: "Existing", email: "existing@example.com", passwordHash: "x" });
    const file = path.join(dataDir, "relist-data.json");
    await chmod(dataDir, 0o777);
    await chmod(file, 0o666);
    const reopened = new Store(dataDir);
    await reopened.load();
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(reopened.findUserById(user.id)?.email).toBe("existing@example.com");
  });

  it("serializes concurrent durable writes and keeps the store private", async () => {
    const { stat } = await import("node:fs/promises");
    await Promise.all(Array.from({ length: 24 }, (_, index) =>
      store.createUser({ name: `Person ${index}`, email: `person${index}@example.com`, passwordHash: "x" }),
    ));
    const reopened = new Store(dataDir);
    await reopened.load();
    expect(Array.from({ length: 24 }, (_, index) => reopened.findUserByEmail(`person${index}@example.com`)))
      .toHaveLength(24);
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(dataDir, "relist-data.json"))).mode & 0o777).toBe(0o600);
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

  it("notifies listeners once when a session expires", async () => {
    const { readFile, writeFile } = await import("node:fs/promises");
    const user = await store.createUser({ name: "A", email: "expired@example.com", passwordHash: "x" });
    const token = await store.createSession(user.id);
    const file = path.join(dataDir, "relist-data.json");
    const data = JSON.parse(await readFile(file, "utf8")) as { sessions: Array<{ expiresAt: string }> };
    data.sessions[0].expiresAt = new Date(0).toISOString();
    await writeFile(file, JSON.stringify(data), "utf8");
    const reopened = new Store(dataDir);
    await reopened.load();
    let revocations = 0;
    reopened.onSessionRevoked(() => { revocations += 1; });
    expect(reopened.findUserBySessionToken(token)).toBeUndefined();
    expect(reopened.findUserBySessionToken(token)).toBeUndefined();
    expect(revocations).toBe(1);
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
