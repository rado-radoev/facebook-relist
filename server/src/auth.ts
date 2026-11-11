// Relist app accounts: register / login / logout / me.
//
// The account for every request is derived from the httpOnly session
// cookie — never from a client-supplied id. There is no admin account and
// no way to list or reach another person's account.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, type Config } from "./config.js";
import { hashPassword, needsPasswordRehash, verifyPassword } from "./passwords.js";
import type { Store, UserRecord } from "./store.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: UserRecord;
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RATE_WINDOW_MS = 60_000;
const MAX_RATE_BUCKETS = 10_000;
const LOGIN_FAILURES_PER_ACCOUNT = 10;
const LOGIN_FAILURES_PER_IP = 60;
const REGISTRATION_ATTEMPTS_PER_IP = 60;

interface RateBucket {
  startedAt: number;
  attempts: number;
}

function createRateLimiter() {
  const buckets = new Map<string, RateBucket>();
  const prune = (now: number): void => {
    for (const [bucketKey, bucket] of buckets) {
      if (now - bucket.startedAt >= RATE_WINDOW_MS) buckets.delete(bucketKey);
    }
  };
  return {
    isLimited(key: string, limit: number): boolean {
      const now = Date.now();
      prune(now);
      return (buckets.get(key)?.attempts ?? 0) >= limit;
    },
    record(key: string): void {
      const now = Date.now();
      prune(now);
      let bucket = buckets.get(key);
      if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
        if (buckets.size >= MAX_RATE_BUCKETS) buckets.delete(buckets.keys().next().value as string);
        bucket = { startedAt: now, attempts: 0 };
        buckets.set(key, bucket);
      }
      bucket.attempts += 1;
    },
    clear(key: string): void {
      buckets.delete(key);
    }
  };
}

export interface PublicUser {
  id: string;
  name: string;
  email: string;
}

export function toPublicUser(user: UserRecord): PublicUser {
  return { id: user.id, name: user.name, email: user.email };
}

export function sessionTokenFrom(request: FastifyRequest): string | undefined {
  return request.cookies[SESSION_COOKIE_NAME];
}

export function userFromRequest(store: Store, request: FastifyRequest): UserRecord | undefined {
  const token = sessionTokenFrom(request);
  if (!token) {
    return undefined;
  }
  return store.findUserBySessionToken(token);
}

export function makeRequireAuth(store: Store) {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = userFromRequest(store, request);
    if (!user) {
      await reply.code(401).send({ error: "Not signed in" });
      return;
    }
    request.user = user;
  };
}

function readCredentials(body: unknown): { name?: string; email: string; password: string } | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const email = typeof record.email === "string" ? record.email.trim() : "";
  const password = typeof record.password === "string" ? record.password : "";
  const name = typeof record.name === "string" ? record.name.trim() : undefined;
  if (!EMAIL_PATTERN.test(email) || password.length < 8) {
    return null;
  }
  return { name, email, password };
}

export function registerAuthRoutes(app: FastifyInstance, store: Store, config: Config): void {
  const requireAuth = makeRequireAuth(store);
  const loginFailures = createRateLimiter();
  const registrationAttempts = createRateLimiter();

  app.post("/api/auth/register", async (request, reply) => {
    if (registrationAttempts.isLimited(request.ip, REGISTRATION_ATTEMPTS_PER_IP)) {
      await reply.code(429).send({ error: "Too many registration attempts; wait before trying again" });
      return;
    }
    registrationAttempts.record(request.ip);
    const credentials = readCredentials(request.body);
    if (!credentials || !credentials.name) {
      await reply.code(400).send({ error: "Name, a valid email, and a password of 8+ characters are required" });
      return;
    }
    if (store.findUserByEmail(credentials.email)) {
      await reply.code(409).send({ error: "An account with this email already exists" });
      return;
    }
    const passwordHash = await hashPassword(credentials.password);
    const user = await store.createUser({
      name: credentials.name,
      email: credentials.email,
      passwordHash,
    });
    const token = await store.createSession(user.id);
    setSessionCookie(reply, token, config);
    await reply.code(201).send({ user: toPublicUser(user) });
  });

  app.post("/api/auth/login", async (request, reply) => {
    const credentials = readCredentials(request.body);
    if (!credentials) {
      await reply.code(400).send({ error: "A valid email and password are required" });
      return;
    }
    const accountKey = `${request.ip}:${credentials.email.toLowerCase()}`;
    if (loginFailures.isLimited(accountKey, LOGIN_FAILURES_PER_ACCOUNT) ||
        loginFailures.isLimited(request.ip, LOGIN_FAILURES_PER_IP)) {
      await reply.code(429).send({ error: "Too many login attempts; wait before trying again" });
      return;
    }
    const user = store.findUserByEmail(credentials.email);
    if (!user || !user.passwordHash) {
      // No such account — or an account created via Facebook sign-in,
      // which has no Relist password. Same response either way: the
      // reply must not hint at which sign-in method the account uses.
      loginFailures.record(accountKey);
      loginFailures.record(request.ip);
      await reply.code(401).send({ error: "Email or password is incorrect" });
      return;
    }
    const ok = await verifyPassword(credentials.password, user.passwordHash);
    if (!ok) {
      loginFailures.record(accountKey);
      loginFailures.record(request.ip);
      await reply.code(401).send({ error: "Email or password is incorrect" });
      return;
    }
    loginFailures.clear(accountKey);
    if (needsPasswordRehash(user.passwordHash)) {
      await store.updatePasswordHash(user.id, await hashPassword(credentials.password));
    }
    const token = await store.createSession(user.id);
    setSessionCookie(reply, token, config);
    await reply.send({ user: toPublicUser(user) });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = sessionTokenFrom(request);
    if (token) {
      await store.deleteSession(token);
    }
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    await reply.send({ ok: true });
  });

  app.get("/api/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user as UserRecord;
    await reply.send({ user: toPublicUser(user) });
  });
}

export function setSessionCookie(reply: FastifyReply, token: string, config: Config): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure: config.cookieSecure,
  });
}
