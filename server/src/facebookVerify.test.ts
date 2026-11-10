import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BrowserManager,
  ProfileBusyError,
  RELIST_USER_AGENT,
  buildLaunchOptions,
  type BrowserHandle,
  type CdpSessionLike,
  type ContextLike,
  type PageLike,
} from "./browserManager.js";
import type { FacebookStatus } from "./facebookStatus.js";
import {
  LoginSessionRegistry,
  type LoginSocketLike,
} from "./loginSession.js";
import { SELLING_LIST_URL, type PageSnapshot } from "./snapshot.js";
import { Store } from "./store.js";

// ------------------------------------------------------------------ fakes

class FakeCdp implements CdpSessionLike {
  readonly sends: Array<{ method: string; params?: Record<string, unknown> }> = [];

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sends.push({ method, params });
    return {};
  }

  on(): void {
    // No screencast in these fakes.
  }
}

interface VerifyConfig {
  cookies: Array<{ name: string; value?: string; expires?: number }>;
  snapshot: PageSnapshot;
  /** When set, navigating to the selling list lands here instead. */
  redirectUrl?: string;
}

function readySnapshot(): PageSnapshot {
  return {
    url: SELLING_LIST_URL,
    text: "Your listings",
    images: [],
    videos: [],
    surface: { kind: "selling_list", listingId: null, readiness: "ready" },
    sellingCards: [],
  };
}

function goodCookies(userValue = "synthetic-user-1"): Array<{ name: string; value?: string; expires?: number }> {
  return [
    { name: "c_user", value: userValue, expires: -1 },
    { name: "xs", value: "synthetic-xs", expires: Date.now() / 1000 + 3600 },
  ];
}

function makeVerifyHandle(config: VerifyConfig): { handle: BrowserHandle; loginCdp: FakeCdp } {
  const loginCdp = new FakeCdp();
  let autoUrl = "https://www.facebook.com/";
  const autoPage: PageLike = {
    url: () => autoUrl,
    goto: async (url: string) => {
      autoUrl = url === SELLING_LIST_URL && config.redirectUrl ? config.redirectUrl : url;
    },
    screenshot: async () => Buffer.from("fake-jpeg"),
    mouse: { click: async () => undefined, wheel: async () => undefined },
    keyboard: { type: async () => undefined, press: async () => undefined },
    evaluate: async () => config.snapshot,
    viewportSize: () => ({ width: 1280, height: 800 }),
  };
  const loginPage: PageLike = {
    url: () => "https://www.facebook.com/login",
    goto: async () => undefined,
    screenshot: async () => Buffer.from("fake-jpeg"),
    mouse: { click: async () => undefined, wheel: async () => undefined },
    keyboard: { type: async () => undefined, press: async () => undefined },
    evaluate: async () => config.snapshot,
    viewportSize: () => ({ width: 390, height: 844 }),
    close: async () => undefined,
    cdp: async () => loginCdp,
  };
  const context: ContextLike = {
    cookies: async () => config.cookies,
    clearCookies: async () => undefined,
    close: async () => undefined,
    pages: () => [autoPage],
    newPage: async () => loginPage,
  };
  return { handle: { context, page: autoPage }, loginCdp };
}

// ------------------------------------------------------------------ setup

let dataDir: string;
let store: Store;
let managers: BrowserManager[];

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "relist-verify-"));
  store = new Store(dataDir);
  await store.load();
  managers = [];
});

afterEach(async () => {
  for (const manager of managers) {
    await manager.closeAll().catch(() => undefined);
  }
  await rm(dataDir, { recursive: true, force: true });
});

function track(manager: BrowserManager): BrowserManager {
  managers.push(manager);
  return manager;
}

function managerForConfigs(configs: VerifyConfig[], launchedDirs: string[]): BrowserManager {
  let launchIndex = 0;
  return track(new BrowserManager(store, dataDir, async (profileDir) => {
    launchedDirs.push(profileDir);
    const config = configs[Math.min(launchIndex, configs.length - 1)];
    launchIndex += 1;
    return makeVerifyHandle(config).handle;
  }));
}

async function makeUser(email = "verify@example.com"): Promise<string> {
  const user = await store.createUser({ name: "A", email, passwordHash: "x" });
  return user.id;
}

// ------------------------------------------------------------------ tests

describe("identity discipline", () => {
  it("buildLaunchOptions carries the one real-Chrome UA and nothing headless-flavoured", () => {
    const options = buildLaunchOptions({});
    expect(options.userAgent).toBe(RELIST_USER_AGENT);
    expect(options.userAgent).not.toContain("HeadlessChrome");
    expect(RELIST_USER_AGENT).not.toContain("HeadlessChrome");
    expect(options.headless).toBe(true);
    expect(options.viewport).toEqual({ width: 1280, height: 800 });
    expect(options.ignoreHTTPSErrors).toBe(false);
    expect(buildLaunchOptions({ ignoreCertErrors: true }).ignoreHTTPSErrors).toBe(true);
  });

  it("openLoginPage never overrides the user agent, and login + worker share one profileDir", async () => {
    const userId = await makeUser("profile@example.com");
    const launchedDirs: string[] = [];
    const config: VerifyConfig = { cookies: goodCookies(), snapshot: readySnapshot() };
    const fake = makeVerifyHandle(config);
    const manager = track(new BrowserManager(store, dataDir, async (profileDir) => {
      launchedDirs.push(profileDir);
      return fake.handle;
    }));

    await manager.openLoginPage(userId);
    // Emulation touched viewport metrics + touch only — no UA override.
    const methods = fake.loginCdp.sends.map((entry) => entry.method);
    expect(methods).toEqual([
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
    ]);
    expect(methods.join(" ")).not.toContain("UserAgent");
    expect(launchedDirs).toEqual([manager.profileIdFor(userId)]);
    expect(manager.activeProfileId(userId)).toBe(manager.profileIdFor(userId));

    await manager.disconnect(userId);
    expect(manager.activeProfileId(userId)).toBeNull();

    // A worker entry point (snapshot collection) launches the SAME dir.
    const snapshot = await manager.collectSnapshotAt(userId, SELLING_LIST_URL);
    expect(snapshot).not.toBeNull();
    expect(launchedDirs.length).toBe(2);
    expect(launchedDirs[1]).toBe(launchedDirs[0]);
    expect(manager.activeProfileId(userId)).toBe(manager.profileIdFor(userId));
  });
});

describe("verifyConnected — strict §6 ceremony", () => {
  it("missing xs is verifying while a login was in progress, never connected", async () => {
    const userId = await makeUser();
    const launchedDirs: string[] = [];
    const manager = managerForConfigs(
      [{ cookies: [{ name: "c_user", value: "synthetic-user-1", expires: -1 }], snapshot: readySnapshot() }],
      launchedDirs,
    );
    await store.setFacebookStatus(userId, "login_in_progress");
    await expect(manager.verifyConnected(userId)).resolves.toBe("verifying");
    // One pass only: a failed first pass never reaches the restart.
    expect(launchedDirs.length).toBe(1);
    expect(manager.statusOf(userId)).toBe("login_in_progress");
  });

  it("missing xs is expired when the stored status was connected", async () => {
    const userId = await makeUser();
    const launchedDirs: string[] = [];
    const manager = managerForConfigs(
      [{ cookies: [{ name: "c_user", value: "synthetic-user-1", expires: -1 }], snapshot: readySnapshot() }],
      launchedDirs,
    );
    await store.setFacebookStatus(userId, "connected");
    await expect(manager.verifyConnected(userId)).resolves.toBe("expired");
    expect(launchedDirs.length).toBe(1);
  });

  it("an expired xs cookie counts as missing", async () => {
    const userId = await makeUser();
    const launchedDirs: string[] = [];
    const manager = managerForConfigs(
      [{
        cookies: [
          { name: "c_user", value: "synthetic-user-1", expires: -1 },
          { name: "xs", value: "synthetic-xs", expires: 1 },
        ],
        snapshot: readySnapshot(),
      }],
      launchedDirs,
    );
    await store.setFacebookStatus(userId, "login_in_progress");
    await expect(manager.verifyConnected(userId)).resolves.toBe("verifying");
  });

  it("a selling page that lands on /login is login_in_progress", async () => {
    const userId = await makeUser();
    const launchedDirs: string[] = [];
    const manager = managerForConfigs(
      [{ cookies: goodCookies(), snapshot: readySnapshot(), redirectUrl: "https://www.facebook.com/login" }],
      launchedDirs,
    );
    await expect(manager.verifyConnected(userId)).resolves.toBe("login_in_progress");
    expect(launchedDirs.length).toBe(1);
  });

  it("a checkpoint URL is needs_check", async () => {
    const userId = await makeUser();
    const launchedDirs: string[] = [];
    const manager = managerForConfigs(
      [{
        cookies: goodCookies(),
        snapshot: readySnapshot(),
        redirectUrl: "https://www.facebook.com/checkpoint/123456/",
      }],
      launchedDirs,
    );
    await expect(manager.verifyConnected(userId)).resolves.toBe("needs_check");
    expect(launchedDirs.length).toBe(1);
  });

  it("a consent URL is needs_check", async () => {
    const userId = await makeUser();
    const launchedDirs: string[] = [];
    const manager = managerForConfigs(
      [{
        cookies: goodCookies(),
        snapshot: readySnapshot(),
        redirectUrl: "https://www.facebook.com/consent/marketplace/",
      }],
      launchedDirs,
    );
    await expect(manager.verifyConnected(userId)).resolves.toBe("needs_check");
    expect(launchedDirs.length).toBe(1);
  });

  it("a selling snapshot that is not ready is verifying", async () => {
    const userId = await makeUser();
    const launchedDirs: string[] = [];
    const snapshot = readySnapshot();
    snapshot.surface = { kind: "selling_list", listingId: null, readiness: "loading" };
    const manager = managerForConfigs(
      [{ cookies: goodCookies(), snapshot }],
      launchedDirs,
    );
    await expect(manager.verifyConnected(userId)).resolves.toBe("verifying");
    expect(launchedDirs.length).toBe(1);
  });

  it("an identity change across the restart is not connected", async () => {
    const userId = await makeUser();
    const launchedDirs: string[] = [];
    const manager = managerForConfigs(
      [
        { cookies: goodCookies("synthetic-user-1"), snapshot: readySnapshot() },
        { cookies: goodCookies("synthetic-user-2"), snapshot: readySnapshot() },
      ],
      launchedDirs,
    );
    const result = await manager.verifyConnected(userId);
    expect(result).not.toBe("connected");
    expect(result).toBe("needs_check");
    // The restart really happened: the launcher ran a second time.
    expect(launchedDirs.length).toBe(2);
    expect(launchedDirs[1]).toBe(launchedDirs[0]);
  });

  it("all criteria passing in BOTH contexts is connected, and reportedStatus then uses the verified cache", async () => {
    const userId = await makeUser();
    const launchedDirs: string[] = [];
    const manager = managerForConfigs(
      [
        { cookies: goodCookies(), snapshot: readySnapshot() },
        { cookies: goodCookies(), snapshot: readySnapshot() },
      ],
      launchedDirs,
    );
    await expect(manager.verifyConnected(userId)).resolves.toBe("connected");
    expect(launchedDirs.length).toBe(2);
    expect(launchedDirs[1]).toBe(launchedDirs[0]);
    expect(manager.statusOf(userId)).toBe("connected");
    expect(manager.activeProfileId(userId)).toBe(manager.profileIdFor(userId));

    // Verified in this browser session: no third launch, no re-ceremony.
    await expect(manager.reportedStatus(userId)).resolves.toBe("connected");
    expect(launchedDirs.length).toBe(2);
  });
});

describe("profile_busy", () => {
  it("a pending launch with no live session reports profile_busy, never not_connected, and stores nothing", async () => {
    const userId = await makeUser("busy@example.com");
    let releaseLaunch!: (handle: BrowserHandle) => void;
    const gate = new Promise<BrowserHandle>((resolve) => { releaseLaunch = resolve; });
    const manager = track(new BrowserManager(store, dataDir, async () => gate));

    const launch = manager.ensureSession(userId);
    expect(manager.profileBusy(userId)).toBe(true);
    await expect(manager.refreshStatus(userId)).resolves.toBe("profile_busy");
    await expect(manager.reportedStatus(userId)).resolves.toBe("profile_busy");
    // Transient: the stored status was not overwritten.
    expect(manager.statusOf(userId)).toBe("not_connected");

    releaseLaunch(makeVerifyHandle({ cookies: [], snapshot: readySnapshot() }).handle);
    await launch;
    expect(manager.profileBusy(userId)).toBe(false);
  });

  it("a profile-lock launch failure is a ProfileBusyError, and verify reports profile_busy", async () => {
    const userId = await makeUser("locked@example.com");
    const manager = track(new BrowserManager(store, dataDir, async () => {
      throw new Error("The profile is already in use (SingletonLock held)");
    }));
    await expect(manager.ensureSession(userId)).rejects.toBeInstanceOf(ProfileBusyError);
    await expect(manager.verifyConnected(userId)).resolves.toBe("profile_busy");
    expect(manager.statusOf(userId)).toBe("not_connected");
  });
});

// ------------------------------------------------------- login poller gate

type Listener = (...args: never[]) => void;

class FakeSocket implements LoginSocketLike {
  readonly sent: Array<string | Buffer> = [];
  readyState = 1;
  private readonly handlers = new Map<string, Listener[]>();

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  on(event: string, listener: Listener): void {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
  }

  json(): Array<Record<string, unknown>> {
    return this.sent
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }

  ofKind(kind: string): Array<Record<string, unknown>> {
    return this.json().filter((entry) => entry.kind === kind);
  }
}

interface StubLogin {
  registry: LoginSessionRegistry;
  socket: FakeSocket;
  setVerifyResult(result: FacebookStatus): void;
  setPageText(text: string): void;
}

function makeStubLogin(options: {
  cheapStatus: FacebookStatus;
  verifyResult: FacebookStatus;
  pageText?: string;
}): StubLogin {
  let verifyResult = options.verifyResult;
  let pageText = options.pageText ?? "";
  const cdp = new FakeCdp();
  const page: PageLike = {
    url: () => "https://www.facebook.com/login",
    goto: async () => undefined,
    screenshot: async () => Buffer.from("fake-jpeg"),
    mouse: { click: async () => undefined, wheel: async () => undefined },
    keyboard: { type: async () => undefined, press: async () => undefined },
    evaluate: async (expression: string) => {
      if (expression.includes("relist-page-state")) {
        return { text: pageText, hasCodeField: false };
      }
      if (expression.includes("relist-focus")) {
        return { kind: null, value: "" };
      }
      return { url: "https://www.facebook.com/login", text: pageText, images: [], videos: [] };
    },
    viewportSize: () => ({ width: 390, height: 844 }),
    close: async () => undefined,
    cdp: async () => cdp,
  };
  const stubBrowser = {
    openLoginPage: async () => page,
    onNewPage: async () => undefined,
    closeLoginPage: async () => undefined,
    refreshStatus: async () => options.cheapStatus,
    verifyConnected: async () => verifyResult,
  };
  const registry = new LoginSessionRegistry(
    stubBrowser as unknown as BrowserManager,
    { pollIntervalMs: 60_000 },
  );
  return {
    registry,
    socket: new FakeSocket(),
    setVerifyResult(result: FacebookStatus) {
      verifyResult = result;
    },
    setPageText(text: string) {
      pageText = text;
    },
  };
}

describe("login poller — strict Connected gate + passkey hint", () => {
  it("does not declare connected from the cheap streak while verification says verifying, then does when it passes", async () => {
    const stub = makeStubLogin({ cheapStatus: "connected", verifyResult: "verifying" });
    await stub.registry.attach("stub-user", stub.socket);

    await stub.registry.pollOnce("stub-user");
    await stub.registry.pollOnce("stub-user");
    await stub.registry.pollOnce("stub-user");
    // The streak fired the ceremony, the ceremony said "verifying":
    // no terminal connected state, a verifying status, session alive.
    expect(stub.socket.ofKind("state")).toEqual([{ kind: "state", state: "streaming" }]);
    expect(stub.socket.ofKind("status")).toContainEqual({ kind: "status", status: "verifying" });
    expect(stub.registry.hasSession("stub-user")).toBe(true);

    stub.setVerifyResult("connected");
    await stub.registry.pollOnce("stub-user");
    await stub.registry.pollOnce("stub-user");
    expect(stub.socket.ofKind("state")).toEqual([{ kind: "state", state: "streaming" }]);
    await stub.registry.pollOnce("stub-user");
    expect(stub.socket.ofKind("state")).toEqual([
      { kind: "state", state: "streaming" },
      { kind: "state", state: "connected" },
    ]);
    expect(stub.registry.hasSession("stub-user")).toBe(false);
    await stub.registry.endAll().catch(() => undefined);
  });

  it("surfaces a passkey hint for a security-key prompt and does not park", async () => {
    const stub = makeStubLogin({
      cheapStatus: "login_in_progress",
      verifyResult: "verifying",
      pageText: "Insert your security key, or use a passkey, to finish signing in.",
    });
    await stub.registry.attach("stub-user", stub.socket);
    await stub.registry.pollOnce("stub-user");
    expect(stub.socket.ofKind("hint")).toEqual([{ kind: "hint", hint: "passkey" }]);
    expect(stub.socket.ofKind("state")).toEqual([{ kind: "state", state: "streaming" }]);
    expect(stub.registry.hasSession("stub-user")).toBe(true);
    await stub.registry.endAll().catch(() => undefined);
  });
});
