// "Sign in to Relist with Facebook" — Facebook Login (OAuth) as an
// alternative way to sign in to RELIST ITSELF, replacing the forgettable
// Relist password. It has nothing to do with the Marketplace browser
// session: Facebook vouches for the person's identity TO Relist, and
// Relist issues its own ordinary session. The Connect/listings/jobs
// machinery is untouched.
//
// iOS PWA handoff: the OAuth round trip finishes in Safari (or an in-app
// browser), whose cookie jar is NOT the installed PWA's — iOS isolates
// their storage, so a session cookie set on the callback page never
// reaches the app. The callback therefore also mints a ONE-TIME SIGN-IN
// CODE shown on the success page; the person types it into the PWA,
// which exchanges it (POST /api/auth/facebook/code) for the standard
// session cookie inside the PWA's own cookie jar.
//
// Security shape: the Meta app secret is used only in the server→Graph
// token exchange. It is never logged and never appears in any response.
// OAuth state and sign-in codes are stored only as SHA-256 hashes, are
// single-use, and expire after 10 minutes. Both live in memory: a
// backend restart simply means "start the sign-in again".

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { setSessionCookie, toPublicUser } from "./auth.js";
import type { Config } from "./config.js";
import { hashToken, type Store, type UserRecord } from "./store.js";

const GRAPH_VERSION = "v21.0";
const OAUTH_DIALOG_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
const TOKEN_URL = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`;
const PROFILE_URL = `https://graph.facebook.com/${GRAPH_VERSION}/me`;

export const FB_STATE_COOKIE_NAME = "relist_fb_state";
const STATE_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
// Unambiguous alphabet: no 0/O, 1/I/L — the code is read off one screen
// and typed on another.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_ATTEMPTS_PER_IP = 30;
const CODE_ATTEMPT_WINDOW_MS = 60_000;

export interface FacebookProfile {
  id: string;
  name: string;
  email?: string;
}

/** The two Graph calls, behind an interface so tests can stub them. */
export interface FacebookGraphClient {
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  fetchProfile(accessToken: string): Promise<FacebookProfile>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function createFacebookGraphClient(
  appId: string,
  appSecret: string,
  fetchImpl: FetchLike = fetch,
): FacebookGraphClient {
  return {
    async exchangeCode(code: string, redirectUri: string): Promise<string> {
      const params = new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code,
      });
      const response = await fetchImpl(`${TOKEN_URL}?${params.toString()}`);
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok || typeof body.access_token !== "string") {
        throw new Error("Facebook token exchange failed");
      }
      return body.access_token;
    },

    async fetchProfile(accessToken: string): Promise<FacebookProfile> {
      const params = new URLSearchParams({
        fields: "id,name,email",
        access_token: accessToken,
      });
      const response = await fetchImpl(`${PROFILE_URL}?${params.toString()}`);
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok || typeof body.id !== "string") {
        throw new Error("Facebook profile fetch failed");
      }
      return {
        id: body.id,
        name: typeof body.name === "string" ? body.name : "",
        ...(typeof body.email === "string" ? { email: body.email } : {}),
      };
    },
  };
}

/** Pending OAuth states and sign-in codes, keyed by SHA-256 hash. */
class ExpiringHashes {
  private readonly entries = new Map<string, { userId: string | null; expiresAt: number }>();

  constructor(private readonly now: () => number) {}

  private prune(): void {
    const now = this.now();
    for (const [hash, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(hash);
    }
  }

  add(value: string, ttlMs: number, userId: string | null = null): void {
    this.prune();
    this.entries.set(hashToken(value), { userId, expiresAt: this.now() + ttlMs });
  }

  /** Look up without consuming (used for the sign-in code, which is
   *  consumed only on a fully successful exchange). */
  peek(value: string): { userId: string | null; expiresAt: number } | undefined {
    this.prune();
    const hash = hashToken(value);
    const candidate = Buffer.from(hash, "utf8");
    for (const [storedHash, entry] of this.entries) {
      const stored = Buffer.from(storedHash, "utf8");
      if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) {
        return entry;
      }
    }
    return undefined;
  }

  consume(value: string): { userId: string | null } | undefined {
    const entry = this.peek(value);
    if (!entry) return undefined;
    this.entries.delete(hashToken(value));
    return entry;
  }
}

function generateSignInCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
  }
  return code;
}

function pageShell(title: string, bodyHtml: string, headExtra = ""): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    headExtra,
    `<title>${title}</title>`,
    "<style>",
    "body{margin:0;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#1e1e2e;color:#cdd6f4;",
    "display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}",
    ".card{max-width:420px;text-align:center}",
    "h1{font-size:24px;margin:0 0 12px}",
    "p{color:#a6adc8;line-height:1.5}",
    ".code{font-size:40px;font-weight:700;letter-spacing:6px;color:#f5c2e7;background:#313244;",
    "border-radius:12px;padding:18px 8px;margin:20px 0;font-family:ui-monospace,Menlo,monospace}",
    "a{color:#89b4fa}",
    "</style>",
    "</head>",
    "<body>",
    `<main class="card">${bodyHtml}</main>`,
    "</body>",
    "</html>",
  ].join("\n");
}

function failurePage(reply: FastifyReply, status: number, message: string): void {
  const html = pageShell(
    "Relist sign-in didn't complete",
    `<h1>That sign-in didn't complete</h1><p>${message}</p>` +
      "<p>Go back to Relist and try again.</p>",
  );
  void reply.code(status).type("text/html; charset=utf-8").send(html);
}

function successPage(code: string): string {
  // On desktop / in the same browser, the session cookie set by the
  // callback DOES apply, so bounce straight into the app after a few
  // seconds. In the iOS case (Safari's cookie jar ≠ the PWA's) the code
  // below is the path in — it stays on screen long enough to read.
  return pageShell(
    "Signed in to Relist",
    "<h1>You're signed in to Relist</h1>" +
      "<p>If the Relist app doesn't open signed in, enter this one-time code in the app " +
      "(tap &lsquo;I have a sign-in code&rsquo; on the sign-in screen):</p>" +
      `<div class="code">${code}</div>` +
      "<p>The code works once and expires in 10 minutes.</p>" +
      '<p><a href="/">Open Relist</a></p>',
    '<meta http-equiv="refresh" content="5;url=/">',
  );
}

export interface FacebookLoginDeps {
  graphClient?: FacebookGraphClient;
  now?: () => number;
}

export function registerFacebookLoginRoutes(
  app: FastifyInstance,
  store: Store,
  config: Config,
  deps: FacebookLoginDeps = {},
): void {
  const now = deps.now ?? (() => Date.now());
  const states = new ExpiringHashes(now);
  const codes = new ExpiringHashes(now);
  const fb = config.facebookLogin;
  const graph = fb
    ? deps.graphClient ?? createFacebookGraphClient(fb.appId, fb.appSecret)
    : undefined;

  // Discovery for the client: is the Facebook button on at all?
  app.get("/api/auth/config", async (_request, reply) => {
    await reply.send({ facebookLoginEnabled: Boolean(fb) });
  });

  if (!fb || !graph) {
    // Fully dark when unconfigured: the flow endpoints do not exist.
    app.get("/api/auth/facebook/start", async (_request, reply) => {
      await reply.code(404).send({ error: "Not found" });
    });
    app.get("/api/auth/facebook/callback", async (_request, reply) => {
      await reply.code(404).send({ error: "Not found" });
    });
    app.post("/api/auth/facebook/code", async (_request, reply) => {
      await reply.code(404).send({ error: "Not found" });
    });
    return;
  }

  const redirectUri = `${config.corsOrigin}/api/auth/facebook/callback`;
  const codeAttempts = new Map<string, { startedAt: number; attempts: number }>();

  app.get("/api/auth/facebook/start", async (_request, reply) => {
    const state = randomBytes(24).toString("base64url");
    states.add(state, STATE_TTL_MS);
    reply.setCookie(FB_STATE_COOKIE_NAME, state, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(STATE_TTL_MS / 1000),
      secure: config.cookieSecure,
    });
    const params = new URLSearchParams({
      client_id: fb.appId,
      redirect_uri: redirectUri,
      scope: "public_profile,email",
      state,
      response_type: "code",
    });
    await reply.redirect(`${OAUTH_DIALOG_URL}?${params.toString()}`);
  });

  app.get("/api/auth/facebook/callback", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    if (typeof query.error === "string") {
      failurePage(reply, 200, "Facebook sign-in was cancelled or declined.");
      return;
    }
    const code = typeof query.code === "string" ? query.code : "";
    const state = typeof query.state === "string" ? query.state : "";
    const cookieState = request.cookies[FB_STATE_COOKIE_NAME];
    reply.clearCookie(FB_STATE_COOKIE_NAME, { path: "/" });
    // The state must match BOTH the cookie set at /start (same browser
    // made the round trip) and the server-side store (single-use).
    if (!code || !state || cookieState !== state || !states.consume(state)) {
      failurePage(reply, 400, "This sign-in link is invalid or has expired.");
      return;
    }

    let profile: FacebookProfile;
    try {
      const accessToken = await graph.exchangeCode(code, redirectUri);
      profile = await graph.fetchProfile(accessToken);
    } catch {
      failurePage(reply, 400, "Facebook didn't finish the sign-in.");
      return;
    }

    const user = await resolveUser(store, profile);
    if (!user) {
      failurePage(
        reply,
        400,
        "Facebook didn't share an email address, so Relist can't match or create your account.",
      );
      return;
    }

    const token = await store.createSession(user.id);
    setSessionCookie(reply, token, config);
    const signInCode = generateSignInCode();
    codes.add(signInCode, CODE_TTL_MS, user.id);
    await reply.type("text/html; charset=utf-8").send(successPage(signInCode));
  });

  app.post("/api/auth/facebook/code", async (request, reply) => {
    // Modest per-IP throttle: an 8-character code must not be a
    // brute-force oracle.
    const attemptWindow = codeAttempts.get(request.ip);
    const nowMs = now();
    if (attemptWindow && nowMs - attemptWindow.startedAt < CODE_ATTEMPT_WINDOW_MS) {
      attemptWindow.attempts += 1;
      if (attemptWindow.attempts > CODE_ATTEMPTS_PER_IP) {
        await reply.code(429).send({ error: "Too many code attempts; wait before trying again" });
        return;
      }
    } else {
      codeAttempts.set(request.ip, { startedAt: nowMs, attempts: 1 });
    }

    const body = request.body as Record<string, unknown> | null;
    const rawCode = typeof body?.code === "string" ? body.code : "";
    const normalized = rawCode.trim().toUpperCase();
    const entry = normalized ? codes.peek(normalized) : undefined;
    const user = entry?.userId ? store.findUserById(entry.userId) : undefined;
    if (!entry || !user) {
      await reply
        .code(401)
        .send({ error: "That code isn't valid — it may have expired or already been used." });
      return;
    }
    codes.consume(normalized);
    const token = await store.createSession(user.id);
    setSessionCookie(reply, token, config);
    await reply.send({ user: toPublicUser(user) });
  });
}

/**
 * Who is this Facebook profile in Relist? (a) a linked account by Meta
 * id; (b) an existing account with the same email — link the Meta id to
 * THAT user, preserving their id and everything keyed by it (browser
 * profile, listings, jobs); (c) a brand-new password-less account.
 * Returns undefined when a new account would be needed but Facebook
 * shared no email to create it under.
 */
async function resolveUser(store: Store, profile: FacebookProfile): Promise<UserRecord | undefined> {
  const linked = store.findUserByFacebookId(profile.id);
  if (linked) {
    return linked;
  }
  if (!profile.email) {
    return undefined;
  }
  const byEmail = store.findUserByEmail(profile.email);
  if (byEmail) {
    await store.setFacebookId(byEmail.id, profile.id);
    return byEmail;
  }
  return store.createUser({
    name: profile.name || "Relist user",
    email: profile.email,
    passwordHash: null,
    facebookId: profile.id,
  });
}
