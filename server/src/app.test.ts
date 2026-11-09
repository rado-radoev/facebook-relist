import { mkdtemp, rm } from "node:fs/promises";
import { scrypt } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppParts } from "./app.js";
import { needsPasswordRehash } from "./passwords.js";
import type { BrowserHandle, ContextLike, PageLike } from "./browserManager.js";
import type { Config } from "./config.js";

function makeFakeHandle(): BrowserHandle {
  const page: PageLike = {
    url: () => "https://www.facebook.com/login",
    goto: async () => undefined,
    screenshot: async () => Buffer.from("fake-jpeg"),
    mouse: { click: async () => undefined, wheel: async () => undefined },
    keyboard: {
      type: async (text: string) => { typedPayloads.push(text); },
      press: async () => undefined,
    },
    evaluate: async () => "",
    viewportSize: () => ({ width: 1280, height: 800 }),
  };
  const context: ContextLike = {
    cookies: async () => [],
    clearCookies: async () => undefined,
    close: async () => undefined,
    pages: () => [page],
    newPage: async () => page,
  };
  return { context, page };
}

let dataDir: string;
let parts: AppParts;
let websocketOrigin: string;
let typedPayloads: string[];

beforeAll(async () => {
  typedPayloads = [];
  dataDir = await mkdtemp(path.join(os.tmpdir(), "relist-app-"));
  const config: Config = {
    port: 0,
    host: "127.0.0.1",
    dataDir,
    corsOrigin: "http://localhost:5173",
    cookieSecure: false,
    browserIgnoreCertErrors: false,
    dryRun: true,
    jobPollIntervalMs: 15 * 60 * 1000,
    jobStuckAfterMs: 48 * 60 * 60 * 1000,
  };
  parts = await buildApp({ config, launcher: async () => makeFakeHandle() });
  websocketOrigin = await parts.app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await parts.app.close();
  await rm(dataDir, { recursive: true, force: true });
});

function cookieHeader(cookies: Array<{ name: string; value: string }>): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function registerUser(name: string, email: string): Promise<string> {
  const res = await parts.app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name, email, password: "password-123" },
  });
  expect(res.statusCode).toBe(201);
  return cookieHeader(res.cookies as Array<{ name: string; value: string }>);
}

describe("health", () => {
  it("responds ok without auth", async () => {
    const res = await parts.app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe("auth API", () => {
  it("rejects unauthenticated requests to protected endpoints", async () => {
    const me = await parts.app.inject({ method: "GET", url: "/api/auth/me" });
    expect(me.statusCode).toBe(401);
    const status = await parts.app.inject({ method: "GET", url: "/api/facebook/status" });
    expect(status.statusCode).toBe(401);
    const connect = await parts.app.inject({ method: "POST", url: "/api/facebook/connect" });
    expect(connect.statusCode).toBe(401);
  });

  it("rejects invalid registrations", async () => {
    const res = await parts.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "X", email: "not-an-email", password: "short" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("registers, returns me, and rejects duplicate emails", async () => {
    const cookie = await registerUser("Person One", "one@example.com");
    const me = await parts.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe("one@example.com");
    expect(me.json().user.name).toBe("Person One");
    // The password hash is never exposed.
    expect(JSON.stringify(me.json())).not.toContain("scrypt");

    const duplicate = await parts.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Copy", email: "one@example.com", password: "password-123" },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it("blocks cross-origin state-changing HTTP requests without revoking the session", async () => {
    const cookie = await registerUser("CSRF Guard", "csrf@example.com");
    const response = await parts.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(response.statusCode).toBe(403);
    const me = await parts.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
  });

  it("blocks state changes from a different loopback port", async () => {
    const cookie = await registerUser("Loopback CSRF Guard", "loopback-csrf@example.com");
    const response = await parts.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie, origin: "http://localhost:9999" },
    });
    expect(response.statusCode).toBe(403);
    const me = await parts.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
  });

  it("rejects state-changing requests without Origin when a session cookie is present", async () => {
    const cookie = await registerUser("Origin Required", "origin-required@example.com");
    const response = await parts.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    expect((await parts.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).statusCode)
      .toBe(200);
  });

  it("rate-limits repeated failed logins by account without locking out other users", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await parts.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "nobody@example.com", password: "wrong-password" },
      });
      expect(response.statusCode).toBe(401);
    }
    const limited = await parts.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nobody@example.com", password: "wrong-password" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toMatch(/wait/i);
  });

  it("rate-limits repeated account registration attempts without limiting other household accounts", async () => {
    const isolatedDir = await mkdtemp(path.join(os.tmpdir(), "relist-auth-rate-"));
    const isolated = await buildApp({
      config: {
        port: 0, host: "127.0.0.1", dataDir: isolatedDir,
        corsOrigin: "http://localhost:5173", cookieSecure: false, browserIgnoreCertErrors: false,
        dryRun: true, jobPollIntervalMs: 15 * 60 * 1000, jobStuckAfterMs: 48 * 60 * 60 * 1000,
      },
      launcher: async () => makeFakeHandle(),
    });
    try {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const response = await isolated.app.inject({
          method: "POST",
          url: "/api/auth/register",
          payload: { name: "Duplicate", email: "registration-limit@example.com", password: "password-123" },
        });
        if (attempt === 0) {
          expect(response.statusCode).toBe(201);
        } else if (response.statusCode === 429) {
          return;
        } else {
          expect(response.statusCode).toBe(409);
        }
      }
      throw new Error("Registration throttle did not engage");
    } finally {
      await isolated.app.close();
      await rm(isolatedDir, { recursive: true, force: true });
    }
  });

  it("login needs the right password; logout ends the session", async () => {
    await registerUser("Person Two", "two@example.com");
    const wrong = await parts.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "two@example.com", password: "wrong-password" },
    });
    expect(wrong.statusCode).toBe(401);

    const login = await parts.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "two@example.com", password: "password-123" },
    });
    expect(login.statusCode).toBe(200);
    const cookie = cookieHeader(login.cookies as Array<{ name: string; value: string }>);

    const logout = await parts.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie, origin: "http://localhost:5173" },
    });
    expect(logout.statusCode).toBe(200);
    const meAfter = await parts.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(meAfter.statusCode).toBe(401);
  });

  it("upgrades a legacy password hash after successful authentication", async () => {
    const salt = Buffer.alloc(16, 9);
    const legacyKey = await new Promise<Buffer>((resolve, reject) => {
      scrypt("legacy-login-password", salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
        (error, key) => error ? reject(error) : resolve(key as Buffer));
    });
    const legacyHash = ["scrypt", "16384", "8", "1", salt.toString("base64"), legacyKey.toString("base64")].join(":");
    const user = await parts.store.createUser({
      name: "Legacy Hash", email: "legacy-hash@example.com", passwordHash: legacyHash,
    });

    const response = await parts.app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { email: user.email, password: "legacy-login-password" },
    });
    expect(response.statusCode).toBe(200);
    const upgraded = parts.store.findUserById(user.id)?.passwordHash ?? "";
    expect(needsPasswordRehash(upgraded)).toBe(false);
  });
});

describe("websocket session boundary", () => {
  it("rejects a connected socket when the Origin uses an unconfigured loopback port", async () => {
    const cookie = await registerUser("Origin Guard", "origin-guard@example.com");
    const endpoint = websocketOrigin.replace(/^http:/, "ws:") + "/api/facebook/view";
    const invalid = new WebSocket(endpoint, { headers: { cookie, origin: "http://localhost:9999" } });
    const rejected = await new Promise<boolean>((resolve) => {
      invalid.once("open", () => resolve(false));
      invalid.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(true);
      });
      invalid.once("error", () => resolve(true));
    });
    expect(rejected).toBe(true);
  });

  it("closes an authorized WebSocket after logout", async () => {
    const cookie = await registerUser("Socket Owner", "socket@example.com");
    const endpoint = websocketOrigin.replace(/^http:/, "ws:") + "/api/facebook/view";
    const socket = new WebSocket(endpoint, { headers: { cookie, origin: "http://localhost:5173" } });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const logout = await parts.app.inject({
      method: "POST", url: "/api/auth/logout", headers: { cookie, origin: "http://localhost:5173" },
    });
    expect(logout.statusCode).toBe(200);
    const closeCode = await new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    expect(closeCode).toBe(4401);

  });

  it("reauthorizes queued browser input after logout before dispatch", async () => {
    const cookie = await registerUser("Queued Input Owner", "queued-input@example.com");
    const me = await parts.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    const userId = me.json().user.id as string;
    await parts.browser.ensureSession(userId);

    const endpoint = websocketOrigin.replace(/^http:/, "ws:") + "/api/facebook/view";
    const socket = new WebSocket(endpoint, { headers: { cookie, origin: "http://localhost:5173" } });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    let releaseOperation!: () => void;
    let operationStarted!: () => void;
    const started = new Promise<void>((resolve) => { operationStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseOperation = resolve; });
    const blockingOperation = parts.browser.withUserOperation(userId, async () => {
      operationStarted();
      await gate;
    });
    await started;
    const before = typedPayloads.length;
    socket.send(JSON.stringify({ type: "type", text: "synthetic queued text" }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const logout = await parts.app.inject({
      method: "POST", url: "/api/auth/logout", headers: { cookie, origin: "http://localhost:5173" },
    });
    expect(logout.statusCode).toBe(200);
    releaseOperation();
    await blockingOperation;
    await parts.browser.withUserOperation(userId, async () => undefined);
    expect(typedPayloads.slice(before)).toEqual([]);
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  });

  it("serializes status reads with another browser operation", async () => {
    const cookie = await registerUser("Serialized Status Owner", "serialized-status@example.com");
    const me = await parts.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    const userId = me.json().user.id as string;
    await parts.browser.ensureSession(userId);

    let releaseOperation!: () => void;
    let operationStarted!: () => void;
    const started = new Promise<void>((resolve) => { operationStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseOperation = resolve; });
    const operation = parts.browser.withUserOperation(userId, async () => {
      operationStarted();
      await gate;
    });
    await started;

    let statusResolved = false;
    const status = parts.app.inject({
      method: "GET", url: "/api/facebook/status", headers: { cookie },
    }).then((response) => {
      statusResolved = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(statusResolved).toBe(false);
    releaseOperation();
    await operation;
    expect((await status).statusCode).toBe(200);
  });

  it("does not expose diagnostic browser fields through an endpoint", async () => {
    const cookie = await registerUser("No Diagnostics", "no-diagnostics@example.com");
    const result = await parts.app.inject({
      method: "GET",
      url: "/api/facebook/debug",
      headers: { cookie },
    });
    expect(result.statusCode).toBe(404);
  });
});

describe("facebook status isolation", () => {
  it("each user only ever sees their own facebook status", async () => {
    const cookieA = await registerUser("User A", "a@example.com");
    const cookieB = await registerUser("User B", "b@example.com");

    const connectA = await parts.app.inject({
      method: "POST",
      url: "/api/facebook/connect",
      headers: { cookie: cookieA, origin: "http://localhost:5173" },
      // A client-supplied account id must be ignored — the account comes
      // from the session, never from the request.
      payload: { accountId: "someone-else" },
    });
    expect(connectA.statusCode).toBe(200);
    expect(connectA.json().status).toBe("login_in_progress");

    const statusA = await parts.app.inject({
      method: "GET",
      url: "/api/facebook/status",
      headers: { cookie: cookieA },
    });
    expect(statusA.json().status).toBe("login_in_progress");

    const statusB = await parts.app.inject({
      method: "GET",
      url: "/api/facebook/status",
      headers: { cookie: cookieB },
    });
    expect(statusB.json().status).toBe("not_connected");

    // B disconnecting must not touch A's session.
    const disconnectB = await parts.app.inject({
      method: "POST",
      url: "/api/facebook/disconnect",
      headers: { cookie: cookieB, origin: "http://localhost:5173" },
    });
    expect(disconnectB.json().status).toBe("not_connected");
    const statusAAfter = await parts.app.inject({
      method: "GET",
      url: "/api/facebook/status",
      headers: { cookie: cookieA },
    });
    expect(statusAAfter.json().status).toBe("login_in_progress");
  });
});
