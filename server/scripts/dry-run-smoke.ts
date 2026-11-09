// Sprint 3 dry-run smoke check: boots the real app wiring (config →
// job service) with a FAKE Marketplace driver and proves the default
// safety posture end to end over the HTTP API:
//
//   - a job created through the API is a DRY-RUN job (RELIST_DRY_RUN
//     default), even though the fake driver would happily "write";
//   - the job walks every state to done;
//   - the driver only ever receives dry-run calls — no real create,
//     no real delete;
//   - no history entry is recorded for a dry run.
//
// Run from server/:  npx tsx scripts/dry-run-smoke.ts
// Exits non-zero if any check fails.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import type { BrowserHandle, ContextLike, PageLike } from "../src/browserManager.js";
import { recovered, type StoredClone, type SyncedListing } from "../src/cloneTypes.js";
import type { Config } from "../src/config.js";
import type {
  CreateOutcome,
  DeleteOutcome,
  MarketplaceDriver,
  VerifyResult,
} from "../src/facebookDriver.js";
import type { ListingAvailability } from "../src/jobLogic.js";

const OLD_ID = "111";
const NEW_ID = "222";

const driverCalls: Array<{ kind: string; dryRun: boolean }> = [];

const fakeDriver: MarketplaceDriver = {
  async findPossibleDuplicate(): Promise<SyncedListing | null> {
    return null;
  },
  async createListing(_userId, _data, _photos, _video, options): Promise<CreateOutcome> {
    driverCalls.push({ kind: "create", dryRun: options.dryRun });
    return options.dryRun
      ? { kind: "dry_run" }
      : { kind: "created", listingId: NEW_ID, url: `https://www.facebook.com/marketplace/item/${NEW_ID}` };
  },
  async checkListing(): Promise<ListingAvailability> {
    return "available";
  },
  async listingStillListed(): Promise<boolean | "unknown"> {
    return true;
  },
  async checkOriginalUnchanged(): Promise<"unchanged"> {
    return "unchanged";
  },
  async verifyNewListing(_userId, listingId, _url, payloadHash) {
    return { state: "verified", listingId, sellerMatchesOwner: true, payloadHash };
  },
  async verifyRecreate(): Promise<VerifyResult> {
    return {
      oldGone: true,
      newListed: true,
      complete: true,
      newListingId: NEW_ID,
      newSellerId: "owner-1",
      newPayloadHash: "approved-hash",
    };
  },
  async deleteListing(_userId, _listingId, options): Promise<DeleteOutcome> {
    driverCalls.push({ kind: "delete", dryRun: options.dryRun });
    return options.dryRun ? { kind: "dry_run" } : { kind: "deleted" };
  },
};

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

let failures = 0;
function check(label: string, condition: boolean, detail = ""): void {
  if (!condition) {
    failures += 1;
  }
  console.log(`[${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), "relist-dryrun-"));
try {
  const config: Config = {
    port: 0,
    host: "127.0.0.1",
    dataDir,
    corsOrigin: "http://localhost:5173",
    cookieSecure: false,
    browserIgnoreCertErrors: false,
    // The whole point: dry-run comes from CONFIG DEFAULTS here — no
    // jobOptions override — exactly as the production server wires it.
    dryRun: true,
    jobPollIntervalMs: 15 * 60 * 1000,
    jobStuckAfterMs: 48 * 60 * 60 * 1000,
  };
  const parts = await buildApp({
    config,
    launcher: async () => unusedHandle(),
    driver: fakeDriver,
  });

  const register = await parts.app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name: "Smoke", email: "smoke@example.com", password: "password-123" },
  });
  const cookie = (register.cookies as Array<{ name: string; value: string }>)
    .map((entry) => `${entry.name}=${entry.value}`)
    .join("; ");
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
    headers: { cookie },
  });
  check("job created through the API", create.statusCode === 201, `status ${create.statusCode}`);
  const job = create.json().job as Record<string, any>;
  check("job is a dry-run job by default", job.dryRun === true);

  await parts.jobs.processJob(userId, job.id as string);
  const done = await parts.app.inject({
    method: "GET",
    url: `/api/jobs/${job.id}`,
    headers: { cookie },
  });
  const finalJob = done.json().job as Record<string, any>;
  check("dry-run job walked to done", finalJob.status === "done", `status ${finalJob.status}`);
  check(
    "driver only ever received dry-run calls",
    driverCalls.length === 2 && driverCalls.every((call) => call.dryRun),
    JSON.stringify(driverCalls),
  );
  const actions = (finalJob.audit as Array<{ action: string }>).map((event) => event.action);
  check(
    "audit log records the dry-run walk",
    actions.includes("create_dry_run") && actions.includes("delete_dry_run"),
    actions.join(", "),
  );

  const history = await parts.app.inject({
    method: "GET",
    url: "/api/history",
    headers: { cookie },
  });
  check(
    "no history recorded for a dry run",
    (history.json().history as unknown[]).length === 0,
  );

  await parts.app.close();
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll dry-run smoke checks passed.");
