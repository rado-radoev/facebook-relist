import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppParts } from "./app.js";
import type { BrowserHandle, ContextLike, PageLike } from "./browserManager.js";
import type { Config } from "./config.js";
import {
  HOT_WHEELS_ID,
  SWITCHES_ID,
  fixtureSnapshotForUrl,
  switchesEditStep2Snapshot,
} from "./fixtures/index.js";
import type { PageSnapshot } from "./snapshot.js";

// The fake browser fleet is keyed by launch order, which is also the
// order browsers first open in these tests:
//   launch 1 — Person C's sync attempt: never finishes login (no cookie)
//   launch 2 — Person A: connected, pages are the spike fixtures
//   launch 3 — Person B: connected, selling list is empty
//   launch 4+ — never connected
const FIXTURE_LAUNCH = 2;
const CONNECTED_LAUNCHES = new Set([2, 3]);
let launchCount = 0;

function makeFakeHandle(): BrowserHandle {
  launchCount += 1;
  const launch = launchCount;
  let currentUrl = "https://www.facebook.com/login";
  let wizardStep = 1;

  const page: PageLike = {
    url: () => currentUrl,
    goto: async (url: string) => {
      currentUrl = url;
      wizardStep = 1;
    },
    screenshot: async () => Buffer.from("fake-jpeg"),
    mouse: { click: async () => undefined, wheel: async () => undefined },
    keyboard: { type: async () => undefined, press: async () => undefined },
    evaluate: async (expression: string) => {
      if (expression.includes("relist-advance")) {
        if (launch === FIXTURE_LAUNCH && currentUrl.includes(SWITCHES_ID)) {
          wizardStep = 2;
          return true;
        }
        return false;
      }
      if (expression.includes("setTimeout")) {
        return null;
      }
      if (launch !== FIXTURE_LAUNCH) {
        const empty: PageSnapshot = {
          url: currentUrl,
          text: "",
          images: [],
          videos: [],
          sellingCards: [],
          detailRows: [],
          form: { inputs: [], selects: [], checkboxes: [], switches: [], buttons: [] },
        };
        return empty;
      }
      if (wizardStep === 2 && currentUrl.includes(SWITCHES_ID)) {
        return switchesEditStep2Snapshot;
      }
      return fixtureSnapshotForUrl(currentUrl);
    },
    viewportSize: () => ({ width: 1280, height: 800 }),
  };
  const context: ContextLike = {
    cookies: async () => (CONNECTED_LAUNCHES.has(launch) ? [{ name: "c_user" }] : []),
    clearCookies: async () => undefined,
    close: async () => undefined,
    pages: () => [page],
    newPage: async () => page,
  };
  return { context, page };
}

const fakeDownloader = async (url: string): Promise<Buffer> => Buffer.from(`bytes:${url}`);

let dataDir: string;
let parts: AppParts;
let cookieA = "";
let cookieB = "";
let cookieC = "";
let userAId = "";

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "relist-listings-"));
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
  parts = await buildApp({ config, launcher: async () => makeFakeHandle(), downloader: fakeDownloader });
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

async function connect(cookie: string): Promise<void> {
  const res = await parts.app.inject({
    method: "POST",
    url: "/api/facebook/connect",
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
}

describe("listings sync + clone recovery API", () => {
  it("rejects unauthenticated requests", async () => {
    const listings = await parts.app.inject({ method: "GET", url: "/api/listings" });
    expect(listings.statusCode).toBe(401);
    const sync = await parts.app.inject({ method: "POST", url: "/api/listings/sync" });
    expect(sync.statusCode).toBe(401);
    const recover = await parts.app.inject({
      method: "POST",
      url: `/api/listings/${SWITCHES_ID}/clone/recover`,
    });
    expect(recover.statusCode).toBe(401);
  });

  it("sync requires a connected Facebook session", async () => {
    cookieC = await registerUser("Person C", "c@example.com");
    const sync = await parts.app.inject({
      method: "POST",
      url: "/api/listings/sync",
      headers: { cookie: cookieC },
    });
    expect(sync.statusCode).toBe(409);
  });

  it("syncs the connected user's own listings from their selling list", async () => {
    cookieA = await registerUser("Person A", "a@example.com");
    const me = await parts.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieA } });
    userAId = me.json().user.id as string;
    await connect(cookieA);

    const before = await parts.app.inject({
      method: "GET",
      url: "/api/listings",
      headers: { cookie: cookieA },
    });
    expect(before.json().listings).toEqual([]);

    const sync = await parts.app.inject({
      method: "POST",
      url: "/api/listings/sync",
      headers: { cookie: cookieA },
    });
    expect(sync.statusCode).toBe(200);
    const listings = sync.json().listings as Array<Record<string, unknown>>;
    expect(listings).toHaveLength(2);
    expect(listings[0].id).toBe(HOT_WHEELS_ID);
    expect(listings[1].id).toBe(SWITCHES_ID);
    expect(sync.json().syncedAt).toBeTruthy();
  });

  it("recovers the full clone for a synced listing, archiving the photo files", async () => {
    const res = await parts.app.inject({
      method: "POST",
      url: `/api/listings/${SWITCHES_ID}/clone/recover`,
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    const clone = res.json().clone as Record<string, any>;
    expect(clone.recovery.category.value).toBe("Keyboards & Keypads");
    expect(clone.recovery.condition.value).toBe("Used - Like New");
    expect(clone.recovery.delivery.value.type).toBe("Local pickup only");
    expect(clone.recovery.photos.downloaded).toBe(5);
    expect(clone.recovery.video.state).toBe("recovered");

    const photoPath = path.join(
      dataDir,
      "archive",
      userAId,
      SWITCHES_ID,
      "photo-1.jpg",
    );
    const info = await stat(photoPath);
    expect(info.size).toBeGreaterThan(0);

    const photoRes = await parts.app.inject({
      method: "GET",
      url: `/api/listings/${SWITCHES_ID}/photos/0`,
      headers: { cookie: cookieA },
    });
    expect(photoRes.statusCode).toBe(200);
    expect(photoRes.headers["content-type"]).toContain("image/jpeg");
  });

  it("recovers Hot Wheels with condition + delivery missing, never invented", async () => {
    const res = await parts.app.inject({
      method: "POST",
      url: `/api/listings/${HOT_WHEELS_ID}/clone/recover`,
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    const clone = res.json().clone as Record<string, any>;
    expect(clone.recovery.condition.value).toBeNull();
    expect(clone.recovery.condition.reason).toContain("nowhere");
    expect(clone.recovery.delivery.value).toBeNull();
    expect(clone.recovery.photos.downloaded).toBe(3);
    expect(clone.recovery.step2Blocked).toBe(true);
  });

  it("saves picks/edits per listing and returns them with the clone", async () => {
    const put = await parts.app.inject({
      method: "PUT",
      url: `/api/listings/${HOT_WHEELS_ID}/clone/picks`,
      headers: { cookie: cookieA },
      payload: {
        picks: { condition: "Used - Like New" },
        edits: { price: "$28" },
        photoSelection: null,
      },
    });
    expect(put.statusCode).toBe(200);

    const get = await parts.app.inject({
      method: "GET",
      url: `/api/listings/${HOT_WHEELS_ID}/clone`,
      headers: { cookie: cookieA },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().clone.picks).toEqual({ condition: "Used - Like New" });
    expect(get.json().clone.edits).toEqual({ price: "$28" });
    // The recovery itself is untouched by the person's picks.
    expect(get.json().clone.recovery.condition.value).toBeNull();
  });

  it("refuses recovery, clone reads, picks, and photos for another user's listing", async () => {
    cookieB = await registerUser("Person B", "b@example.com");
    await connect(cookieB);
    const syncB = await parts.app.inject({
      method: "POST",
      url: "/api/listings/sync",
      headers: { cookie: cookieB },
    });
    expect(syncB.statusCode).toBe(200);
    expect(syncB.json().listings).toEqual([]);

    const recover = await parts.app.inject({
      method: "POST",
      url: `/api/listings/${SWITCHES_ID}/clone/recover`,
      headers: { cookie: cookieB },
    });
    expect(recover.statusCode).toBe(404);

    const clone = await parts.app.inject({
      method: "GET",
      url: `/api/listings/${SWITCHES_ID}/clone`,
      headers: { cookie: cookieB },
    });
    expect(clone.statusCode).toBe(404);

    const picks = await parts.app.inject({
      method: "PUT",
      url: `/api/listings/${SWITCHES_ID}/clone/picks`,
      headers: { cookie: cookieB },
      payload: { picks: { condition: "New" }, edits: {}, photoSelection: null },
    });
    expect(picks.statusCode).toBe(404);

    const photo = await parts.app.inject({
      method: "GET",
      url: `/api/listings/${SWITCHES_ID}/photos/0`,
      headers: { cookie: cookieB },
    });
    expect(photo.statusCode).toBe(404);
  });

  it("refuses picks with unknown fields", async () => {
    const res = await parts.app.inject({
      method: "PUT",
      url: `/api/listings/${HOT_WHEELS_ID}/clone/picks`,
      headers: { cookie: cookieA },
      payload: { picks: { accountId: "someone-else" }, edits: {}, photoSelection: null },
    });
    expect(res.statusCode).toBe(400);
  });
});
