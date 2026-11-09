import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BrowserManager,
  type BrowserHandle,
  type ContextLike,
  type PageLike,
} from "./browserManager.js";
import { Store } from "./store.js";

function makeFakeHandle(cookies: Array<{ name: string }> = []): BrowserHandle {
  const page: PageLike = {
    url: () => "https://www.facebook.com/login",
    goto: async () => undefined,
    screenshot: async () => Buffer.from("fake-jpeg-bytes"),
    mouse: { click: async () => undefined, wheel: async () => undefined },
    keyboard: { type: async () => undefined, press: async () => undefined },
    evaluate: async () => "",
    viewportSize: () => ({ width: 1280, height: 800 }),
  };
  const context: ContextLike = {
    cookies: async () => cookies,
    clearCookies: async () => undefined,
    close: async () => undefined,
    pages: () => [page],
    newPage: async () => page,
  };
  return { context, page };
}

let dataDir: string;
let store: Store;
let launchedDirs: string[];

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "relist-browser-"));
  store = new Store(dataDir);
  await store.load();
  launchedDirs = [];
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function makeManager(cookies: Array<{ name: string }> = []): BrowserManager {
  return new BrowserManager(store, dataDir, async (profileDir) => {
    launchedDirs.push(profileDir);
    return makeFakeHandle(cookies);
  });
}

describe("BrowserManager", () => {
  it("startLogin launches one browser per user with distinct profile dirs", async () => {
    const first = await store.createUser({ name: "A", email: "a@example.com", passwordHash: "x" });
    const second = await store.createUser({ name: "B", email: "b@example.com", passwordHash: "x" });
    const manager = makeManager();

    await manager.startLogin(first.id);
    await manager.startLogin(second.id);
    expect(launchedDirs.length).toBe(2);
    expect(launchedDirs[0]).not.toBe(launchedDirs[1]);
    expect(launchedDirs[0]).toContain(first.id);

    // Re-starting the same user's login reuses the one active session.
    await manager.startLogin(first.id);
    expect(launchedDirs.length).toBe(2);
    expect(manager.hasActiveSession(first.id)).toBe(true);
    await manager.closeAll();
  });

  it("transitions to login_in_progress without a session cookie", async () => {
    const user = await store.createUser({ name: "A", email: "a@example.com", passwordHash: "x" });
    const manager = makeManager();
    const status = await manager.startLogin(user.id);
    expect(status).toBe("login_in_progress");
    await manager.closeAll();
  });

  it("detects connected when the c_user cookie appears", async () => {
    const user = await store.createUser({ name: "A", email: "a@example.com", passwordHash: "x" });
    const manager = makeManager([{ name: "c_user" }]);
    const status = await manager.startLogin(user.id);
    expect(status).toBe("connected");
    await manager.closeAll();
  });

  it("disconnect clears only that user's session and status", async () => {
    const first = await store.createUser({ name: "A", email: "a@example.com", passwordHash: "x" });
    const second = await store.createUser({ name: "B", email: "b@example.com", passwordHash: "x" });
    const manager = makeManager();
    await manager.startLogin(first.id);
    await manager.startLogin(second.id);

    await manager.disconnect(first.id);
    expect(manager.statusOf(first.id)).toBe("not_connected");
    expect(manager.hasActiveSession(first.id)).toBe(false);
    expect(manager.statusOf(second.id)).toBe("login_in_progress");
    expect(manager.hasActiveSession(second.id)).toBe(true);
    await manager.closeAll();
  });

  it("sendInput reports false when the user has no browser session", async () => {
    const user = await store.createUser({ name: "A", email: "a@example.com", passwordHash: "x" });
    const manager = makeManager();
    await expect(manager.sendInput(user.id, { type: "key", key: "Enter" })).resolves.toBe(false);
  });
});
