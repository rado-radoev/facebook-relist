import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppParts } from "./app.js";
import type { BrowserHandle, ContextLike, PageLike } from "./browserManager.js";
import { missing, recovered, type StoredClone, type SyncedListing } from "./cloneTypes.js";
import type { Config } from "./config.js";
import type {
  CreateOutcome,
  DeleteOutcome,
  MarketplaceDriver,
  VerifyResult,
} from "./facebookDriver.js";
import type { ListingAvailability } from "./jobLogic.js";

// Job routes are tested with a FAKE Marketplace driver injected into the
// app — no browser, no Facebook. Facebook connection state is set
// directly in the store (statusOf reads it from there); listings and
// clone checks are seeded through the store the same way Sprint 2's
// sync/recovery would have written them.

const OLD_ID = "111";
const NEW_ID = "222";
const POLL_MS = 15 * 60 * 1000;

class FakeDriver implements MarketplaceDriver {
  private approvedPayloadHash = "";

  async findPossibleDuplicate(): Promise<SyncedListing | null> {
    return null;
  }

  async createListing(
    _userId: string,
    _data: unknown,
    _photoPaths: string[],
    _videoPath: string | null,
    options: { dryRun: boolean },
  ): Promise<CreateOutcome> {
    if (options.dryRun) {
      return { kind: "dry_run" };
    }
    return { kind: "created", listingId: NEW_ID, url: `https://www.facebook.com/marketplace/item/${NEW_ID}` };
  }

  async checkListing(): Promise<ListingAvailability> {
    return "available";
  }

  async listingStillListed(): Promise<boolean | "unknown"> {
    return true;
  }

  async checkOriginalUnchanged(): Promise<"unchanged" | "changed" | "unknown"> {
    return "unchanged";
  }

  async verifyNewListing(
    _userId: string,
    listingId: string,
    _url: string,
    payloadHash: string,
  ): Promise<{ state: "verified"; listingId: string; sellerMatchesOwner: true; payloadHash: string }> {
    this.approvedPayloadHash = payloadHash;
    return { state: "verified", listingId, sellerMatchesOwner: true, payloadHash };
  }

  async verifyRecreate(): Promise<VerifyResult> {
    return {
      oldGone: true,
      newListed: true,
      complete: true,
      newListingId: NEW_ID,
      newSellerId: "owner-1",
      newPayloadHash: this.approvedPayloadHash,
    };
  }

  async deleteListing(
    _userId: string,
    _listingId: string,
    options: { dryRun: boolean },
  ): Promise<DeleteOutcome> {
    if (options.dryRun) {
      return { kind: "dry_run" };
    }
    return { kind: "deleted" };
  }
}

function unusedHandle(): BrowserHandle {
  const page: PageLike = {
    url: () => "https://www.facebook.com/",
    goto: async () => undefined,
    screenshot: async () => Buffer.from("fake"),
    mouse: { click: async () => undefined, wheel: async () => undefined },
    keyboard: { type: async () => undefined, press: async () => undefined },
    evaluate: async () => null,
    viewportSize: () => ({ width: 1280, height: 800 }),
  };
  const context: ContextLike = {
    cookies: async () => [{ name: "c_user" }],
    clearCookies: async () => undefined,
    close: async () => undefined,
    pages: () => [page],
    newPage: async () => page,
  };
  return { context, page };
}

function completeClone(): StoredClone {
  return {
    recovery: {
      listingId: OLD_ID,
      recoveredAt: "2026-11-09T10:00:00.000Z",
      title: recovered("Widget", "edit_form"),
      price: recovered("$30", "edit_form"),
      description: recovered("A fine widget.", "edit_form"),
      category: recovered("Toys & Games", "edit_form"),
      condition: recovered("Used - Like New", "edit_form"),
      attributes: recovered({}, "edit_form"),
      location: recovered("San Diego, CA", "edit_form"),
      delivery: recovered(
        { type: "Local pickup only", shipping: false, meetup: { public: false, doorPickup: false, doorDropoff: false } },
        "edit_form",
      ),
      photos: Object.assign({
        urls: ["https://cdn.example/a/photo-1.jpg"],
        files: ["photo-1.jpg"],
        downloaded: 1,
      }, {
        complete: true,
        expectedCount: 1,
        identities: ["media-1"],
        reasons: [null],
      }),
      video: { present: false, state: "none", file: null, reason: null },
      step2Blocked: false,
    },
    picks: {},
    edits: {},
    photoSelection: null,
    updatedAt: "2026-11-09T10:00:00.000Z",
  };
}

let dataDir: string;
let parts: AppParts;
let clock = new Date("2026-11-09T12:00:00.000Z");
let cookieA = "";
let cookieB = "";
let cookieC = "";
let userAId = "";
let jobId = "";

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "relist-jobroutes-"));
  const config: Config = {
    port: 0,
    host: "127.0.0.1",
    dataDir,
    corsOrigin: "http://localhost:5173",
    cookieSecure: false,
    browserIgnoreCertErrors: false,
    dryRun: true,
    jobPollIntervalMs: POLL_MS,
    jobStuckAfterMs: 48 * 60 * 60 * 1000,
  };
  parts = await buildApp({
    config,
    launcher: async () => unusedHandle(),
    driver: new FakeDriver(),
    jobOptions: { dryRun: false, now: () => clock, random: () => 0.5 },
  });
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

async function seedConnectedUser(cookie: string): Promise<string> {
  const me = await parts.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
  const userId = me.json().user.id as string;
  await parts.store.setFacebookStatus(userId, "connected");
  const mediaDir = path.join(dataDir, "archive", userId, OLD_ID);
  await mkdir(mediaDir, { recursive: true });
  await writeFile(path.join(mediaDir, "photo-1.jpg"), "generated fake image bytes");
  await parts.store.setListings(userId, [
    {
      id: OLD_ID,
      title: "Widget",
      price: "$30",
      status: "Available",
      statusText: "Active",
      photoUrl: "https://cdn.example/a/photo-1.jpg",
      url: `https://www.facebook.com/marketplace/item/${OLD_ID}`,
      listedDate: "2026-10-01",
      syncedAt: "2026-11-09T10:00:00.000Z",
    },
  ]);
  await parts.store.saveClone(userId, OLD_ID, completeClone());
  return userId;
}

describe("recreate job API", () => {
  it("rejects unauthenticated requests", async () => {
    const create = await parts.app.inject({ method: "POST", url: `/api/listings/${OLD_ID}/jobs` });
    expect(create.statusCode).toBe(401);
    const list = await parts.app.inject({ method: "GET", url: "/api/jobs" });
    expect(list.statusCode).toBe(401);
    const history = await parts.app.inject({ method: "GET", url: "/api/history" });
    expect(history.statusCode).toBe(401);
  });

  it("requires a connected Facebook session to start a job", async () => {
    cookieC = await registerUser("Person C", "c-jobs@example.com");
    const res = await parts.app.inject({
      method: "POST",
      url: `/api/listings/${OLD_ID}/jobs`,
      headers: { cookie: cookieC },
    });
    expect(res.statusCode).toBe(409);
  });

  it("creates a job from a completed clone check and walks it to done", async () => {
    cookieA = await registerUser("Person A", "a-jobs@example.com");
    userAId = await seedConnectedUser(cookieA);

    const create = await parts.app.inject({
      method: "POST",
      url: `/api/listings/${OLD_ID}/jobs`,
      headers: { cookie: cookieA },
    });
    expect(create.statusCode).toBe(201);
    const job = create.json().job as Record<string, any>;
    jobId = job.id as string;
    expect(job.listingId).toBe(OLD_ID);
    expect(job.dryRun).toBe(false);
    // The owner id is internal and never leaves the server.
    expect(job.userId).toBeUndefined();

    // Advance deterministically through the runner (the route also
    // kicked a background pass; processJob is safe to call again).
    await parts.jobs.processJob(userAId, jobId);
    const mid = await parts.app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { cookie: cookieA },
    });
    expect(mid.json().job.status).toBe("in_review");
    expect(mid.json().job.newListingId).toBe(NEW_ID);

    clock = new Date(clock.getTime() + POLL_MS);
    await parts.jobs.processDueJobs();
    const done = await parts.app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { cookie: cookieA },
    });
    expect(done.json().job.status).toBe("done");

    const history = await parts.app.inject({
      method: "GET",
      url: "/api/history",
      headers: { cookie: cookieA },
    });
    expect(history.json().history).toHaveLength(1);
    expect(history.json().history[0].newListingId).toBe(NEW_ID);
  });

  it("returns the same job for repeated requests for the same original listing", async () => {
    const cookie = await registerUser("Person D", "d-jobs@example.com");
    await seedConnectedUser(cookie);
    const first = await parts.app.inject({
      method: "POST",
      url: `/api/listings/${OLD_ID}/jobs`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(201);
    const second = await parts.app.inject({
      method: "POST",
      url: `/api/listings/${OLD_ID}/jobs`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().job.id).toBe(first.json().job.id);
  });

  it("returns 400 with the missing fields when the clone check is incomplete", async () => {
    cookieB = await registerUser("Person B", "b-jobs@example.com");
    const userBId = await seedConnectedUser(cookieB);
    const clone = completeClone();
    clone.recovery!.condition = missing<string>("Not present anywhere.");
    await parts.store.saveClone(userBId, OLD_ID, clone);

    const res = await parts.app.inject({
      method: "POST",
      url: `/api/listings/${OLD_ID}/jobs`,
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().missing).toEqual(["condition"]);
  });

  it("404s a job that is not in the caller's own synced listings", async () => {
    const res = await parts.app.inject({
      method: "POST",
      url: "/api/listings/999/jobs",
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(404);
  });

  it("never exposes another user's job or history", async () => {
    const job = await parts.app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { cookie: cookieB },
    });
    expect(job.statusCode).toBe(404);

    const list = await parts.app.inject({
      method: "GET",
      url: "/api/jobs",
      headers: { cookie: cookieB },
    });
    expect(list.json().jobs).toEqual([]);

    const history = await parts.app.inject({
      method: "GET",
      url: "/api/history",
      headers: { cookie: cookieB },
    });
    expect(history.json().history).toEqual([]);
  });
});
