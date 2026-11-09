import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppParts } from "./app.js";
import type { BrowserHandle, ContextLike, PageLike } from "./browserManager.js";
import type { Config } from "./config.js";

function makeFakeHandle(): BrowserHandle {
  const page: PageLike = {
    url: () => "https://www.facebook.com/login",
    goto: async () => undefined,
    screenshot: async () => Buffer.from("fake-jpeg"),
    mouse: { click: async () => undefined, wheel: async () => undefined },
    keyboard: { type: async () => undefined, press: async () => undefined },
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

beforeAll(async () => {
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
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(200);
    const meAfter = await parts.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(meAfter.statusCode).toBe(401);
  });
});

describe("facebook status isolation", () => {
  it("each user only ever sees their own facebook status", async () => {
    const cookieA = await registerUser("User A", "a@example.com");
    const cookieB = await registerUser("User B", "b@example.com");

    const connectA = await parts.app.inject({
      method: "POST",
      url: "/api/facebook/connect",
      headers: { cookie: cookieA },
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
      headers: { cookie: cookieB },
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
