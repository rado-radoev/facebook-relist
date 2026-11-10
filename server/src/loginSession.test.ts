import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BrowserManager,
  type BrowserHandle,
  type CdpSessionLike,
  type ContextLike,
  type PageLike,
} from "./browserManager.js";
import {
  LoginSessionRegistry,
  computeFingerprint,
  type FieldKind,
  type LoginSocketLike,
} from "./loginSession.js";
import { Store } from "./store.js";

// ---------------------------------------------------------------- fakes

class FakeCdp implements CdpSessionLike {
  readonly sends: Array<{ method: string; params?: Record<string, unknown> }> = [];
  private readonly handlers = new Map<string, Array<(params: unknown) => void>>();

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sends.push({ method, params });
    return {};
  }

  on(event: string, callback: (params: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(callback);
    this.handlers.set(event, list);
  }

  emit(event: string, params: unknown): void {
    for (const callback of this.handlers.get(event) ?? []) {
      callback(params);
    }
  }

  sendsOf(method: string): Array<Record<string, unknown> | undefined> {
    return this.sends.filter((entry) => entry.method === method).map((entry) => entry.params);
  }
}

interface FakePageState {
  url: string;
  focusKind: FieldKind;
  focusValue: string;
  pageText: string;
  hasCodeField: boolean;
  cdp: FakeCdp | null;
  gotos: string[];
  closes: number;
  clicks: Array<{ x: number; y: number }>;
  typed: string[];
  pressed: string[];
}

interface FakePageBundle {
  page: PageLike;
  state: FakePageState;
}

function makeFakePage(init: Partial<FakePageState> & { withCdp?: boolean } = {}): FakePageBundle {
  const state: FakePageState = {
    url: "https://www.facebook.com/login",
    focusKind: null,
    focusValue: "",
    pageText: "",
    hasCodeField: false,
    cdp: init.withCdp === false ? null : new FakeCdp(),
    gotos: [],
    closes: 0,
    clicks: [],
    typed: [],
    pressed: [],
    ...init,
  };
  if (init.withCdp === false) {
    state.cdp = null;
  }
  const page: PageLike = {
    url: () => state.url,
    goto: async (url: string) => {
      state.gotos.push(url);
      state.url = url;
    },
    screenshot: async () => Buffer.from("fake-jpeg"),
    mouse: {
      click: async (x: number, y: number) => {
        state.clicks.push({ x, y });
      },
      wheel: async () => undefined,
    },
    keyboard: {
      type: async (text: string) => {
        state.typed.push(text);
      },
      press: async (key: string) => {
        state.pressed.push(key);
      },
    },
    evaluate: async (expression: string) => {
      if (expression.includes("relist-focus")) {
        return { kind: state.focusKind, value: state.focusValue };
      }
      if (expression.includes("relist-page-state")) {
        return { text: state.pageText, hasCodeField: state.hasCodeField };
      }
      if (expression.includes("isSellingPath")) {
        // The §6 ceremony's snapshot of the selling page: a ready,
        // empty Your Listings view.
        return {
          url: state.url,
          text: state.pageText,
          images: [],
          videos: [],
          surface: { kind: "selling_list", readiness: "ready" },
          sellingCards: [],
        };
      }
      if (expression.includes("relist-clear-field")) {
        state.focusValue = "";
        return true;
      }
      return { url: state.url, text: state.pageText, images: [], videos: [] };
    },
    viewportSize: () => ({ width: 1280, height: 800 }),
    close: async () => {
      state.closes += 1;
    },
  };
  if (state.cdp) {
    const cdp = state.cdp;
    page.cdp = async () => cdp;
  }
  return { page, state };
}

interface FakeBrowser {
  handle: BrowserHandle;
  auto: FakePageBundle;
  created: FakePageBundle[];
  cookies: Array<{ name: string; value?: string }>;
  triggerPopup(): FakePageBundle;
}

function makeFakeBrowser(): FakeBrowser {
  const auto = makeFakePage();
  const created: FakePageBundle[] = [];
  const pageCallbacks: Array<(page: PageLike) => void> = [];
  const fake: FakeBrowser = {
    auto,
    created,
    cookies: [],
    handle: undefined as unknown as BrowserHandle,
    triggerPopup() {
      const bundle = makeFakePage({ url: "https://www.facebook.com/checkpoint/popup" });
      created.push(bundle);
      for (const callback of pageCallbacks) {
        callback(bundle.page);
      }
      return bundle;
    },
  };
  const context: ContextLike = {
    cookies: async () => fake.cookies,
    clearCookies: async () => undefined,
    close: async () => undefined,
    pages: () => [auto.page, ...created.map((bundle) => bundle.page)],
    newPage: async () => {
      const bundle = makeFakePage({ url: "about:blank" });
      created.push(bundle);
      return bundle.page;
    },
    onPage: (callback) => {
      pageCallbacks.push(callback);
    },
  };
  fake.handle = { context, page: auto.page };
  return fake;
}

type Listener = (...args: never[]) => void;

class FakeSocket implements LoginSocketLike {
  readonly sent: Array<string | Buffer> = [];
  readyState = 1;
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly handlers = new Map<string, Listener[]>();

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  on(event: string, listener: Listener): void {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
  }

  receive(message: Record<string, unknown>): void {
    const data = Buffer.from(JSON.stringify(message));
    for (const listener of this.handlers.get("message") ?? []) {
      listener(data as never);
    }
  }

  emitClose(): void {
    this.readyState = 3;
    for (const listener of this.handlers.get("close") ?? []) {
      listener();
    }
  }

  json(): Array<Record<string, unknown>> {
    return this.sent
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }

  binary(): Buffer[] {
    return this.sent.filter((entry): entry is Buffer => Buffer.isBuffer(entry));
  }

  ofKind(kind: string): Array<Record<string, unknown>> {
    return this.json().filter((entry) => entry.kind === kind);
  }
}

async function flush(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ---------------------------------------------------------------- setup

let dataDir: string;
let store: Store;
let fake: FakeBrowser;
let browser: BrowserManager;
let registry: LoginSessionRegistry;
let userId: string;
let socket: FakeSocket;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "relist-login-"));
  store = new Store(dataDir);
  await store.load();
  const user = await store.createUser({ name: "A", email: "a@example.com", passwordHash: "x" });
  userId = user.id;
  fake = makeFakeBrowser();
  browser = new BrowserManager(store, dataDir, async () => fake.handle);
  registry = new LoginSessionRegistry(browser, { pollIntervalMs: 60_000 });
  socket = new FakeSocket();
});

afterEach(async () => {
  await registry.endAll().catch(() => undefined);
  await browser.closeAll().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
});

async function attach(): Promise<{ login: FakePageBundle; salt: string; sessionId: string }> {
  await registry.attach(userId, socket);
  const login = fake.created[0];
  const welcome = socket.ofKind("welcome")[0];
  return { login, salt: welcome.salt as string, sessionId: welcome.sessionId as string };
}

// ---------------------------------------------------------------- tests

describe("LoginSessionRegistry", () => {
  it("sends a welcome with sessionId and salt on attach", async () => {
    const { sessionId, salt } = await attach();
    expect(sessionId).toBeTruthy();
    expect(salt).toBeTruthy();
    expect(socket.ofKind("state")).toEqual([{ kind: "state", state: "streaming" }]);
    expect(browser.loginInProgress(userId)).toBe(true);
    expect(fake.created[0].state.gotos).toEqual(["https://www.facebook.com/login"]);
    // The automation page was never navigated or emulated.
    expect(fake.auto.state.gotos).toEqual([]);
    expect(fake.auto.state.cdp?.sends ?? []).toEqual([]);
  });

  it("starts the screencast with the frozen parameters", async () => {
    const { login } = await attach();
    expect(login.state.cdp?.sendsOf("Page.startScreencast")).toEqual([
      { format: "jpeg", quality: 55, maxWidth: 780, maxHeight: 1688, everyNthFrame: 1 },
    ]);
  });

  it("applies ops in seq order and acks carry only the seq", async () => {
    const { login } = await attach();
    socket.receive({ kind: "op", seq: 1, op: { type: "insert", text: "ada@" } });
    socket.receive({ kind: "op", seq: 2, op: { type: "insert", text: "example.com" } });
    socket.receive({ kind: "op", seq: 3, op: { type: "deleteBackward", count: 2 } });
    socket.receive({ kind: "op", seq: 4, op: { type: "key", key: "Enter" } });
    await flush();

    const cdp = login.state.cdp!;
    expect(cdp.sendsOf("Input.insertText")).toEqual([
      { text: "ada@" },
      { text: "example.com" },
    ]);
    const backspaces = cdp.sendsOf("Input.dispatchKeyEvent")
      .filter((params) => params?.key === "Backspace" && params?.type === "keyDown");
    expect(backspaces.length).toBe(2);
    expect(backspaces[0]).toMatchObject({ windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });

    const acks = socket.ofKind("ack");
    expect(acks).toEqual([
      { kind: "ack", seq: 1 },
      { kind: "ack", seq: 2 },
      { kind: "ack", seq: 3 },
      { kind: "ack", seq: 4 },
    ]);
    // Acks contain a seq number ONLY — never the typed text.
    expect(JSON.stringify(acks)).not.toContain("ada");
    expect(registry.appliedSeqOf(userId)).toBe(4);
    // Enter re-inspects focus and reports it.
    expect(socket.ofKind("focus").length).toBeGreaterThanOrEqual(1);
  });

  it("acks a duplicate seq without re-applying it", async () => {
    const { login } = await attach();
    socket.receive({ kind: "op", seq: 1, op: { type: "insert", text: "x" } });
    await flush();
    socket.receive({ kind: "op", seq: 1, op: { type: "insert", text: "x" } });
    await flush();
    expect(login.state.cdp?.sendsOf("Input.insertText")).toEqual([{ text: "x" }]);
    expect(socket.ofKind("ack")).toEqual([
      { kind: "ack", seq: 1 },
      { kind: "ack", seq: 1 },
    ]);
  });

  it("resync is intact when fingerprints match, and when both sides are empty", async () => {
    const { login, salt } = await attach();
    login.state.focusKind = "email";
    login.state.focusValue = "person@example.com";
    socket.receive({
      kind: "resync",
      lastAck: 0,
      fingerprint: computeFingerprint(salt, "person@example.com"),
    });
    await flush();
    expect(socket.ofKind("resync_result")).toEqual([
      { kind: "resync_result", verdict: "intact", appliedSeq: 0 },
    ]);

    login.state.focusValue = "";
    socket.receive({ kind: "resync", lastAck: 0, fingerprint: null });
    await flush();
    const results = socket.ofKind("resync_result");
    expect(results.length).toBe(2);
    expect(results[1]).toEqual({ kind: "resync_result", verdict: "intact", appliedSeq: 0 });
  });

  it("resync adopts the page value for a non-password mismatch", async () => {
    const { login, salt } = await attach();
    login.state.focusKind = "email";
    login.state.focusValue = "actual@page.example";
    socket.receive({
      kind: "resync",
      lastAck: 0,
      fingerprint: computeFingerprint(salt, "stale@client.example"),
    });
    await flush();
    expect(socket.ofKind("resync_result")).toEqual([
      { kind: "resync_result", verdict: "adopt", appliedSeq: 0, pageValue: "actual@page.example" },
    ]);
  });

  it("resync resets a password mismatch, clears the field, and leaks no value", async () => {
    const { login, salt } = await attach();
    login.state.focusKind = "password";
    login.state.focusValue = "hunter2-secret";
    socket.receive({
      kind: "resync",
      lastAck: 0,
      fingerprint: computeFingerprint(salt, "different-password"),
    });
    await flush();
    const results = socket.ofKind("resync_result");
    expect(results).toEqual([{ kind: "resync_result", verdict: "reset", appliedSeq: 0 }]);
    expect(JSON.stringify(results)).not.toContain("hunter2-secret");
    // The page field was cleared via select-all + Backspace key events.
    const keyEvents = login.state.cdp!.sendsOf("Input.dispatchKeyEvent");
    expect(keyEvents.some((params) => params?.key === "a" && params?.modifiers === 2)).toBe(true);
    expect(keyEvents.some((params) => params?.key === "Backspace")).toBe(true);
  });

  it("forwards screencast frames as binary and acks them to CDP", async () => {
    const { login } = await attach();
    const jpeg = Buffer.from("jpeg-frame-bytes");
    login.state.cdp!.emit("Page.screencastFrame", {
      data: jpeg.toString("base64"),
      sessionId: 77,
      metadata: {},
    });
    await flush();
    expect(socket.binary()).toEqual([jpeg]);
    expect(login.state.cdp?.sendsOf("Page.screencastFrameAck")).toEqual([{ sessionId: 77 }]);
  });

  it("locks input during a popup switch until the new page's first frame", async () => {
    const { login } = await attach();
    const popup = fake.triggerPopup();
    await flush();
    expect(browser.getLoginPage(userId)).toBe(popup.page);

    socket.receive({ kind: "op", seq: 1, op: { type: "insert", text: "after-popup" } });
    await flush();
    // Locked: neither the old nor the new page received the op yet.
    expect(login.state.cdp?.sendsOf("Input.insertText")).toEqual([]);
    expect(popup.state.cdp?.sendsOf("Input.insertText")).toEqual([]);
    expect(socket.ofKind("ack")).toEqual([]);

    popup.state.cdp!.emit("Page.screencastFrame", {
      data: Buffer.from("popup-frame").toString("base64"),
      sessionId: 5,
      metadata: {},
    });
    await flush();
    expect(popup.state.cdp?.sendsOf("Input.insertText")).toEqual([{ text: "after-popup" }]);
    expect(socket.ofKind("ack")).toEqual([{ kind: "ack", seq: 1 }]);
    expect(socket.binary()).toEqual([Buffer.from("popup-frame")]);
  });

  it("reports tap focus from the login page", async () => {
    const { login } = await attach();
    login.state.focusKind = "password";
    socket.receive({ kind: "tap", nx: 0.5, ny: 0.25 });
    await flush();
    const touches = login.state.cdp!.sendsOf("Input.dispatchTouchEvent");
    expect(touches[0]).toEqual({ type: "touchStart", touchPoints: [{ x: 195, y: 211, id: 1 }] });
    expect(touches[1]).toEqual({ type: "touchEnd", touchPoints: [] });
    expect(socket.ofKind("focus")).toEqual([{ kind: "focus", fieldKind: "password" }]);
  });

  it("sends hint changes only, for save-browser and push-2fa pages", async () => {
    const { login } = await attach();
    login.state.pageText = "Do you want to save this browser for next time?";
    await registry.pollOnce(userId);
    await registry.pollOnce(userId);
    expect(socket.ofKind("hint")).toEqual([{ kind: "hint", hint: "save_browser" }]);

    login.state.pageText = "Check your phone and approve the login to continue.";
    await registry.pollOnce(userId);
    expect(socket.ofKind("hint")).toEqual([
      { kind: "hint", hint: "save_browser" },
      { kind: "hint", hint: "push_2fa" },
    ]);
    // Status propagation rides the same poll.
    expect(socket.ofKind("status")).toEqual([{ kind: "status", status: "login_in_progress" }]);
  });

  it("reaches parked on a checkpoint review page and never times out or retries", async () => {
    const { login } = await attach();
    login.state.url = "https://www.facebook.com/checkpoint/123456";
    login.state.pageText = "We'll review your information. This usually takes about 24 hours.";
    for (let index = 0; index < 5; index += 1) {
      await registry.pollOnce(userId);
    }
    const states = socket.ofKind("state");
    expect(states).toEqual([
      { kind: "state", state: "streaming" },
      { kind: "state", state: "parked" },
    ]);
    // No timeout: the session and the login page are still alive, and
    // further polls change nothing (no retries, no duplicate states).
    expect(registry.hasSession(userId)).toBe(true);
    expect(browser.loginInProgress(userId)).toBe(true);
    expect(login.state.closes).toBe(0);
    await registry.pollOnce(userId);
    expect(socket.ofKind("state").length).toBe(2);
  });

  it("settles to connected after 3 consecutive connected polls and closes only the login page", async () => {
    const { login } = await attach();
    // The strict §6 ceremony requires BOTH session cookies; the cheap
    // signal alone (c_user) must never settle a login.
    fake.cookies = [
      { name: "c_user", value: "synthetic-facebook-user" },
      { name: "xs", value: "synthetic-session-secret" },
    ];
    fake.auto.state.url = "https://www.facebook.com/";

    await registry.pollOnce(userId);
    await registry.pollOnce(userId);
    expect(socket.ofKind("state")).toEqual([{ kind: "state", state: "streaming" }]);
    expect(registry.hasSession(userId)).toBe(true);

    await registry.pollOnce(userId);
    expect(socket.ofKind("state")).toEqual([
      { kind: "state", state: "streaming" },
      { kind: "state", state: "connected" },
    ]);
    expect(registry.hasSession(userId)).toBe(false);
    expect(browser.loginInProgress(userId)).toBe(false);
    expect(login.state.closes).toBe(1);
    // The browser profile/session itself is kept.
    expect(browser.hasActiveSession(userId)).toBe(true);
    expect(browser.statusOf(userId)).toBe("connected");
  });

  it("never settles when the session cookie is missing (the login did not persist)", async () => {
    // Regression for the owner's report: she finished the Facebook
    // login (the cheap signal — a c_user cookie — was present and the
    // old build flashed "Connected"), yet the session had not really
    // persisted and the app went back to "Connect Facebook" with no
    // explanation. Here xs never arrives: the ceremony must refuse to
    // settle, the honest "verifying" status must be reported, and no
    // "connected" state may ever be sent.
    await attach();
    fake.cookies = [{ name: "c_user", value: "synthetic-facebook-user" }];
    fake.auto.state.url = "https://www.facebook.com/";

    for (let index = 0; index < 5; index += 1) {
      await registry.pollOnce(userId);
    }
    expect(socket.ofKind("state")).toEqual([{ kind: "state", state: "streaming" }]);
    expect(socket.ofKind("status").map((entry) => entry.status)).toContain("verifying");
    // The session stays alive and keeps watching — no silent give-up.
    expect(registry.hasSession(userId)).toBe(true);
  });

  it("keeps the session alive across a socket close and reattaches with the same salt", async () => {
    const first = await attach();
    socket.receive({ kind: "op", seq: 1, op: { type: "insert", text: "keepme" } });
    await flush();
    socket.emitClose();

    const second = new FakeSocket();
    await registry.attach(userId, second);
    const welcome = second.ofKind("welcome")[0];
    expect(welcome.sessionId).toBe(first.sessionId);
    expect(welcome.salt).toBe(first.salt);
    expect(registry.appliedSeqOf(userId)).toBe(1);
    expect(registry.hasSession(userId)).toBe(true);
  });
});
