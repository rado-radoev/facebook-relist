// Per-user browser sessions: one persistent Playwright Chromium profile per
// Relist account, stored under <DATA_DIR>/profiles/<userId>/. A session is
// the ONLY place a person's Facebook login lives — Facebook's own page sets
// its cookies in that profile; Relist never sees or stores the password.
//
// The launcher is injectable so tests can drive the manager with a fake
// browser instead of a real Chromium.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WebSocket } from "ws";
import type { ProxyConfig } from "./config.js";
import {
  detectFacebookStatus,
  urlNeedsCheck,
  type FacebookStatus,
} from "./facebookStatus.js";
import { SELLING_LIST_URL, SNAPSHOT_SCRIPT, type PageSnapshot } from "./snapshot.js";
import { profileDirFor, type Store } from "./store.js";

export const FACEBOOK_LOGIN_URL = "https://www.facebook.com/login";
export const VIEWPORT = { width: 1280, height: 800 };
/** Emulated viewport of the dedicated Connect login page (phone-sized).
 *  The automation page keeps VIEWPORT; only the login page is emulated. */
export const LOGIN_VIEWPORT = { width: 390, height: 844 };

/**
 * Minimal CDP (Chrome DevTools Protocol) session shape. Optional on
 * PageLike: the real Playwright page provides it via
 * context.newCDPSession(page); test fakes may omit it, in which case the
 * login session falls back to the page's keyboard/mouse.
 */
export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, callback: (params: unknown) => void): void;
  off?(event: string, callback: (params: unknown) => void): void;
  detach?(): Promise<void>;
}

/**
 * The ONE user agent for every launch of a Relist profile — login view
 * and automation alike. Identity discipline (research blueprint §6):
 * a UA/fingerprint divergence between login and checking is a proven
 * session-killer (a `HeadlessChrome` UA made the `c_user` cookie vanish
 * from a correctly reused profile), so this is a real desktop Chrome UA
 * with no "HeadlessChrome" marker, and nothing anywhere in the login
 * flow may override it.
 */
export const RELIST_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PROFILE_LOCK_PATTERN = /already in use|singleton|profile.*lock/i;

/** True when an error looks like a persistent-profile lock failure —
 *  another (or a crashed) browser still holding the userDataDir. */
export function isProfileLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return PROFILE_LOCK_PATTERN.test(message);
}

/**
 * A launch failed because the persistent profile is locked/in use.
 * Callers must be able to distinguish this from "not connected": the
 * session may be perfectly valid, the profile is simply busy.
 */
export class ProfileBusyError extends Error {
  constructor(message = "Browser profile is already in use", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProfileBusyError";
  }
}

/**
 * The launchPersistentContext options for a Relist profile. Pure and
 * exported so a test can assert the identity discipline (above all the
 * UA) without launching a real Chromium.
 */
export function buildLaunchOptions(options: BrowserOptions): {
  headless: boolean;
  viewport: typeof VIEWPORT;
  userAgent: string;
  proxy: ProxyConfig | undefined;
  ignoreHTTPSErrors: boolean;
} {
  return {
    headless: true,
    viewport: VIEWPORT,
    userAgent: RELIST_USER_AGENT,
    proxy: options.proxy,
    ignoreHTTPSErrors: options.ignoreCertErrors ?? false,
  };
}

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
  /** Close this page. Optional: only the login-page lifecycle needs it;
   *  test fakes that never open a login page may omit it. */
  close?(): Promise<void>;
  /**
   * CDP access for the Connect login session (screencast + Input domain
   * on the login page only). Optional: test fakes may omit it.
   */
  cdp?(): Promise<CdpSessionLike>;
}

export interface ContextLike {
  cookies(url: string): Promise<Array<{ name: string; value?: string; expires?: number }>>;
  clearCookies(): Promise<void>;
  close(): Promise<void>;
  pages(): PageLike[];
  newPage(): Promise<PageLike>;
  /**
   * Subscribe to new pages (tabs/popups) opening in this context.
   * Optional: the real Playwright context provides it via
   * context.on("page"); test fakes may omit it.
   */
  onPage?(callback: (page: PageLike) => void): void;
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

/**
 * Disable Chromium's built-in password manager for a profile BEFORE it
 * launches, by merge-writing <profileDir>/Default/Preferences. The login
 * session types credentials into Facebook's own page via CDP; Chromium's
 * "Save password?" bubble would cover that page, and saving the Facebook
 * password into the profile is never wanted. Existing Preferences content
 * is merged, never clobbered; a missing or corrupt file is tolerated.
 */
export async function disableChromiumPasswordManager(profileDir: string): Promise<void> {
  const defaultDir = path.join(profileDir, "Default");
  const preferencesPath = path.join(defaultDir, "Preferences");
  let preferences: Record<string, unknown> = {};
  try {
    const raw = await readFile(preferencesPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      preferences = parsed as Record<string, unknown>;
    }
  } catch {
    // Absent or corrupt Preferences: start from an empty object.
    preferences = {};
  }
  preferences.credentials_enable_service = false;
  const profile = (
    typeof preferences.profile === "object" &&
    preferences.profile !== null &&
    !Array.isArray(preferences.profile)
  )
    ? (preferences.profile as Record<string, unknown>)
    : {};
  profile.password_manager_enabled = false;
  preferences.profile = profile;
  try {
    await mkdir(defaultDir, { recursive: true });
    await writeFile(preferencesPath, JSON.stringify(preferences), "utf8");
  } catch {
    // A profile that cannot take the write still launches; the login
    // page simply keeps the default password-manager behaviour.
  }
}

type RawPage = {
  url(): string;
  goto(url: string): Promise<unknown>;
  screenshot(options?: { type?: "jpeg"; quality?: number }): Promise<Buffer>;
  mouse: PageLike["mouse"];
  keyboard: PageLike["keyboard"];
  evaluate(expression: string): Promise<unknown>;
  viewportSize(): { width: number; height: number } | null;
  setInputFiles?(selector: string, files: string[]): Promise<void>;
  close(): Promise<void>;
  setDefaultNavigationTimeout(timeout: number): void;
};

type RawContext = {
  cookies(url: string): Promise<Array<{ name: string; value?: string; expires?: number }>>;
  clearCookies(): Promise<void>;
  close(): Promise<void>;
  pages(): RawPage[];
  newPage(): Promise<RawPage>;
  newCDPSession(page: RawPage): Promise<{
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;
    on(event: string, callback: (params: never) => void): void;
    off?(event: string, callback: (params: never) => void): void;
    removeListener?(event: string, callback: (params: never) => void): void;
    detach(): Promise<void>;
  }>;
  on(event: "page", callback: (page: RawPage) => void): void;
};

function wrapCdpSession(raw: Awaited<ReturnType<RawContext["newCDPSession"]>>): CdpSessionLike {
  return {
    send: (method, params) => raw.send(method, params),
    on: (event, callback) => {
      raw.on(event, callback as (params: never) => void);
    },
    off: (event, callback) => {
      if (raw.off) {
        raw.off(event, callback as (params: never) => void);
      } else if (raw.removeListener) {
        raw.removeListener(event, callback as (params: never) => void);
      }
    },
    detach: () => raw.detach(),
  };
}

/** Wrap one raw Playwright page in the PageLike shape (with CDP access).
 *  The same wrapper serves the automation page, the login page, and any
 *  popup page delivered by ContextLike.onPage. */
function makePageWrapper(rawContext: RawContext): (rawPage: RawPage) => PageLike {
  const cache = new WeakMap<object, PageLike>();
  const wrapPage = (rawPage: RawPage): PageLike => {
    const cached = cache.get(rawPage);
    if (cached) {
      return cached;
    }
    let cdpPromise: Promise<CdpSessionLike> | undefined;
    const wrapped: PageLike = {
      url: () => rawPage.url(),
      goto: (url) => rawPage.goto(url),
      screenshot: (options) => rawPage.screenshot(options),
      mouse: rawPage.mouse,
      keyboard: rawPage.keyboard,
      evaluate: (expression) => rawPage.evaluate(expression),
      viewportSize: () => rawPage.viewportSize(),
      close: () => rawPage.close(),
      cdp: () => {
        cdpPromise ??= rawContext.newCDPSession(rawPage).then(wrapCdpSession);
        return cdpPromise;
      },
    };
    if (typeof rawPage.setInputFiles === "function") {
      wrapped.setInputFiles = (selector, files) => rawPage.setInputFiles!(selector, files);
    }
    cache.set(rawPage, wrapped);
    return wrapped;
  };
  return wrapPage;
}

function wrapContext(rawContext: RawContext): { context: ContextLike; wrapPage: (rawPage: RawPage) => PageLike } {
  const wrapPage = makePageWrapper(rawContext);
  const context: ContextLike = {
    cookies: (url) => rawContext.cookies(url),
    clearCookies: () => rawContext.clearCookies(),
    close: () => rawContext.close(),
    pages: () => rawContext.pages().map(wrapPage),
    newPage: async () => wrapPage(await rawContext.newPage()),
    onPage: (callback) => {
      rawContext.on("page", (rawPage) => callback(wrapPage(rawPage)));
    },
  };
  return { context, wrapPage };
}

function makeDefaultLauncher(options: BrowserOptions): BrowserLauncher {
  return async (profileDir: string): Promise<BrowserHandle> => {
    // The password manager must be off before Chromium reads the profile.
    await disableChromiumPasswordManager(profileDir);
    const { chromium } = await import("playwright");
    const rawContext = await chromium.launchPersistentContext(
      profileDir,
      buildLaunchOptions(options),
    ) as unknown as RawContext;
    const { context, wrapPage } = wrapContext(rawContext);
    const existing = rawContext.pages()[0];
    const rawPage = existing ?? (await rawContext.newPage());
    rawPage.setDefaultNavigationTimeout(60000);
    return {
      context,
      page: wrapPage(rawPage),
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
  /** Dedicated Connect login page per user, inside the same persistent
   *  context as the automation page (so its cookies ARE the session) but
   *  never the automation page itself. Presence in this map is what
   *  blocks automation: while a person is logging in, nothing else may
   *  drive their browser. */
  private readonly loginPages = new Map<string, PageLike>();
  private readonly pendingLaunches = new Map<string, PendingLaunch>();
  private readonly operationQueues = new Map<string, Promise<void>>();
  private readonly operationQueueCounts = new Map<string, number>();
  private readonly operationScope = new AsyncLocalStorage<string>();
  private readonly closingUsers = new Set<string>();
  private readonly disconnects = new Map<string, Promise<void>>();
  private readonly sensitiveUrlMarkers = ["/login", "checkpoint", "two_factor", "confirm_identity"];
  private readonly socketsByToken = new Map<string, Set<WebSocket>>();
  private readonly socketsByUser = new Map<string, Set<WebSocket>>();
  /** Profile dir recorded at launch time, per user. The login flow and
   *  every worker entry point share ensureSession, so the dir recorded
   *  here is the ONE profile that serves both — see profileIdFor. */
  private readonly activeProfileIds = new Map<string, string>();
  /** Users whose strict §6 Connected ceremony (verifyConnected) has
   *  passed in THIS browser session. Cleared whenever the session
   *  closes, is disconnected, or is restarted for re-verification, so a
   *  cached "connected" can never outlive the context that proved it. */
  private readonly verifiedUsers = new Set<string>();
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

  /** The persistent profile dir for this user — the profileId logged /
   *  asserted by both the login path and every worker entry point.
   *  Deterministic in (dataDir, userId): there is exactly one profile
   *  per user, and ensureSession launches with exactly this dir. */
  profileIdFor(userId: string): string {
    return profileDirFor(this.dataDir, userId);
  }

  /** The profileId of the user's live (or launching) session, recorded
   *  by ensureSession at launch time; null when no session is active. */
  activeProfileId(userId: string): string | null {
    return this.activeProfileIds.get(userId) ?? null;
  }

  /**
   * True when the user's profile cannot be opened right now for a
   * transient reason: the user is closing/disconnecting, or a launch is
   * pending with no live session behind it (a launch that fails with a
   * profile-lock error is surfaced as ProfileBusyError instead). A busy
   * profile is NOT evidence of "not connected" (§6.6).
   */
  profileBusy(userId: string): boolean {
    if (this.closingUsers.has(userId)) {
      return true;
    }
    return this.pendingLaunches.has(userId) && !this.sessions.has(userId);
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
      // By construction, the launched profile IS profileIdFor(userId) —
      // the same dir the login path and every worker entry share — and
      // it is recorded before the launch so activeProfileId reflects
      // the in-flight launch as well as the live session.
      const profileDir = this.profileIdFor(userId);
      this.activeProfileIds.set(userId, profileDir);
      await mkdir(profileDir, { recursive: true, mode: 0o700 });
      await chmod(profileDir, 0o700);
      let handle: BrowserHandle;
      try {
        handle = await this.launcher(profileDir);
      } catch (error) {
        if (this.activeProfileIds.get(userId) === profileDir && !this.sessions.has(userId)) {
          this.activeProfileIds.delete(userId);
        }
        if (isProfileLockError(error)) {
          // A locked profile is "busy", never "not connected": annotate
          // the failure so callers can tell the two apart.
          throw new ProfileBusyError(
            error instanceof Error ? error.message : "Browser profile is already in use",
            { cause: error },
          );
        }
        throw error;
      }
      if (pending.cancelled || this.shuttingDown) {
        if (this.activeProfileIds.get(userId) === profileDir && !this.sessions.has(userId)) {
          this.activeProfileIds.delete(userId);
        }
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
      if (this.profileBusy(userId)) {
        // Transient, never persisted: a busy profile must not overwrite
        // the stored status, and must not be read as not_connected.
        return "profile_busy";
      }
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
    if (next !== "connected") {
      // A cheap check that no longer sees a session invalidates any
      // earlier strict verification in this browser session.
      this.verifiedUsers.delete(userId);
    }
    if (next === "connected" && userCookie?.value) {
      const previousIdentity = this.store.getFacebookIdentityHash(userId);
      const identityChanged = await this.store.setFacebookIdentity(userId, userCookie.value);
      if (identityChanged) {
        await rm(path.join(this.dataDir, "archive", userId), { recursive: true, force: true });
        if (previousIdentity) {
          this.verifiedUsers.delete(userId);
          await this.store.setFacebookStatus(userId, "needs_check");
          return "needs_check";
        }
      }
    }
    return next;
  }

  /**
   * One pass of the §6 checks against the CURRENT context (no restart):
   * cookies, selling-page URL, hydration, and stored identity. Returns
   * "connected" only as a candidate — verifyConnected still owes the
   * flush + re-open pass before anything may be reported connected.
   * `previousStatus` is the stored status captured by the caller before
   * this ceremony began, so a mid-ceremony write cannot rewrite the
   * "was it connected / was a login in progress" history.
   */
  private async verifyPass(
    userId: string,
    previousStatus: FacebookStatus,
  ): Promise<{ status: FacebookStatus; cUser: string | null }> {
    const session = this.sessions.get(userId);
    if (!session) {
      return { status: "verifying", cUser: null };
    }
    let cookies: Array<{ name: string; value?: string; expires?: number }>;
    try {
      cookies = await session.handle.context.cookies("https://www.facebook.com");
    } catch {
      return { status: "verifying", cUser: null };
    }
    const nowSeconds = Date.now() / 1000;
    const unexpired = (cookie?: { expires?: number }): boolean =>
      Boolean(cookie) &&
      (cookie!.expires === undefined || cookie!.expires === -1 || cookie!.expires > nowSeconds);
    const userCookie = cookies.find((cookie) => cookie.name === "c_user");
    const sessionCookie = cookies.find((cookie) => cookie.name === "xs");
    if (!unexpired(userCookie) || !unexpired(sessionCookie)) {
      if (previousStatus === "connected") {
        return { status: "expired", cUser: userCookie?.value ?? null };
      }
      if (previousStatus === "login_in_progress" || previousStatus === "verifying") {
        return { status: "verifying", cUser: userCookie?.value ?? null };
      }
      return { status: "not_connected", cUser: userCookie?.value ?? null };
    }
    const cUser = userCookie?.value ?? null;
    if (!cUser) {
      return { status: "verifying", cUser: null };
    }
    // Identity against the store's record, with the same semantics as
    // refreshStatus: a c_user that hashes differently from the identity
    // on record is a different account until a human confirms it.
    let storedIdentityHash: string | null = null;
    try {
      storedIdentityHash = this.store.getFacebookIdentityHash(userId);
    } catch {
      storedIdentityHash = null;
    }
    if (storedIdentityHash) {
      const candidateHash = createHash("sha256").update(cUser).digest("hex");
      if (candidateHash !== storedIdentityHash) {
        return { status: "needs_check", cUser };
      }
    }
    const snapshot = await this.collectSnapshotAt(userId, SELLING_LIST_URL);
    if (!snapshot) {
      return { status: "verifying", cUser };
    }
    const currentSession = this.sessions.get(userId);
    const finalUrl = currentSession ? currentSession.handle.page.url() : snapshot.url;
    if (urlNeedsCheck(finalUrl) || /consent/i.test(finalUrl)) {
      return { status: "needs_check", cUser };
    }
    if (finalUrl.toLowerCase().includes("/login")) {
      return {
        status: previousStatus === "connected" ? "expired" : "login_in_progress",
        cUser,
      };
    }
    if (snapshot.surface?.kind !== "selling_list" || snapshot.surface?.readiness !== "ready") {
      return { status: "verifying", cUser };
    }
    return { status: "connected", cUser };
  }

  /**
   * Flush + re-open: close the current context and launch a fresh one
   * from the SAME userDataDir. Deliberately NOT built on disconnect /
   * withUserOperation — it must be safe to call from inside a user
   * operation (the status route) without deadlocking on the queue it
   * is already holding, and it never deletes the profile.
   */
  private async restartContext(userId: string): Promise<void> {
    this.verifiedUsers.delete(userId);
    const session = this.sessions.get(userId);
    if (session) {
      clearInterval(session.poller);
      this.sessions.delete(userId);
      await session.handle.context.close().catch(() => undefined);
    }
    await this.ensureSession(userId);
  }

  /**
   * The strict §6 Connected ceremony — ONE pass. (Polling comes from
   * repeated calls by the login poller and the status route; a single
   * call never loops.) "connected" is returned only when every check
   * passes in the worker's own context AND again after the context is
   * flushed and re-opened from the same profile with the same identity.
   */
  async verifyConnected(userId: string): Promise<FacebookStatus> {
    if (this.loginPages.has(userId)) {
      // Never navigate (or restart) mid-login: the cheap status of the
      // context the person is logging into is the only honest answer.
      return this.refreshStatus(userId);
    }
    if (this.profileBusy(userId)) {
      return "profile_busy";
    }
    const previousStatus = this.statusOf(userId);
    try {
      await this.ensureSession(userId);
    } catch (error) {
      if (error instanceof ProfileBusyError || isProfileLockError(error)) {
        return "profile_busy";
      }
      return "verifying";
    }
    const first = await this.verifyPass(userId, previousStatus);
    if (first.status !== "connected") {
      return first.status;
    }
    try {
      await this.restartContext(userId);
    } catch (error) {
      if (error instanceof ProfileBusyError || isProfileLockError(error)) {
        return "profile_busy";
      }
      return "verifying";
    }
    const second = await this.verifyPass(userId, previousStatus);
    if (second.status !== "connected") {
      // A shortfall in the re-open pass is "verifying", unless that
      // pass produced a more specific state worth surfacing as-is.
      if (
        second.status === "needs_check" ||
        second.status === "login_in_progress" ||
        second.status === "expired" ||
        second.status === "profile_busy"
      ) {
        return second.status;
      }
      return "verifying";
    }
    if (first.cUser !== second.cUser) {
      // The account changed across the restart: not the session that
      // was just verified.
      return "needs_check";
    }
    try {
      const storedIdentityHash = this.store.getFacebookIdentityHash(userId);
      if (second.cUser && !storedIdentityHash) {
        await this.store.setFacebookIdentity(userId, second.cUser);
      }
    } catch {
      // Identity bookkeeping must not veto a ceremony that passed.
    }
    await this.store.setFacebookStatus(userId, "connected");
    this.verifiedUsers.add(userId);
    return "connected";
  }

  /**
   * The client-facing status: the cheap refreshStatus, upgraded to the
   * strict ceremony whenever it claims "connected". refreshStatus's
   * stored behaviour is unchanged (baseline callers depend on it), but
   * no client may be told "connected" on the cheap signal alone —
   * unless this browser session has already verified the user, in
   * which case the ceremony is not re-run.
   */
  async reportedStatus(userId: string): Promise<FacebookStatus> {
    const cheap = await this.refreshStatus(userId);
    if (cheap !== "connected") {
      return cheap;
    }
    if (this.verifiedUsers.has(userId)) {
      return "connected";
    }
    return this.verifyConnected(userId);
  }

  /** True while a dedicated Connect login page is open for this user. */
  loginInProgress(userId: string): boolean {
    return this.loginPages.has(userId);
  }

  /** The user's dedicated login page, or null when none is open. */
  getLoginPage(userId: string): PageLike | null {
    return this.loginPages.get(userId) ?? null;
  }

  /** Apply the login page's per-target emulation via CDP. The login page
   *  is a separate target, so this never resizes the automation page.
   *
   *  Identity discipline: the login page is phone-sized for readability
   *  ONLY — viewport metrics + touch are emulated here, and the user
   *  agent is NEVER overridden (no CDP user-agent override anywhere):
   *  identity signals (UA etc.) stay identical to the
   *  automation context's, because UA divergence between login and
   *  checking is the proven session-killer (§6.2). The viewport
   *  difference is an accepted, documented risk; the UA difference is
   *  not. */
  private async applyLoginEmulation(page: PageLike): Promise<void> {
    if (!page.cdp) {
      return;
    }
    try {
      const cdp = await page.cdp();
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: LOGIN_VIEWPORT.width,
        height: LOGIN_VIEWPORT.height,
        deviceScaleFactor: 2,
        mobile: false,
        screenWidth: LOGIN_VIEWPORT.width,
        screenHeight: LOGIN_VIEWPORT.height,
      });
      await cdp.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 5,
      });
    } catch {
      // Emulation is best-effort: a page without CDP still shows the
      // login form, just at the context's default size.
    }
  }

  /**
   * Remember a page as the user's login page and apply its emulation.
   * Used by openLoginPage and by the login session when Facebook opens
   * the flow in a popup page (the popup becomes the login page; it is
   * NOT navigated — it already carries its own URL).
   *
   * A page that IS the automation page is never registered (and never
   * emulated): a dedicated login target must be a distinct page. A
   * launcher whose newPage() hands back the automation page itself has
   * no separate target to protect — registering it would block the
   * user's own automation for as long as the "login page" exists,
   * which is forever, since closing it would close the automation page.
   */
  async setLoginPage(userId: string, page: PageLike): Promise<void> {
    const automationPage = this.sessions.get(userId)?.handle.page;
    if (automationPage && page === automationPage) {
      return;
    }
    this.loginPages.set(userId, page);
    await this.applyLoginEmulation(page);
  }

  /**
   * Open the dedicated Connect login page: a NEW page in the user's
   * existing persistent context, emulated phone-sized, navigated to
   * Facebook's login page. The automation page (handle.page) is never
   * resized or reused here. Reuses the open login page if there is one.
   */
  async openLoginPage(userId: string): Promise<PageLike> {
    const existing = this.loginPages.get(userId);
    if (existing) {
      return existing;
    }
    const session = await this.ensureSession(userId);
    const page = await session.handle.context.newPage();
    await this.setLoginPage(userId, page);
    await this.store.setFacebookStatus(userId, "login_in_progress");
    try {
      await page.goto(FACEBOOK_LOGIN_URL);
    } catch {
      // Navigation hiccups leave the page wherever it is; the login
      // session's polling tracks what Facebook actually shows.
    }
    return page;
  }

  /** Close and forget the user's dedicated login page, if any. The
   *  persistent context (and its Facebook session cookies) stays. */
  async closeLoginPage(userId: string): Promise<void> {
    const page = this.loginPages.get(userId);
    this.loginPages.delete(userId);
    if (page?.close) {
      await page.close().catch(() => undefined);
    }
  }

  /** Subscribe to new pages opening in the user's context (popups). */
  async onNewPage(userId: string, callback: (page: PageLike) => void): Promise<void> {
    const session = await this.ensureSession(userId);
    session.handle.context.onPage?.(callback);
  }

  /**
   * Automation may only run when no login page is open for the user and
   * the automation page is still at the automation VIEWPORT. The
   * login-page check is the enforceable part with test fakes (their
   * pages always report VIEWPORT); the viewport check additionally
   * catches a real automation page that somehow got resized. A page
   * that reports no viewport is treated as unknown, not blocked.
   */
  private automationBlocked(userId: string): boolean {
    if (this.loginPages.has(userId)) {
      return true;
    }
    const page = this.sessions.get(userId)?.handle.page;
    if (page) {
      const viewport = page.viewportSize();
      if (viewport && (viewport.width !== VIEWPORT.width || viewport.height !== VIEWPORT.height)) {
        return true;
      }
    }
    return false;
  }

  // NOTE: screenshot()/sendInput()/BrowserInput are retained even though
  // the /view route no longer uses them: pre-existing tests exercise
  // sendInput directly and every fake PageLike in the suite implements
  // screenshot, so removing them would break the verified baseline.
  // Nothing on the Connect path calls them anymore.
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
    if (this.automationBlocked(userId)) {
      return null;
    }
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
    if (this.automationBlocked(userId)) {
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
    if (this.automationBlocked(userId)) {
      return null;
    }
    try {
      return await session.handle.page.evaluate(script);
    } catch {
      return null;
    }
  }

  /** Sprint 3: attach files to a file input on the user's current page. */
  async uploadFiles(userId: string, selector: string, files: string[]): Promise<boolean> {
    const session = await this.ensureSession(userId);
    if (this.automationBlocked(userId)) {
      return false;
    }
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
    this.loginPages.delete(userId);
    this.verifiedUsers.delete(userId);
    this.activeProfileIds.delete(userId);
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
