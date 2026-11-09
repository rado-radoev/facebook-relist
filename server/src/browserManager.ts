// Per-user browser sessions: one persistent Playwright Chromium profile per
// Relist account, stored under <DATA_DIR>/profiles/<userId>/. A session is
// the ONLY place a person's Facebook login lives — Facebook's own page sets
// its cookies in that profile; Relist never sees or stores the password.
//
// The launcher is injectable so tests can drive the manager with a fake
// browser instead of a real Chromium.

import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { WebSocket } from "ws";
import type { ProxyConfig } from "./config.js";
import {
  detectFacebookStatus,
  type FacebookStatus,
} from "./facebookStatus.js";
import { SNAPSHOT_SCRIPT, type PageSnapshot } from "./snapshot.js";
import { profileDirFor, type Store } from "./store.js";

export const FACEBOOK_LOGIN_URL = "https://www.facebook.com/login";
export const VIEWPORT = { width: 1280, height: 800 };

const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface PageLike {
  url(): string;
  goto(url: string): Promise<unknown>;
  screenshot(options?: { type?: "jpeg"; quality?: number }): Promise<Buffer>;
  mouse: {
    click(x: number, y: number): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  keyboard: {
    type(text: string): Promise<void>;
    press(key: string): Promise<void>;
  };
  evaluate(expression: string): Promise<unknown>;
  viewportSize(): { width: number; height: number } | null;
  /**
   * Sprint 3: attach files to a file input (photo/video upload in the
   * create flow). Optional: the real Playwright page provides it; test
   * fakes that never drive the create flow may omit it.
   */
  setInputFiles?(selector: string, files: string[]): Promise<void>;
}

export interface ContextLike {
  cookies(url: string): Promise<Array<{ name: string; value?: string }>>;
  clearCookies(): Promise<void>;
  close(): Promise<void>;
  pages(): PageLike[];
  newPage(): Promise<PageLike>;
}

export interface BrowserHandle {
  context: ContextLike;
  page: PageLike;
}

export type BrowserLauncher = (profileDir: string) => Promise<BrowserHandle>;

export type BrowserInput =
  | { type: "click"; nx: number; ny: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; dy: number };

export interface BrowserOptions {
  proxy?: ProxyConfig;
  ignoreCertErrors?: boolean;
}

function makeDefaultLauncher(options: BrowserOptions): BrowserLauncher {
  return async (profileDir: string): Promise<BrowserHandle> => {
    const { chromium } = await import("playwright");
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      viewport: VIEWPORT,
      userAgent: DESKTOP_USER_AGENT,
      proxy: options.proxy,
      ignoreHTTPSErrors: options.ignoreCertErrors ?? false,
    });
    const existing = context.pages()[0];
    const page = existing ?? (await context.newPage());
    page.setDefaultNavigationTimeout(60000);
    return {
      context: context as unknown as ContextLike,
      page: page as unknown as PageLike,
    };
  };
}

interface ActiveSession {
  handle: BrowserHandle;
  poller: NodeJS.Timeout;
}

interface PendingLaunch {
  promise: Promise<ActiveSession>;
  cancelled: boolean;
}

/** Clicks the edit wizard's "Next" button if it is present and enabled.
 *  The marker comment lets test fakes recognise this call. */
export const ADVANCE_WIZARD_SCRIPT = `/* relist-advance */ (() => {
  const candidates = document.querySelectorAll('[role="button"], button');
  for (const el of candidates) {
    const label = (el.textContent || "").trim();
    if (label !== "Next") {
      continue;
    }
    const disabled = el.getAttribute("aria-disabled") === "true" || Boolean(el.disabled);
    if (disabled) {
      return false;
    }
    el.click();
    return true;
  }
  return false;
})()`;

function coerceSnapshot(raw: unknown): PageSnapshot | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.url !== "string") {
    return null;
  }
  const snapshot = record as unknown as PageSnapshot;
  if (!Array.isArray(snapshot.images)) {
    snapshot.images = [];
  }
  if (!Array.isArray(snapshot.videos)) {
    snapshot.videos = [];
  }
  if (typeof snapshot.text !== "string") {
    snapshot.text = "";
  }
  return snapshot;
}

const POLL_INTERVAL_MS = 2000;

export class BrowserManager {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly pendingLaunches = new Map<string, PendingLaunch>();
  private readonly operationQueues = new Map<string, Promise<void>>();
  private readonly operationQueueCounts = new Map<string, number>();
  private readonly operationScope = new AsyncLocalStorage<string>();
  private readonly closingUsers = new Set<string>();
  private readonly disconnects = new Map<string, Promise<void>>();
  private readonly sensitiveUrlMarkers = ["/login", "checkpoint", "two_factor", "confirm_identity"];
  private readonly socketsByToken = new Map<string, Set<WebSocket>>();
  private readonly socketsByUser = new Map<string, Set<WebSocket>>();
  private shuttingDown = false;
  private readonly launcher: BrowserLauncher;
  private readonly unsubscribeRevocation: () => void;

  constructor(
    private readonly store: Store,
    private readonly dataDir: string,
    launcher?: BrowserLauncher,
    options: BrowserOptions = {},
  ) {
    this.launcher = launcher ?? makeDefaultLauncher(options);
    this.unsubscribeRevocation = this.store.onSessionRevoked((tokenHash) => {
      const sockets = this.socketsByToken.get(tokenHash);
      if (!sockets) return;
      for (const socket of sockets) {
        try {
          socket.close(4401, "Session expired or revoked");
        } catch {
          // A socket that is already closing needs no further action.
        }
      }
      this.socketsByToken.delete(tokenHash);
    });
  }

  /**
   * Run one complete per-user browser transaction in FIFO order. This is
   * intentionally non-reentrant: callers wrap sync/recovery/job work once
   * and invoke low-level browser methods directly inside the callback.
   * Lifecycle launch/cancellation is separate; disconnect rejects queued
   * work and waits for the current callback before closing its session.
   */
  withUserOperation<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    if (this.operationScope.getStore() === userId) {
      return Promise.reject(new Error("Browser user operations are non-reentrant"));
    }
    if (this.closingUsers.has(userId) || this.shuttingDown) {
      return Promise.reject(new Error("Browser session is closing"));
    }
    const count = this.operationQueueCounts.get(userId) ?? 0;
    if (count >= 64) {
      return Promise.reject(new Error("Browser operation queue is full"));
    }
    this.operationQueueCounts.set(userId, count + 1);
    const previous = this.operationQueues.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => turn);
    this.operationQueues.set(userId, tail);
    return previous.then(() => {
      if (this.closingUsers.has(userId) || this.shuttingDown) {
        throw new Error("Browser session is closing");
      }
      return this.operationScope.run(userId, operation);
    }).finally(() => {
      release();
      const remaining = (this.operationQueueCounts.get(userId) ?? 1) - 1;
      if (remaining === 0) this.operationQueueCounts.delete(userId);
      else this.operationQueueCounts.set(userId, remaining);
      if (this.operationQueues.get(userId) === tail) this.operationQueues.delete(userId);
    });
  }

  trackSocket(userId: string, tokenHash: string, socket: WebSocket): () => void {
    const tokenSockets = this.socketsByToken.get(tokenHash) ?? new Set<WebSocket>();
    tokenSockets.add(socket);
    this.socketsByToken.set(tokenHash, tokenSockets);
    const userSockets = this.socketsByUser.get(userId) ?? new Set<WebSocket>();
    userSockets.add(socket);
    this.socketsByUser.set(userId, userSockets);
    return () => {
      tokenSockets.delete(socket);
      userSockets.delete(socket);
      if (tokenSockets.size === 0) this.socketsByToken.delete(tokenHash);
      if (userSockets.size === 0) this.socketsByUser.delete(userId);
    };
  }

  private closeUserSockets(userId: string): void {
    for (const socket of this.socketsByUser.get(userId) ?? []) {
      try {
        socket.close(4401, "Facebook session disconnected");
      } catch {
        // A socket that is already closing needs no further action.
      }
    }
    this.socketsByUser.delete(userId);
  }

  hasActiveSession(userId: string): boolean {
    return this.sessions.has(userId);
  }

  statusOf(userId: string): FacebookStatus {
    const user = this.store.findUserById(userId);
    return user ? user.facebookStatus : "not_connected";
  }

  /** Open (or reuse) the user's persistent browser session without
   *  navigating anywhere. Used by login and by read-only scraping alike:
   *  the profile on disk is the session, so after a server restart the
   *  first scrape reopens it and refreshStatus re-derives the state. */
  async ensureSession(userId: string): Promise<ActiveSession> {
    if (this.closingUsers.has(userId) || this.shuttingDown) {
      throw new Error("Browser session is closing");
    }
    if (this.sessions.has(userId)) {
      return this.sessions.get(userId)!;
    }
    const existing = this.pendingLaunches.get(userId);
    if (existing) return existing.promise;

    const pending: PendingLaunch = { promise: Promise.resolve(undefined as never), cancelled: false };
    const promise = (async () => {
      const profileDir = profileDirFor(this.dataDir, userId);
      await mkdir(profileDir, { recursive: true, mode: 0o700 });
      await chmod(profileDir, 0o700);
      const handle = await this.launcher(profileDir);
      if (pending.cancelled || this.shuttingDown) {
        await handle.context.close().catch(() => undefined);
        throw new Error("Browser launch was cancelled");
      }
      const profileStat = await stat(profileDir);
      if ((profileStat.mode & 0o777) !== 0o700) await chmod(profileDir, 0o700);
      const poller = setInterval(() => {
        if ((this.operationQueueCounts.get(userId) ?? 0) > 0) return;
        void this.withUserOperation(userId, () => this.refreshStatus(userId)).catch(() => undefined);
      }, POLL_INTERVAL_MS);
      poller.unref();
      const session = { handle, poller };
      this.sessions.set(userId, session);
      return session;
    })();
    pending.promise = promise;
    this.pendingLaunches.set(userId, pending);
    try {
      return await promise;
    } finally {
      if (this.pendingLaunches.get(userId) === pending) this.pendingLaunches.delete(userId);
    }
  }

  async startLogin(userId: string): Promise<FacebookStatus> {
    return this.withUserOperation(userId, () => this.startLoginUnsafe(userId));
  }

  private async startLoginUnsafe(userId: string): Promise<FacebookStatus> {
    const session = await this.ensureSession(userId);
    await this.store.setFacebookStatus(userId, "login_in_progress");
    try {
      await session.handle.page.goto(FACEBOOK_LOGIN_URL);
    } catch {
      // Navigation hiccups leave the page wherever it is; polling tracks status.
    }
    await this.refreshStatus(userId);
    const status = this.statusOf(userId);
    return status;
  }

  async refreshStatus(userId: string): Promise<FacebookStatus> {
    const session = this.sessions.get(userId);
    if (!session) {
      return this.statusOf(userId);
    }
    const cookies = await session.handle.context.cookies("https://www.facebook.com");
    const userCookie = cookies.find((cookie) => cookie.name === "c_user");
    const hasUserCookie = Boolean(userCookie);
    const next = detectFacebookStatus({
      hasUserCookie,
      url: session.handle.page.url(),
      previousStatus: this.statusOf(userId),
    });
    if (next !== this.statusOf(userId)) {
      await this.store.setFacebookStatus(userId, next);
    }
    if (next === "connected" && userCookie?.value) {
      const previousIdentity = this.store.getFacebookIdentityHash(userId);
      const identityChanged = await this.store.setFacebookIdentity(userId, userCookie.value);
      if (identityChanged) {
        await rm(path.join(this.dataDir, "archive", userId), { recursive: true, force: true });
        if (previousIdentity) {
          await this.store.setFacebookStatus(userId, "needs_check");
          return "needs_check";
        }
      }
    }
    return next;
  }

  async screenshot(userId: string): Promise<Buffer | null> {
    const session = this.sessions.get(userId);
    if (!session) {
      return null;
    }
    try {
      return await session.handle.page.screenshot({ type: "jpeg", quality: 55 });
    } catch {
      return null;
    }
  }

  /**
   * Read-only page collection for Sprint 2 scraping: navigate the user's
   * own browser to a Facebook page and return its snapshot. This never
   * clicks, types, or submits anything on Facebook.
   */
  async collectSnapshotAt(userId: string, url: string): Promise<PageSnapshot | null> {
    const session = await this.ensureSession(userId);
    try {
      await session.handle.page.goto(url);
    } catch {
      return null;
    }
    return this.collectCurrentSnapshot(userId);
  }

  /** Snapshot of wherever the user's browser currently is. */
  async collectCurrentSnapshot(userId: string): Promise<PageSnapshot | null> {
    const session = this.sessions.get(userId);
    if (!session) {
      return null;
    }
    const page = session.handle.page;
    try {
      // Let the React app settle before reading it.
      await page.evaluate("new Promise((resolve) => setTimeout(resolve, 1200))");
    } catch {
      // A page mid-navigation can reject the wait; read it anyway.
    }
    try {
      const raw = await page.evaluate(SNAPSHOT_SCRIPT);
      const snapshot = coerceSnapshot(raw);
      if (snapshot && this.sensitiveUrlMarkers.some((marker) => page.url().toLowerCase().includes(marker))) {
        snapshot.form = undefined;
      }
      return snapshot;
    } catch {
      return null;
    }
  }

  /**
   * Advance the edit-listing wizard from Step 1 to Step 2 by clicking its
   * "Next" button — navigation inside the form, NOT a save: this never
   * clicks Publish/Save/Update and changes nothing on Facebook. Needed
   * because Step 2 (location/delivery) only exists after Step 1.
   */
  async advanceWizard(userId: string): Promise<boolean> {
    const session = this.sessions.get(userId);
    if (!session) {
      return false;
    }
    try {
      const result = await session.handle.page.evaluate(ADVANCE_WIZARD_SCRIPT);
      return result === true;
    } catch {
      return false;
    }
  }

  /**
   * Sprint 3: run a script in the user's current page (the create/delete
   * flows are driven this way, in the same marker-script style as
   * ADVANCE_WIZARD_SCRIPT). Returns null when the page rejects it.
   */
  async runScript(userId: string, script: string): Promise<unknown> {
    const session = await this.ensureSession(userId);
    try {
      return await session.handle.page.evaluate(script);
    } catch {
      return null;
    }
  }

  /** Sprint 3: attach files to a file input on the user's current page. */
  async uploadFiles(userId: string, selector: string, files: string[]): Promise<boolean> {
    const session = await this.ensureSession(userId);
    const page = session.handle.page;
    if (!page.setInputFiles) {
      return false;
    }
    try {
      await page.setInputFiles(selector, files);
      return true;
    } catch {
      return false;
    }
  }

  async sendInput(userId: string, input: BrowserInput): Promise<boolean> {
    const session = this.sessions.get(userId);
    if (!session) {
      return false;
    }
    const page = session.handle.page;
    if (input.type === "click") {
      const viewport = page.viewportSize() ?? VIEWPORT;
      const x = Math.min(Math.max(input.nx, 0), 1) * viewport.width;
      const y = Math.min(Math.max(input.ny, 0), 1) * viewport.height;
      await page.mouse.click(x, y);
      return true;
    }
    if (input.type === "type") {
      if (input.text.length > 0) {
        await page.keyboard.type(input.text);
      }
      return true;
    }
    if (input.type === "key") {
      await page.keyboard.press(input.key);
      return true;
    }
    await page.mouse.wheel(0, input.dy);
    return true;
  }

  private async closeSession(userId: string): Promise<void> {
    this.closingUsers.add(userId);
    this.closeUserSockets(userId);
    const pending = this.pendingLaunches.get(userId);
    if (pending) {
      pending.cancelled = true;
      this.pendingLaunches.delete(userId);
    }
    await pending?.promise.catch(() => undefined);
    await this.operationQueues.get(userId)?.catch(() => undefined);
    const session = this.sessions.get(userId);
    if (session) {
      clearInterval(session.poller);
      this.sessions.delete(userId);
      await session.handle.context.close().catch(() => undefined);
    }
  }

  async disconnect(userId: string): Promise<void> {
    const isNestedOperation = this.operationScope.getStore() === userId;
    if (isNestedOperation) {
      throw new Error("Disconnect cannot run inside a browser user operation");
    }
    const existing = this.disconnects.get(userId);
    if (existing) return existing;
    this.closingUsers.add(userId);
    const disconnect = (async () => {
      await this.closeSession(userId);
      await rm(profileDirFor(this.dataDir, userId), { recursive: true, force: true });
      await this.store.setFacebookStatus(userId, "not_connected");
    })().finally(() => {
      this.closingUsers.delete(userId);
      if (this.disconnects.get(userId) === disconnect) this.disconnects.delete(userId);
    });
    this.disconnects.set(userId, disconnect);
    return disconnect;
  }

  async closeAll(): Promise<void> {
    this.shuttingDown = true;
    this.unsubscribeRevocation();
    const userIds = [...new Set([
      ...this.sessions.keys(),
      ...this.operationQueues.keys(),
      ...this.pendingLaunches.keys(),
      ...this.disconnects.keys(),
    ])];
    for (const userId of userIds) this.closingUsers.add(userId);
    await Promise.all(userIds.map((userId) => this.disconnects.get(userId) ?? this.closeSession(userId)));
    for (const sockets of this.socketsByUser.values()) {
      for (const socket of sockets) socket.close(1001, "Server shutting down");
    }
    this.socketsByUser.clear();
    this.socketsByToken.clear();
  }
}
