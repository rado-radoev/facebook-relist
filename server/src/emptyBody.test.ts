import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppParts } from "./app.js";
import type { BrowserHandle, ContextLike, PageLike } from "./browserManager.js";
import type { Config } from "./config.js";

/**
 * Regression tests for the browser's exact body-less POST shape.
 *
 * The API client used to send POSTs like connect / disconnect / sync /
 * logout with NO body but WITH header "Content-Type: application/json".
 * Fastify's default JSON parser rejects an empty JSON body with
 * 400 FST_ERR_CTP_EMPTY_JSON_BODY ("Bad Request") before any route
 * runs. The rest of the suite never noticed because inject calls
 * without a payload don't set that header. These tests replicate the
 * real shape: the header set, the payload an empty string.
 */

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
let cookie = "";

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "relist-empty-body-"));
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

  const res = await parts.app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name: "Browser Shape", email: "shape@example.com", password: "password-123" },
  });
  expect(res.statusCode).toBe(201);
  cookie = (res.cookies as Array<{ name: string; value: string }>)
    .map((entry) => `${entry.name}=${entry.value}`)
    .join("; ");
});

afterAll(async () => {
  await parts.app.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** The browser's body-less POST: JSON content type, zero-length body. */
async function bodylessPost(url: string) {
  return parts.app.inject({
    method: "POST",
    url,
    headers: { cookie, "content-type": "application/json" },
    payload: "",
  });
}

describe("body-less POSTs with a JSON content type", () => {
  it("connect proceeds instead of dying in the body parser", async () => {
    const res = await bodylessPost("/api/facebook/connect");
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("login_in_progress");
  });

  it("disconnect proceeds instead of dying in the body parser", async () => {
    const res = await bodylessPost("/api/facebook/disconnect");
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("not_connected");
  });

  it("listings sync is not rejected by the body parser", async () => {
    const res = await bodylessPost("/api/listings/sync");
    expect(res.statusCode).not.toBe(400);
    expect(res.json().code).not.toBe("FST_ERR_CTP_EMPTY_JSON_BODY");
  });

  it("logout proceeds instead of dying in the body parser", async () => {
    const res = await bodylessPost("/api/auth/logout");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("still rejects a genuinely malformed JSON body", async () => {
    const res = await parts.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
  });
});
