import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppParts } from "./app.js";
import type { BrowserHandle, ContextLike, PageLike } from "./browserManager.js";
import { recovered, type StoredClone } from "./cloneTypes.js";
import type { Config } from "./config.js";
import type {
  CreateOutcome,
  DeleteOutcome,
  MarketplaceDriver,
  VerifyResult,
} from "./facebookDriver.js";
import type { ListingAvailability } from "./jobLogic.js";
import { hashPassword } from "./passwords.js";

// Legacy compatibility: clone records written before revision tracking and
// structured delivery edits have neither field in the stored JSON. Such a
// record must still load, save (treated as revision 0, gaining a revision),
// refuse stale saves, and create a recreate job with no revision supplied.

const USER_ID = "legacy-user";
const OLD_ID = "111";
const NEW_ID = "222";

class FakeDriver implements MarketplaceDriver {
  async findPossibleDuplicate(): Promise<null> {
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

  async listingStillListed(): Promise<boolean> {
    return true;
  }

  async checkOriginalUnchanged(): Promise<"unchanged"> {
    return "unchanged";
  }

  async verifyNewListing(
    _userId: string,
    listingId: string,
    _url: string,
    payloadHash: string,
  ): Promise<{ state: "verified"; listingId: string; sellerMatchesOwner: true; payloadHash: string }> {
    return { state: "verified", listingId, sellerMatchesOwner: true, payloadHash };
  }

  async verifyRecreate(): Promise<VerifyResult> {
    return {
      oldGone: true,
      newListed: true,
      complete: true,
      newListingId: NEW_ID,
      newSellerId: USER_ID,
      newPayloadHash: "hash",
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

/** A complete clone exactly as pre-revision code wrote it: no `revision`,
 *  no `deliveryEdits` keys at all. */
function legacyClone(): StoredClone {
  return {
    recovery: {
      listingId: OLD_ID,
      recoveredAt: "2026-10-20T10:00:00.000Z",
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
    updatedAt: "2026-10-20T10:00:00.000Z",
  };
}

let dataDir: string;
let parts: AppParts;
let cookie = "";

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "relist-legacy-"));
  const passwordHash = await hashPassword("password-123");
  const data = {
    users: [{
      id: USER_ID,
      name: "Legacy Person",
      email: "legacy@example.com",
      passwordHash,
      facebookStatus: "connected",
      facebookConnectedAt: "2026-10-20T10:00:00.000Z",
      createdAt: "2026-10-20T10:00:00.000Z",
    }],
    sessions: [],
    listings: {
      [USER_ID]: [{
        id: OLD_ID,
        title: "Widget",
        price: "$30",
        status: "Available",
        statusText: "Active",
        photoUrl: "https://cdn.example/a/photo-1.jpg",
        url: `https://www.facebook.com/marketplace/item/${OLD_ID}`,
        listedDate: "2026-10-01",
        syncedAt: "2026-10-20T10:00:00.000Z",
      }],
    },
    listingsSyncedAt: { [USER_ID]: "2026-10-20T10:00:00.000Z" },
    clones: { [USER_ID]: { [OLD_ID]: legacyClone() } },
    jobs: {},
    history: {},
    facebookIdentityHashes: {},
  };
  await writeFile(path.join(dataDir, "relist-data.json"), JSON.stringify(data), "utf8");
  const mediaDir = path.join(dataDir, "archive", USER_ID, OLD_ID);
  await mkdir(mediaDir, { recursive: true });
  await writeFile(path.join(mediaDir, "photo-1.jpg"), "generated fake image bytes");

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
  parts = await buildApp({
    config,
    launcher: async () => unusedHandle(),
    driver: new FakeDriver(),
    jobOptions: { dryRun: true },
  });

  const login = await parts.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "legacy@example.com", password: "password-123" },
  });
  expect(login.statusCode).toBe(200);
  cookie = (login.cookies as Array<{ name: string; value: string }>)
    .map((entry) => `${entry.name}=${entry.value}`)
    .join("; ");
});

afterAll(async () => {
  await parts.app.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("legacy clone records (no revision / deliveryEdits)", () => {
  it("loads through the API with the fields absent", async () => {
    const res = await parts.app.inject({
      method: "GET",
      url: `/api/listings/${OLD_ID}/clone`,
      headers: { cookie, origin: "http://localhost:5173" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().clone.recovery.listingId).toBe(OLD_ID);
    expect(res.json().clone.revision).toBeUndefined();
    expect(res.json().clone.deliveryEdits).toBeUndefined();
  });

  it("saves against implicit revision 0, then refuses a stale save", async () => {
    const save = await parts.app.inject({
      method: "PUT",
      url: `/api/listings/${OLD_ID}/clone/picks`,
      headers: { cookie, origin: "http://localhost:5173" },
      payload: { picks: {}, edits: {}, photoSelection: null, revision: 0 },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json().clone.revision).toBe(1);
    expect(save.json().clone.deliveryEdits).toEqual({});

    const stale = await parts.app.inject({
      method: "PUT",
      url: `/api/listings/${OLD_ID}/clone/picks`,
      headers: { cookie, origin: "http://localhost:5173" },
      payload: { picks: {}, edits: {}, photoSelection: null, revision: 0 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatch(/changed since it was loaded/i);
    expect(stale.json().currentRevision).toBe(1);
  });

  it("creates a recreate job with no revision supplied", async () => {
    const create = await parts.app.inject({
      method: "POST",
      url: `/api/listings/${OLD_ID}/jobs`,
      headers: { cookie, origin: "http://localhost:5173" },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().job.listingId).toBe(OLD_ID);
    expect(create.json().job.data.delivery.shipping).toBe(false);
    // Settle the background runner the route kicked before teardown.
    await parts.jobs.processJob(USER_ID, create.json().job.id as string);
  });
});
