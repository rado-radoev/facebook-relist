// Per-user browser sessions: one persistent Playwright Chromium profile per
// Relist account, stored under <DATA_DIR>/profiles/<userId>/. A session is
// the ONLY place a person's Facebook login lives — Facebook's own page sets
// its cookies in that profile; Relist never sees or stores the password.
//
// The launcher is injectable so tests can drive the manager with a fake
// browser instead of a real Chromium.

import { rm } from "node:fs/promises";
import type { ProxyConfig } from "./config.js";
import {
  detectFacebookStatus,
  type FacebookStatus,
} from "./facebookStatus.js";
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
}

export interface ContextLike {
  cookies(url: string): Promise<Array<{ name: string }>>;
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

const POLL_INTERVAL_MS = 2000;

export class BrowserManager {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly launcher: BrowserLauncher;

  constructor(
    private readonly store: Store,
    private readonly dataDir: string,
    launcher?: BrowserLauncher,
    options: BrowserOptions = {},
  ) {
    this.launcher = launcher ?? makeDefaultLauncher(options);
  }

  hasActiveSession(userId: string): boolean {
    return this.sessions.has(userId);
  }

  statusOf(userId: string): FacebookStatus {
    const user = this.store.findUserById(userId);
    return user ? user.facebookStatus : "not_connected";
  }

  async startLogin(userId: string): Promise<FacebookStatus> {
    let session = this.sessions.get(userId);
    if (!session) {
      const handle = await this.launcher(profileDirFor(this.dataDir, userId));
      const poller = setInterval(() => {
        void this.refreshStatus(userId);
      }, POLL_INTERVAL_MS);
      poller.unref();
      session = { handle, poller };
      this.sessions.set(userId, session);
    }
    await this.store.setFacebookStatus(userId, "login_in_progress");
    try {
      await session.handle.page.goto(FACEBOOK_LOGIN_URL);
    } catch {
      // Navigation hiccups leave the page wherever it is; the remote view
      // shows the real page either way and polling keeps tracking status.
    }
    await this.refreshStatus(userId);
    return this.statusOf(userId);
  }

  async refreshStatus(userId: string): Promise<FacebookStatus> {
    const session = this.sessions.get(userId);
    if (!session) {
      return this.statusOf(userId);
    }
    const cookies = await session.handle.context.cookies("https://www.facebook.com");
    const hasUserCookie = cookies.some((cookie) => cookie.name === "c_user");
    const next = detectFacebookStatus({
      hasUserCookie,
      url: session.handle.page.url(),
      previousStatus: this.statusOf(userId),
    });
    if (next !== this.statusOf(userId)) {
      await this.store.setFacebookStatus(userId, next);
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

  async debugInfo(userId: string): Promise<{ url: string; title: string; emailValue: string | null } | null> {
    const session = this.sessions.get(userId);
    if (!session) {
      return null;
    }
    const page = session.handle.page;
    const title = String(await page.evaluate("document.title").catch(() => ""));
    const emailValue = await page
      .evaluate(
        "(() => { const el = document.querySelector('input[name=\"email\"]'); return el ? el.value : null; })()",
      )
      .catch(() => null);
    return {
      url: page.url(),
      title,
      emailValue: typeof emailValue === "string" ? emailValue : null,
    };
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

  async disconnect(userId: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (session) {
      clearInterval(session.poller);
      this.sessions.delete(userId);
      try {
        await session.handle.context.clearCookies();
      } catch {
        // Profile directory is wiped below either way.
      }
      try {
        await session.handle.context.close();
      } catch {
        // Already closed.
      }
    }
    await rm(profileDirFor(this.dataDir, userId), { recursive: true, force: true });
    await this.store.setFacebookStatus(userId, "not_connected");
  }

  async closeAll(): Promise<void> {
    const userIds = [...this.sessions.keys()];
    for (const userId of userIds) {
      const session = this.sessions.get(userId);
      if (!session) {
        continue;
      }
      clearInterval(session.poller);
      this.sessions.delete(userId);
      try {
        await session.handle.context.close();
      } catch {
        // Already closed.
      }
    }
  }
}
