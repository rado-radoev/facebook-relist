import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppParts } from "./app.js";
import type { BrowserHandle, ContextLike, PageLike } from "./browserManager.js";
import { recovered, type StoredClone, type SyncedListing } from "./cloneTypes.js";
import { loadConfig } from "./config.js";
import type {
  CreateOutcome,
  DeleteOutcome,
  MarketplaceDriver,
  VerifyResult,
} from "./facebookDriver.js";
import type { ListingAvailability } from "./jobLogic.js";

// The owner's dry-run switch, end to end at the server level: the
// RELIST_DRY_RUN env flows through loadConfig into the job service and
// is captured onto each created job's record. The driver here is a
// fake — no test ever writes to Facebook — so a dryRun:false job in
// this file only proves the switch is wired, never a live recreate.

const OLD_ID = "111";
const NEW_ID = "222";

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

function cookieHeader(cookies: Array<{ name: string; value: string }>): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

interface SeededApp {
  parts: AppParts;
  dataDir: string;
  job: Record<string, unknown>;
}

async function buildSeededApp(env: NodeJS.ProcessEnv): Promise<SeededApp> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "relist-dryrun-flow-"));
  const config = loadConfig({ DATA_DIR: dataDir, PORT: "0", ...env });
  const parts = await buildApp({
    config,
    launcher: async () => unusedHandle(),
    driver: new FakeDriver(),
  });

  const register = await parts.app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name: "Switch Tester", email: "switch@example.com", password: "password-123" },
  });
  expect(register.statusCode).toBe(201);
  const cookie = cookieHeader(register.cookies as Array<{ name: string; value: string }>);

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

  const create = await parts.app.inject({
    method: "POST",
    url: `/api/listings/${OLD_ID}/jobs`,
    headers: { cookie, origin: "http://localhost:5173" },
  });
  expect(create.statusCode).toBe(201);
  const jobId = create.json().job.id as string;
  const fetched = await parts.app.inject({
    method: "GET",
    url: `/api/jobs/${jobId}`,
    headers: { cookie, origin: "http://localhost:5173" },
  });
  expect(fetched.statusCode).toBe(200);
  expect(fetched.json().job.id).toBe(jobId);
  return { parts, dataDir, job: fetched.json().job as Record<string, unknown> };
}

describe("RELIST_DRY_RUN flows from env to the created job", () => {
  let live: SeededApp;
  let dry: SeededApp;

  beforeAll(async () => {
    live = await buildSeededApp({ RELIST_DRY_RUN: "0" });
    dry = await buildSeededApp({});
  });

  afterAll(async () => {
    await live.parts.app.close();
    await dry.parts.app.close();
    // The route's background job pass may still be flushing store
    // writes at close; retry the cleanup instead of racing it.
    await rm(live.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(dry.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("captures dryRun:false on a job created with RELIST_DRY_RUN=0", () => {
    expect(live.job.dryRun).toBe(false);
  });

  it("captures dryRun:true on a job created with the default env", () => {
    expect(dry.job.dryRun).toBe(true);
  });
});
