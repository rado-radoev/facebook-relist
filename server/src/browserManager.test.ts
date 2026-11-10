import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BrowserManager,
  FACEBOOK_LOGIN_URL,
  disableChromiumPasswordManager,
  type BrowserHandle,
  type CdpSessionLike,
  type ContextLike,
  type PageLike,
} from "./browserManager.js";
import { Store } from "./store.js";

function makeFakeHandle(cookies: Array<{ name: string; value?: string }> = []): BrowserHandle {
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
    cookies: async () => cookies.map((cookie) => cookie.name === "c_user" && !cookie.value
      ? { ...cookie, value: "synthetic-facebook-user" }
      : cookie),
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
  it("runs user operations FIFO and never overlaps callbacks", async () => {
    const user = await store.createUser({ name: "A", email: "a@example.com", passwordHash: "x" });
    const manager = makeManager();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = manager.withUserOperation(user.id, async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    const second = manager.withUserOperation(user.id, async () => {
      order.push("second:start");
      order.push("second:end");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("rejects nested acquisition without blocking the next queued operation", async () => {
    const user = await store.createUser({ name: "A", email: "nested@example.com", passwordHash: "x" });
    const manager = makeManager();
    await expect(manager.withUserOperation(user.id, async () =>
      manager.withUserOperation(user.id, async () => "unreachable"),
    )).rejects.toThrow(/non-reentrant/i);
    await expect(manager.withUserOperation(user.id, async () => "released"))
      .resolves.toBe("released");
  });

  it("waits for an active operation before disconnecting its browser", async () => {
    const user = await store.createUser({ name: "A", email: "lifecycle@example.com", passwordHash: "x" });
    let finishOperation!: () => void;
    const operationGate = new Promise<void>((resolve) => { finishOperation = resolve; });
    let operationStarted!: () => void;
    const started = new Promise<void>((resolve) => { operationStarted = resolve; });
    let closeCount = 0;
    const handle = makeFakeHandle();
    handle.context.close = async () => { closeCount += 1; };
    const manager = new BrowserManager(store, dataDir, async () => handle);
    await manager.ensureSession(user.id);
    const operation = manager.withUserOperation(user.id, async () => {
      operationStarted();
      await operationGate;
    });
    await started;
    const disconnect = manager.disconnect(user.id);
    await Promise.resolve();
    expect(closeCount).toBe(0);
    finishOperation();
    await Promise.all([operation, disconnect]);
    expect(closeCount).toBe(1);
  });

  it("does not let a concurrent disconnect finish before cleanup is complete", async () => {
    const user = await store.createUser({ name: "A", email: "double-disconnect@example.com", passwordHash: "x" });
    let finishClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { finishClose = resolve; });
    let closeStarted!: () => void;
    const started = new Promise<void>((resolve) => { closeStarted = resolve; });
    const handle = makeFakeHandle();
    handle.context.close = async () => {
      closeStarted();
      await closeGate;
    };
    const replacementManager = new BrowserManager(store, dataDir, async () => handle);
    await replacementManager.ensureSession(user.id);

    const first = replacementManager.disconnect(user.id);
    await started;
    let secondFinished = false;
    const second = replacementManager.disconnect(user.id).then(() => { secondFinished = true; });
    await Promise.resolve();
    expect(secondFinished).toBe(false);
    finishClose();
    await Promise.all([first, second]);
    expect(secondFinished).toBe(true);
    expect(replacementManager.hasActiveSession(user.id)).toBe(false);
  });

  it("coalesces simultaneous browser launches for one user", async () => {
    const user = await store.createUser({ name: "A", email: "a@example.com", passwordHash: "x" });
    let launches = 0;
    let launchStarted!: () => void;
    const started = new Promise<void>((resolve) => { launchStarted = resolve; });
    let finishLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => { finishLaunch = resolve; });
    const manager = new BrowserManager(store, dataDir, async () => {
      launches += 1;
      launchStarted();
      await launchGate;
      return makeFakeHandle();
    });

    const first = manager.ensureSession(user.id);
    const second = manager.ensureSession(user.id);
    await started;
    expect(launches).toBe(1);
    finishLaunch();
    const [firstSession, secondSession] = await Promise.all([first, second]);
    expect(firstSession).toBe(secondSession);
    await manager.closeAll();
  });

  it("cancels a pending launch before disconnect cleanup and prevents a stale session", async () => {
    const user = await store.createUser({ name: "A", email: "cancel-launch@example.com", passwordHash: "x" });
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    let launchStarted!: () => void;
    const started = new Promise<void>((resolve) => { launchStarted = resolve; });
    let closeCount = 0;
    const handle = makeFakeHandle();
    handle.context.close = async () => { closeCount += 1; };
    const manager = new BrowserManager(store, dataDir, async () => {
      launchStarted();
      await launchGate;
      return handle;
    });

    const launch = manager.ensureSession(user.id);
    await started;
    const disconnect = manager.disconnect(user.id);
    const concurrentLaunch = manager.ensureSession(user.id);
    releaseLaunch();

    await expect(launch).rejects.toThrow(/cancelled/i);
    await expect(concurrentLaunch).rejects.toThrow(/closing/i);
    await disconnect;
    expect(closeCount).toBe(1);
    expect(manager.hasActiveSession(user.id)).toBe(false);
  });

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

  it("does not reuse a stale Facebook connection after reconnecting", async () => {
    const user = await store.createUser({ name: "A", email: "cache@example.com", passwordHash: "x" });
    const manager = makeManager([{ name: "c_user" }]);
    await store.setListings(user.id, [{
      id: "old-listing", title: "Old", price: "$1", status: "active", statusText: "Active",
      photoUrl: "", url: "https://www.facebook.com/marketplace/item/old", listedDate: null,
      syncedAt: new Date(0).toISOString(),
    }]);
    await manager.startLogin(user.id);
    expect(store.getListings(user.id)).toEqual([]);
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

  it("does not record a Facebook connection as verified from a cookie alone", async () => {
    const user = await store.createUser({ name: "A", email: "identity@example.com", passwordHash: "x" });
    const handle = makeFakeHandle([{ name: "c_user", value: "synthetic-facebook-user" }]);
    handle.page.url = () => "https://www.facebook.com/";
    const manager = new BrowserManager(store, dataDir, async () => handle);
    expect(await manager.startLogin(user.id)).toBe("connected");
    expect(store.getFacebookIdentityHash(user.id)).toBe(
      createHash("sha256").update("synthetic-facebook-user").digest("hex"),
    );
    expect(await readFile(path.join(dataDir, "relist-data.json"), "utf8"))
      .not.toContain("synthetic-facebook-user");
    await manager.closeAll();
  });

  it("requires reconfirmation and clears listing cache when Facebook identity changes", async () => {
    const user = await store.createUser({ name: "A", email: "identity-change@example.com", passwordHash: "x" });
    let identity = "first-synthetic-user";
    const handle = makeFakeHandle();
    handle.page.url = () => "https://www.facebook.com/";
    handle.context.cookies = async () => [{ name: "c_user", value: identity }];
    const manager = new BrowserManager(store, dataDir, async () => handle);
    expect(await manager.startLogin(user.id)).toBe("connected");
    await store.setListings(user.id, [{
      id: "previous-user-listing", title: "Old", price: "$1", status: "active", statusText: "Active",
      photoUrl: "", url: "https://www.facebook.com/marketplace/item/old", listedDate: null,
      syncedAt: new Date(0).toISOString(),
    }]);
    identity = "second-synthetic-user";
    expect(await manager.refreshStatus(user.id)).toBe("needs_check");
    expect(store.getListings(user.id)).toEqual([]);
    await manager.closeAll();
  });

  it("clears jobs, history, and archived files when Facebook identity changes", async () => {
    const user = await store.createUser({ name: "A", email: "identity-cache@example.com", passwordHash: "x" });
    let identity = "first-synthetic-user";
    const handle = makeFakeHandle();
    handle.page.url = () => "https://www.facebook.com/";
    handle.context.cookies = async () => [{ name: "c_user", value: identity }];
    const manager = new BrowserManager(store, dataDir, async () => handle);
    expect(await manager.startLogin(user.id)).toBe("connected");

    await store.createJob({ userId: user.id } as never);
    await store.addHistory(user.id, { id: "synthetic-history" } as never);
    const archiveDir = path.join(dataDir, "archive", user.id);
    await mkdir(archiveDir, { recursive: true });
    const archivedFile = path.join(archiveDir, "synthetic-photo.jpg");
    await writeFile(archivedFile, Buffer.from("synthetic media"));

    identity = "second-synthetic-user";
    expect(await manager.refreshStatus(user.id)).toBe("needs_check");
    expect(store.listJobs(user.id)).toEqual([]);
    expect(store.listHistory(user.id)).toEqual([]);
    await expect(readFile(archivedFile)).rejects.toThrow();
    await manager.closeAll();
  });

  it("sendInput reports false when the user has no browser session", async () => {
    const user = await store.createUser({ name: "A", email: "a@example.com", passwordHash: "x" });
    const manager = makeManager();
    await expect(manager.sendInput(user.id, { type: "key", key: "Enter" })).resolves.toBe(false);
  });
});

// ---------------------------------------------------------- login page

class FakeManagerCdp implements CdpSessionLike {
  readonly sends: Array<{ method: string; params?: Record<string, unknown> }> = [];

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sends.push({ method, params });
    return {};
  }

  on(): void {
    // No screencast in these fakes.
  }
}

function makeLoginCapableHandle() {
  const autoCdp = new FakeManagerCdp();
  const loginCdp = new FakeManagerCdp();
  const autoGotos: string[] = [];
  const loginGotos: string[] = [];
  const snapshot = {
    url: "https://www.facebook.com/marketplace/you/selling",
    text: "",
    images: [] as string[],
    videos: [] as string[],
  };
  const autoPage: PageLike = {
    url: () => "https://www.facebook.com/",
    goto: async (url: string) => {
      autoGotos.push(url);
    },
    screenshot: async () => Buffer.from("fake-jpeg-bytes"),
    mouse: { click: async () => undefined, wheel: async () => undefined },
    keyboard: { type: async () => undefined, press: async () => undefined },
    evaluate: async () => snapshot,
    viewportSize: () => ({ width: 1280, height: 800 }),
    setInputFiles: async () => undefined,
    cdp: async () => autoCdp,
  };
  const loginPage: PageLike = {
    url: () => "https://www.facebook.com/login",
    goto: async (url: string) => {
      loginGotos.push(url);
    },
    screenshot: async () => Buffer.from("fake-jpeg-bytes"),
    mouse: { click: async () => undefined, wheel: async () => undefined },
    keyboard: { type: async () => undefined, press: async () => undefined },
    evaluate: async () => snapshot,
    viewportSize: () => ({ width: 390, height: 844 }),
    close: async () => undefined,
    cdp: async () => loginCdp,
  };
  const context: ContextLike = {
    cookies: async () => [],
    clearCookies: async () => undefined,
    close: async () => undefined,
    pages: () => [autoPage],
    newPage: async () => loginPage,
  };
  const handle: BrowserHandle = { context, page: autoPage };
  return { handle, autoCdp, loginCdp, autoGotos, loginGotos, autoPage, loginPage };
}

describe("BrowserManager login page", () => {
  it("openLoginPage applies emulation to the dedicated new page only", async () => {
    const user = await store.createUser({ name: "A", email: "login-page@example.com", passwordHash: "x" });
    const fake = makeLoginCapableHandle();
    const manager = new BrowserManager(store, dataDir, async () => fake.handle);

    const page = await manager.openLoginPage(user.id);
    expect(page).toBe(fake.loginPage);
    expect(manager.loginInProgress(user.id)).toBe(true);
    expect(manager.getLoginPage(user.id)).toBe(fake.loginPage);
    expect(fake.loginGotos).toEqual([FACEBOOK_LOGIN_URL]);
    // The automation page was neither navigated nor emulated.
    expect(fake.autoGotos).toEqual([]);
    expect(fake.autoCdp.sends).toEqual([]);
    expect(fake.loginCdp.sends).toEqual([
      {
        method: "Emulation.setDeviceMetricsOverride",
        params: {
          width: 390, height: 844, deviceScaleFactor: 2, mobile: false,
          screenWidth: 390, screenHeight: 844,
        },
      },
      {
        method: "Emulation.setTouchEmulationEnabled",
        params: { enabled: true, maxTouchPoints: 5 },
      },
    ]);
    // Reopening reuses the same login page instead of stacking pages.
    await expect(manager.openLoginPage(user.id)).resolves.toBe(fake.loginPage);
    expect(fake.loginGotos).toEqual([FACEBOOK_LOGIN_URL]);
    await manager.closeAll();
  });

  it("blocks automation while a login page is open and unblocks after it closes", async () => {
    const user = await store.createUser({ name: "A", email: "login-guard@example.com", passwordHash: "x" });
    const fake = makeLoginCapableHandle();
    const manager = new BrowserManager(store, dataDir, async () => fake.handle);
    await manager.ensureSession(user.id);

    await manager.openLoginPage(user.id);
    expect(await manager.collectSnapshotAt(user.id, "https://www.facebook.com/marketplace/you/selling"))
      .toBeNull();
    expect(await manager.runScript(user.id, "/* anything */")).toBeNull();
    expect(await manager.uploadFiles(user.id, 'input[type="file"]', [])).toBe(false);
    expect(await manager.advanceWizard(user.id)).toBe(false);
    // The read-only current-page snapshot stays unguarded.
    expect(await manager.collectCurrentSnapshot(user.id)).not.toBeNull();

    await manager.closeLoginPage(user.id);
    expect(manager.loginInProgress(user.id)).toBe(false);
    expect(await manager.collectSnapshotAt(user.id, "https://www.facebook.com/marketplace/you/selling"))
      .not.toBeNull();
    expect(await manager.runScript(user.id, "/* anything */")).not.toBeNull();
    expect(await manager.uploadFiles(user.id, 'input[type="file"]', [])).toBe(true);
    await manager.closeAll();
  });

  it("disableChromiumPasswordManager merges Preferences without clobbering", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "relist-prefs-"));
    try {
      const { mkdir: mkdirFs, writeFile: writeFileFs } = await import("node:fs/promises");
      await mkdirFs(path.join(profileDir, "Default"), { recursive: true });
      const prefsPath = path.join(profileDir, "Default", "Preferences");
      await writeFileFs(prefsPath, JSON.stringify({
        credentials_enable_service: true,
        profile: { name: "Person", password_manager_enabled: true },
        unrelated: { keep: 1 },
      }));
      await disableChromiumPasswordManager(profileDir);
      const merged = JSON.parse(await readFile(prefsPath, "utf8")) as Record<string, unknown>;
      expect(merged.credentials_enable_service).toBe(false);
      expect(merged.profile).toEqual({ name: "Person", password_manager_enabled: false });
      expect(merged.unrelated).toEqual({ keep: 1 });

      // A corrupt Preferences file is tolerated and replaced with the
      // two settings that matter.
      await writeFileFs(prefsPath, "not json{");
      await disableChromiumPasswordManager(profileDir);
      const repaired = JSON.parse(await readFile(prefsPath, "utf8")) as Record<string, unknown>;
      expect(repaired.credentials_enable_service).toBe(false);
      expect(repaired.profile).toEqual({ password_manager_enabled: false });
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });
});
