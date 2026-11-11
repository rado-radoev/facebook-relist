// "Sign in to Relist with Facebook": OAuth start/callback, user
// resolution (link by email / create), the one-time sign-in code, the
// dark-when-unconfigured behavior, and the app-secret scan. Graph calls
// are stubbed — no test talks to Meta.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppParts } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { FB_STATE_COOKIE_NAME, type FacebookGraphClient } from "./facebookLogin.js";

const APP_ID = "1234567890";
const APP_SECRET = "TEST-APP-SECRET-do-not-leak";
const ORIGIN = "http://localhost:5173";
const REDIRECT_URI = `${ORIGIN}/api/auth/facebook/callback`;

interface CookieEntry {
  name: string;
  value: string;
}

function cookieHeader(cookies: CookieEntry[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function findCookie(cookies: CookieEntry[], name: string): CookieEntry | undefined {
  return cookies.find((cookie) => cookie.name === name);
}

function makeConfig(dataDir: string, facebookLogin?: Config["facebookLogin"]): Config {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir,
    corsOrigin: ORIGIN,
    cookieSecure: false,
    browserIgnoreCertErrors: false,
    dryRun: true,
    jobPollIntervalMs: 15 * 60 * 1000,
    jobStuckAfterMs: 48 * 60 * 60 * 1000,
    ...(facebookLogin ? { facebookLogin } : {}),
  };
}

describe("loadConfig facebookLogin", () => {
  it("is set only when BOTH the app id and the app secret are present", () => {
    expect(loadConfig({}).facebookLogin).toBeUndefined();
    expect(loadConfig({ FACEBOOK_APP_ID: APP_ID }).facebookLogin).toBeUndefined();
    expect(loadConfig({ FACEBOOK_APP_SECRET: APP_SECRET }).facebookLogin).toBeUndefined();
    expect(loadConfig({ FACEBOOK_APP_ID: APP_ID, FACEBOOK_APP_SECRET: APP_SECRET }).facebookLogin)
      .toEqual({ appId: APP_ID, appSecret: APP_SECRET });
  });
});

describe("unconfigured (feature dark)", () => {
  let parts: AppParts;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "relist-fb-dark-"));
    parts = await buildApp({ config: makeConfig(dataDir) });
  });

  afterAll(async () => {
    await parts.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("reports facebookLoginEnabled false", async () => {
    const res = await parts.app.inject({ method: "GET", url: "/api/auth/config" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ facebookLoginEnabled: false });
  });

  it("404s the flow endpoints", async () => {
    const start = await parts.app.inject({ method: "GET", url: "/api/auth/facebook/start" });
    expect(start.statusCode).toBe(404);
    const callback = await parts.app.inject({ method: "GET", url: "/api/auth/facebook/callback" });
    expect(callback.statusCode).toBe(404);
    const code = await parts.app.inject({
      method: "POST",
      url: "/api/auth/facebook/code",
      payload: { code: "ABCDEFGH" },
    });
    expect(code.statusCode).toBe(404);
  });
});

describe("configured Facebook sign-in", () => {
  let parts: AppParts;
  let dataDir: string;
  let nowMs: number;
  let profile: { id: string; name: string; email?: string };
  let exchangedCodes: string[];

  const graphClient: FacebookGraphClient = {
    exchangeCode: async (code: string, redirectUri: string) => {
      exchangedCodes.push(code);
      expect(redirectUri).toBe(REDIRECT_URI);
      return "fake-access-token";
    },
    fetchProfile: async (accessToken: string) => {
      expect(accessToken).toBe("fake-access-token");
      return profile;
    },
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "relist-fb-login-"));
    nowMs = 1_700_000_000_000;
    profile = { id: "fb-user-1", name: "Rado Test", email: "rado@example.com" };
    exchangedCodes = [];
    parts = await buildApp({
      config: makeConfig(dataDir, { appId: APP_ID, appSecret: APP_SECRET }),
      facebookLoginDeps: { graphClient, now: () => nowMs },
    });
  });

  afterAll(async () => {
    await parts.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Drive /start and return the state + the cookie header to send back. */
  async function startFlow(): Promise<{ state: string; cookie: string }> {
    const res = await parts.app.inject({ method: "GET", url: "/api/auth/facebook/start" });
    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    const url = new URL(location);
    const state = url.searchParams.get("state");
    if (!state) throw new Error("start did not include a state");
    const stateCookie = findCookie(res.cookies as CookieEntry[], FB_STATE_COOKIE_NAME);
    if (!stateCookie) throw new Error("start did not set the state cookie");
    expect(stateCookie.value).toBe(state);
    return { state, cookie: `${FB_STATE_COOKIE_NAME}=${stateCookie.value}` };
  }

  async function callback(state: string, cookie: string, code = "oauth-code-1") {
    return parts.app.inject({
      method: "GET",
      url: `/api/auth/facebook/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });
  }

  function extractSignInCode(html: string): string {
    const match = html.match(/<div class="code">([A-Z2-9]{8})<\/div>/);
    if (!match) throw new Error("success page did not contain a sign-in code");
    return match[1];
  }

  it("reports facebookLoginEnabled true", async () => {
    const res = await parts.app.inject({ method: "GET", url: "/api/auth/config" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ facebookLoginEnabled: true });
  });

  it("start 302s to the Facebook dialog with the right shape and a state cookie", async () => {
    const res = await parts.app.inject({ method: "GET", url: "/api/auth/facebook/start" });
    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location.startsWith("https://www.facebook.com/v21.0/dialog/oauth?")).toBe(true);
    const url = new URL(location);
    expect(url.searchParams.get("client_id")).toBe(APP_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe("public_profile,email");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBeTruthy();
    const stateCookie = findCookie(res.cookies as CookieEntry[], FB_STATE_COOKIE_NAME);
    expect(stateCookie?.value).toBe(url.searchParams.get("state"));
    const raw = res.headers["set-cookie"];
    expect(String(raw)).toContain("HttpOnly");
  });

  it("callback happy path: session cookie issued, success page carries a one-time code", async () => {
    const { state, cookie } = await startFlow();
    const res = await callback(state, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("You're signed in to Relist");
    expect(res.body).toContain('http-equiv="refresh"');
    extractSignInCode(res.body);
    const session = findCookie(res.cookies as CookieEntry[], "relist_session");
    expect(session?.value).toBeTruthy();
    // The issued session is a real Relist session.
    const me = await parts.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `relist_session=${session?.value}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe("rado@example.com");
    expect(exchangedCodes).toContain("oauth-code-1");
  });

  it("state is single-use: replaying the same callback fails", async () => {
    const { state, cookie } = await startFlow();
    const first = await callback(state, cookie);
    expect(first.statusCode).toBe(200);
    const replay = await callback(state, cookie);
    expect(replay.statusCode).toBe(400);
    expect(replay.body).toContain("That sign-in didn't complete");
    expect(findCookie(replay.cookies as CookieEntry[], "relist_session")).toBeUndefined();
  });

  it("state mismatch (cookie ≠ query) fails with no session", async () => {
    const { cookie } = await startFlow();
    const res = await callback("a-different-state", cookie);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("That sign-in didn't complete");
    expect(findCookie(res.cookies as CookieEntry[], "relist_session")).toBeUndefined();
  });

  it("an error param from Facebook renders the failure page with no session", async () => {
    const res = await parts.app.inject({
      method: "GET",
      url: "/api/auth/facebook/callback?error=access_denied&state=whatever",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("That sign-in didn't complete");
    expect(findCookie(res.cookies as CookieEntry[], "relist_session")).toBeUndefined();
  });

  it("email match links the facebookId to the EXISTING user (same id)", async () => {
    // A pre-existing password account with the same email.
    profile = { id: "fb-user-2", name: "Existing Person", email: "existing@example.com" };
    const register = await parts.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Existing Person", email: "existing@example.com", password: "password-123" },
    });
    expect(register.statusCode).toBe(201);
    const existingId = register.json().user.id as string;

    const { state, cookie } = await startFlow();
    const res = await callback(state, cookie);
    expect(res.statusCode).toBe(200);
    const session = findCookie(res.cookies as CookieEntry[], "relist_session");
    const me = await parts.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `relist_session=${session?.value}` },
    });
    expect(me.json().user.id).toBe(existingId);
    expect(parts.store.findUserById(existingId)?.facebookId).toBe("fb-user-2");

    // And the linked account still signs in with its password.
    const login = await parts.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "existing@example.com", password: "password-123" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.id).toBe(existingId);
  });

  it("a new Facebook profile creates a password-less user; password login is a plain 401", async () => {
    profile = { id: "fb-user-3", name: "New Person", email: "newperson@example.com" };
    const { state, cookie } = await startFlow();
    const res = await callback(state, cookie);
    expect(res.statusCode).toBe(200);
    const created = parts.store.findUserByEmail("newperson@example.com");
    expect(created).toBeDefined();
    expect(created?.facebookId).toBe("fb-user-3");
    expect(created?.passwordHash).toBeNull();

    const login = await parts.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "newperson@example.com", password: "any-password-1" },
    });
    expect(login.statusCode).toBe(401);
    expect(login.json()).toEqual({ error: "Email or password is incorrect" });
  });

  it("one-time code: signs in once, reuse is rejected, expiry is rejected", async () => {
    profile = { id: "fb-user-4", name: "Code Person", email: "codeperson@example.com" };
    const { state, cookie } = await startFlow();
    const res = await callback(state, cookie);
    const code = extractSignInCode(res.body);

    // Codes are case-insensitive and tolerate surrounding whitespace.
    const redeem = await parts.app.inject({
      method: "POST",
      url: "/api/auth/facebook/code",
      payload: { code: ` ${code.toLowerCase()} ` },
    });
    expect(redeem.statusCode).toBe(200);
    expect(redeem.json().user.email).toBe("codeperson@example.com");
    const session = findCookie(redeem.cookies as CookieEntry[], "relist_session");
    expect(session?.value).toBeTruthy();
    const me = await parts.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `relist_session=${session?.value}` },
    });
    expect(me.statusCode).toBe(200);

    const reuse = await parts.app.inject({
      method: "POST",
      url: "/api/auth/facebook/code",
      payload: { code },
    });
    expect(reuse.statusCode).toBe(401);

    // A fresh code minted now, redeemed after the 10-minute TTL.
    const second = await startFlow();
    const secondRes = await callback(second.state, second.cookie, "oauth-code-2");
    const freshCode = extractSignInCode(secondRes.body);
    nowMs += 11 * 60 * 1000;
    const expired = await parts.app.inject({
      method: "POST",
      url: "/api/auth/facebook/code",
      payload: { code: freshCode },
    });
    expect(expired.statusCode).toBe(401);
  });

  it("the app secret never appears in any response body or redirect", async () => {
    profile = { id: "fb-user-5", name: "Scan Person", email: "scan@example.com" };
    const bodies: string[] = [];
    const configRes = await parts.app.inject({ method: "GET", url: "/api/auth/config" });
    bodies.push(configRes.body);
    const { state, cookie } = await startFlow();
    const startRes = await parts.app.inject({ method: "GET", url: "/api/auth/facebook/start" });
    bodies.push(startRes.body, String(startRes.headers.location ?? ""));
    const callbackRes = await callback(state, cookie);
    bodies.push(callbackRes.body);
    const code = extractSignInCode(callbackRes.body);
    const codeRes = await parts.app.inject({
      method: "POST",
      url: "/api/auth/facebook/code",
      payload: { code },
    });
    bodies.push(codeRes.body);
    const badCodeRes = await parts.app.inject({
      method: "POST",
      url: "/api/auth/facebook/code",
      payload: { code: "ZZZZZZZZ" },
    });
    bodies.push(badCodeRes.body);
    for (const body of bodies) {
      expect(body).not.toContain(APP_SECRET);
    }
  });
});
