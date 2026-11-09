import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { missing, recovered, type StoredClone, type SyncedListing } from "./cloneTypes.js";
import type {
  CreateOutcome,
  DeleteOutcome,
  MarketplaceDriver,
  VerifyResult,
} from "./facebookDriver.js";
import { FacebookDriver } from "./facebookDriver.js";
import type { BrowserManager } from "./browserManager.js";
import type { ListingAvailability, ListingFingerprint } from "./jobLogic.js";
import {
  ActiveJobExistsError,
  JobIncompleteError,
  JobService,
} from "./jobService.js";
import type { CloneJobData } from "./jobTypes.js";
import { Store } from "./store.js";

const USER = "user-1";
const OLD_ID = "111";
const NEW_ID = "222";
const POLL_MS = 15 * 60 * 1000;
const STUCK_MS = 48 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Fake driver: scriptable, records every call. No Facebook anywhere near it.

interface DriverCalls {
  create: Array<{ data: CloneJobData; dryRun: boolean }>;
  delete: Array<{ listingId: string; dryRun: boolean }>;
  check: string[];
  duplicateChecks: number;
}

class FakeDriver implements MarketplaceDriver {
  readonly calls: DriverCalls = { create: [], delete: [], check: [], duplicateChecks: 0 };
  /** Availability results, consumed in order; the last one repeats. */
  availabilityQueue: ListingAvailability[] = ["available"];
  duplicateLookupUnknown = false;
  originalLookupUnknown = false;
  duplicateId: string | null = null;
  createOutcome: CreateOutcome = { kind: "created", listingId: NEW_ID, url: `https://www.facebook.com/marketplace/item/${NEW_ID}` };
  deleteOutcome: DeleteOutcome = { kind: "deleted" };
  oldStillListed: boolean | "unknown" = true;
  verifyResult: VerifyResult = {
    oldGone: true,
    newListed: true,
    complete: true,
    newListingId: NEW_ID,
    newSellerId: "owner-1",
    newPayloadHash: "approved-hash",
  };
  originalCheck: "unchanged" | "changed" | "unknown" = "unchanged";
  replacementCheck: {
    state: "verified" | "unknown";
    listingId: string | null;
    sellerMatchesOwner: boolean | null;
    payloadHash: string | null;
  } = { state: "verified", listingId: NEW_ID, sellerMatchesOwner: true, payloadHash: "approved-hash" };
  verifiedPayloadHash = "";
  onDelete: (() => Promise<void>) | undefined;

  async findPossibleDuplicate(
    _userId: string,
    _fp: ListingFingerprint,
  ): Promise<SyncedListing | null | { kind: "unknown"; reason: string }> {
    this.calls.duplicateChecks += 1;
    if (this.duplicateLookupUnknown) {
      return { kind: "unknown", reason: "Incomplete synthetic selling-list read." };
    }
    if (!this.duplicateId) {
      return null;
    }
    return {
      id: this.duplicateId,
      title: "Widget",
      price: "$30",
      status: "Available",
      statusText: "Active",
      photoUrl: "https://cdn.example/a/photo-1.jpg",
      url: `https://www.facebook.com/marketplace/item/${this.duplicateId}`,
      listedDate: "2026-11-09",
      syncedAt: new Date().toISOString(),
    };
  }

  async createListing(
    _userId: string,
    data: CloneJobData,
    _photoPaths: string[],
    _videoPath: string | null,
    options: { dryRun: boolean },
  ): Promise<CreateOutcome> {
    this.calls.create.push({ data, dryRun: options.dryRun });
    if (options.dryRun) {
      return { kind: "dry_run" };
    }
    return this.createOutcome;
  }

  async checkListing(_userId: string, listingId: string): Promise<ListingAvailability> {
    this.calls.check.push(listingId);
    if (this.availabilityQueue.length > 1) {
      return this.availabilityQueue.shift() as ListingAvailability;
    }
    return this.availabilityQueue[0];
  }

  async listingStillListed(): Promise<boolean | "unknown"> {
    return this.originalLookupUnknown ? "unknown" : this.oldStillListed;
  }

  async verifyNewListing(
    _userId: string,
    listingId: string,
    _url: string,
    approvedPayloadHash: string,
  ): Promise<typeof this.replacementCheck> {
    this.verifiedPayloadHash = approvedPayloadHash;
    return {
      ...this.replacementCheck,
      listingId: this.replacementCheck.listingId ?? listingId,
      payloadHash: this.replacementCheck.payloadHash === "approved-hash"
        ? approvedPayloadHash
        : this.replacementCheck.payloadHash,
    };
  }

  async checkOriginalUnchanged(): Promise<"unchanged" | "changed" | "unknown"> {
    return this.originalCheck;
  }

  async verifyRecreate(): Promise<VerifyResult> {
    return { ...this.verifyResult, newPayloadHash: this.verifyResult.newPayloadHash === "approved-hash" ? this.verifiedPayloadHash : this.verifyResult.newPayloadHash };
  }

  async deleteListing(
    _userId: string,
    listingId: string,
    options: { dryRun: boolean },
  ): Promise<DeleteOutcome> {
    await this.onDelete?.();
    this.calls.delete.push({ listingId, dryRun: options.dryRun });
    if (options.dryRun) {
      return { kind: "dry_run" };
    }
    return this.deleteOutcome;
  }
}

// ---------------------------------------------------------------------------

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
      attributes: recovered({ Color: "Green" }, "edit_form"),
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
let store: Store;
let driver: FakeDriver;
let clock: Date;

function makeService(dryRun = false): JobService {
  return new JobService(store, driver, dataDir, {
    dryRun,
    pollIntervalMs: POLL_MS,
    stuckAfterMs: STUCK_MS,
    now: () => clock,
    random: () => 0.5, // jitter factor exactly 1.0
  });
}

async function seedUser(): Promise<void> {
  const mediaDir = path.join(dataDir, "archive", USER, OLD_ID);
  await mkdir(mediaDir, { recursive: true });
  await writeFile(path.join(mediaDir, "photo-1.jpg"), "approved generated image bytes");
  await store.setListings(USER, [
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
  await store.saveClone(USER, OLD_ID, completeClone());
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "relist-jobs-"));
  store = new Store(dataDir);
  await store.load();
  driver = new FakeDriver();
  clock = new Date("2026-11-09T12:00:00.000Z");
  await seedUser();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function advanceClock(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

// ---------------------------------------------------------------------------

describe("job creation guards", () => {
  it("refuses a job while a clone field is still missing/unpicked", async () => {
    const clone = completeClone();
    clone.recovery!.condition = missing<string>("Not present anywhere.");
    await store.saveClone(USER, OLD_ID, clone);
    const service = makeService();
    await expect(service.createJob(USER, OLD_ID)).rejects.toBeInstanceOf(JobIncompleteError);
    await expect(service.createJob(USER, OLD_ID)).rejects.toMatchObject({
      missing: ["condition"],
    });
  });

  it("returns the existing job for an idempotent same-listing create", async () => {
    const service = makeService();
    const first = await service.createJob(USER, OLD_ID);
    const second = await service.createJob(USER, OLD_ID);
    expect(second.id).toBe(first.id);
  });

  it("refuses a job for a listing that is not in the user's synced list", async () => {
    const service = makeService();
    await expect(service.createJob(USER, "999")).rejects.toThrow(/not in this account's synced/);
  });

  it("atomically coalesces concurrent creates for the same user and original listing", async () => {
    const service = makeService();
    const jobs = await Promise.all([
      service.createJob(USER, OLD_ID),
      service.createJob(USER, OLD_ID),
    ]);
    expect(jobs[0].id).toBe(jobs[1].id);
    expect(store.listJobs(USER)).toHaveLength(1);
  });

  it("uses the shared user-operation coordinator to serialize creates across service instances", async () => {
    const tails = new Map<string, Promise<void>>();
    const withUserOperation = async <T>(userId: string, operation: () => Promise<T>): Promise<T> => {
      const previous = tails.get(userId) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => { release = resolve; });
      tails.set(userId, previous.then(() => current));
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    };
    const options = {
      dryRun: false,
      pollIntervalMs: POLL_MS,
      stuckAfterMs: STUCK_MS,
      now: () => clock,
      random: () => 0.5,
      withUserOperation,
    };
    const firstService = new JobService(store, driver, dataDir, options);
    const secondService = new JobService(store, driver, dataDir, options);
    const [first, second] = await Promise.all([
      firstService.createJob(USER, OLD_ID),
      secondService.createJob(USER, OLD_ID),
    ]);
    expect(first.id).toBe(second.id);
    expect(store.listJobs(USER)).toHaveLength(1);
  });

  it("does not adopt a weak duplicate after an ambiguous create outcome", async () => {
    driver.createOutcome = { kind: "unknown", reason: "The submit result was not readable." };
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    await service.processJob(USER, job.id);
    expect(service.getJob(USER, job.id)?.status).toBe("needs_input");
    driver.duplicateId = NEW_ID;
    await service.processJob(USER, job.id);
    expect(driver.calls.create).toHaveLength(1);
    expect(driver.calls.duplicateChecks).toBe(1);
  });

  it("does not create when duplicate-check reads are incomplete", async () => {
    driver.duplicateLookupUnknown = true;
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    const after = await service.processJob(USER, job.id);
    expect(after?.status).toBe("needs_input");
    expect(after?.newListingId).toBeNull();
    expect(driver.calls.create).toHaveLength(0);
  });

  it("requires reconciliation when a created outcome URL identifies another listing", async () => {
    driver.createOutcome = {
      kind: "created",
      listingId: NEW_ID,
      url: `https://www.facebook.com/marketplace/item/${OLD_ID}`,
    };
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    const after = await service.processJob(USER, job.id);
    expect(after?.status).toBe("needs_input");
    expect(after?.newListingId).toBeNull();
    expect(driver.calls.create).toHaveLength(1);
  });

  it("stops before create when approved archive media changes", async () => {
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    const mediaPath = path.join(dataDir, "archive", USER, OLD_ID, "photo-1.jpg");
    await mkdir(path.dirname(mediaPath), { recursive: true });
    await writeFile(mediaPath, "approved generated image bytes");
    await writeFile(mediaPath, "changed bytes");
    const after = await service.processJob(USER, job.id);
    expect(after?.status).toBe("needs_input");
    expect(driver.calls.create).toHaveLength(0);
  });

  it("persists delete intent before calling the driver", async () => {
    let intentPersisted = false;
    driver.onDelete = async () => {
      const job = store.listJobs(USER)[0];
      intentPersisted = job.status === "delete_intent" && job.audit.some((event) => event.action === "delete_intent");
    };
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    await service.processJob(USER, job.id);
    advanceClock(POLL_MS);
    await service.processJob(USER, job.id);
    expect(intentPersisted).toBe(true);
  });

  it("turns an ambiguous delete exception into durable reconciliation without retry", async () => {
    let attempts = 0;
    driver.onDelete = async () => {
      attempts += 1;
      throw new Error("browser disconnected after delete click");
    };
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    await service.processJob(USER, job.id);
    advanceClock(POLL_MS);
    const after = await service.processJob(USER, job.id);
    expect(after?.status).toBe("needs_input");
    expect(after?.audit.some((event) => event.action === "delete_reconciliation_required")).toBe(true);
    expect(attempts).toBe(1);
    await service.processJob(USER, job.id);
    expect(attempts).toBe(1);
  });

  it("requires reconciliation when approved media changed before create", async () => {
    const service = makeService();
    const archiveDir = path.join(dataDir, "archive", USER, OLD_ID);
    await mkdir(archiveDir, { recursive: true });
    await writeFile(path.join(archiveDir, "photo-1.jpg"), "original-bytes");
    const job = await service.createJob(USER, OLD_ID);
    await writeFile(path.join(archiveDir, "photo-1.jpg"), "tampered");
    await service.processJob(USER, job.id);
    expect(service.getJob(USER, job.id)?.status).toBe("needs_input");
    expect(driver.calls.create).toHaveLength(0);
  });

  it("marks alerts as durable actionable needs-input state", async () => {
    driver.createOutcome = { kind: "unknown", reason: "Submit response was lost." };
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    await service.processJob(USER, job.id);
    const reopened = new Store(dataDir);
    await reopened.load();
    expect(reopened.getJob(USER, job.id)?.status).toBe("needs_input");
    expect(reopened.getJob(USER, job.id)?.alert).toMatch(/reconcil/i);
  });
});

describe("happy path: create → watch → delete → verified → done", () => {
  it("walks the full §3 order and records history", async () => {
    driver.availabilityQueue = ["in_review", "available", "available"];
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    expect(job.status).toBe("queued");
    expect(job.dryRun).toBe(false);

    // First run: duplicate guard, create, enters review.
    const after1 = await service.processJob(USER, job.id);
    expect(after1?.status).toBe("in_review");
    expect(after1?.newListingId).toBe(NEW_ID);
    expect(driver.calls.duplicateChecks).toBe(1);
    expect(driver.calls.create).toHaveLength(1);
    expect(driver.calls.create[0].dryRun).toBe(false);
    expect(driver.calls.delete).toHaveLength(0);

    // Poll not yet due: nothing happens.
    const early = await service.processJob(USER, job.id);
    expect(early?.status).toBe("in_review");
    expect(driver.calls.check).toHaveLength(0);

    // Due: still in review → rescheduled, old listing untouched.
    advanceClock(POLL_MS);
    const after2 = await service.processJob(USER, job.id);
    expect(after2?.status).toBe("in_review");
    expect(after2?.pollCount).toBe(1);
    expect(driver.calls.delete).toHaveLength(0);

    // Due again: available → fresh delete-time check → delete → verify → done.
    advanceClock(POLL_MS);
    const after3 = await service.processJob(USER, job.id);
    expect(after3?.status).toBe("done");
    expect(driver.calls.delete).toEqual([{ listingId: OLD_ID, dryRun: false }]);
    expect(after3?.historyRecorded).toBe(true);

    const history = service.listHistory(USER);
    expect(history).toHaveLength(1);
    expect(history[0].oldListingId).toBe(OLD_ID);
    expect(history[0].newListingId).toBe(NEW_ID);

    const actions = (after3?.audit ?? []).map((event) => event.action);
    expect(actions).toContain("created");
    expect(actions).toContain("poll_available");
    expect(actions).toContain("deleted");
    expect(actions).toContain("verified");
    expect(actions).toContain("done");
  });
});

describe("watch step", () => {
  it("goes stuck after 48h in review and never deletes the old listing", async () => {
    driver.availabilityQueue = ["in_review"];
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    await service.processJob(USER, job.id);

    // Poll every interval for just over 48h.
    for (let i = 0; i < 200; i += 1) {
      advanceClock(POLL_MS);
      const current = await service.processJob(USER, job.id);
      if (current?.status === "stuck") {
        break;
      }
    }
    const stuck = service.getJob(USER, job.id);
    expect(stuck?.status).toBe("stuck");
    expect(stuck?.alert).toContain("has NOT been deleted");
    expect(driver.calls.delete).toHaveLength(0);
    expect(service.listHistory(USER)).toEqual([]);
  });

  it("fails safely if the new listing disappears during review", async () => {
    driver.availabilityQueue = ["gone"];
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    await service.processJob(USER, job.id);
    advanceClock(POLL_MS);
    const after = await service.processJob(USER, job.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toContain("has NOT been deleted");
    expect(driver.calls.delete).toHaveLength(0);
  });

  it("marks an over-deadline review stuck when the availability read errors", async () => {
    driver.availabilityQueue = ["in_review"];
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    await service.processJob(USER, job.id);
    clock = new Date(Date.parse(job.inReviewSince!) + STUCK_MS + 1);
    driver.checkListing = async () => {
      throw new Error("synthetic read failure");
    };

    const after = await service.processJob(USER, job.id);

    expect(after?.status).toBe("stuck");
    expect(after?.alert).toMatch(/over 48 hours/i);
    expect(driver.calls.delete).toHaveLength(0);
  });
});

describe("delete guards", () => {
  async function jobInAvailableState(service: JobService): Promise<string> {
    driver.availabilityQueue = ["available", "available"];
    const job = await service.createJob(USER, OLD_ID);
    await service.processJob(USER, job.id); // create → in_review
    advanceClock(POLL_MS);
    const watched = await service.processJob(USER, job.id); // → available → delete → done
    return watched?.id ?? job.id;
  }

  it("requires reconciliation if the original listing changes before delete", async () => {
    driver.availabilityQueue = ["available", "available"];
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    await service.processJob(USER, job.id);
    advanceClock(POLL_MS);
    await store.setListings(USER, [{
      ...store.getListings(USER)[0],
      title: "Widget edited elsewhere",
    }]);
    driver.originalCheck = "changed";
    const after = await service.processJob(USER, job.id);
    expect(after?.status).toBe("needs_input");
    expect(driver.calls.delete).toHaveLength(0);
  });

  it("requires reconciliation when original listing details are incomplete", async () => {
    driver.availabilityQueue = ["available", "available"];
    driver.originalLookupUnknown = true;
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    await service.processJob(USER, job.id);
    advanceClock(POLL_MS);
    const after = await service.processJob(USER, job.id);
    expect(after?.status).toBe("needs_input");
    expect(driver.calls.delete).toHaveLength(0);
  });

  it("stops for reconciliation when the fresh delete-time availability is unknown", async () => {
    driver.availabilityQueue = ["available", "unknown"];
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    await service.processJob(USER, job.id);
    advanceClock(POLL_MS);
    const after = await service.processJob(USER, job.id);
    expect(after?.status).toBe("needs_input");
    expect(after?.alert).toMatch(/could not be confirmed/i);
    expect(driver.calls.delete).toHaveLength(0);
  });

  it("does not delete unless exact replacement, seller, and approved payload verify", async () => {
    driver.availabilityQueue = ["available", "available"];
    driver.replacementCheck = {
      state: "verified",
      listingId: "333",
      sellerMatchesOwner: true,
      payloadHash: "different-payload",
    };
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    await service.processJob(USER, job.id);
    advanceClock(POLL_MS);
    const after = await service.processJob(USER, job.id);
    expect(after?.status).toBe("needs_input");
    expect(after?.alert).toMatch(/manual reconciliation/i);
    expect(driver.calls.delete).toHaveLength(0);
  });

  it("requires reconciliation when old-listing presence cannot be read", async () => {
    driver.availabilityQueue = ["available", "available"];
    driver.oldStillListed = "unknown";
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    await service.processJob(USER, job.id);
    advanceClock(POLL_MS);
    const after = await service.processJob(USER, job.id);
    expect(after?.status).toBe("needs_input");
    expect(after?.alert).toMatch(/original listing presence could not be confirmed/i);
    expect(driver.calls.delete).toHaveLength(0);
  });

  it("refuses to delete when the new listing id matches the old listing id", async () => {
    driver.createOutcome = {
      kind: "created",
      listingId: OLD_ID,
      url: `https://www.facebook.com/marketplace/item/${OLD_ID}`,
    };
    driver.availabilityQueue = ["available"];
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    await service.processJob(USER, job.id);
    advanceClock(POLL_MS);
    const after = await service.processJob(USER, job.id);
    expect(after?.status).toBe("needs_input");
    expect(after?.alert).toMatch(/did not identify a distinct listing/i);
    expect(driver.calls.delete).toHaveLength(0);
  });

  it("skips the delete when the old listing is already gone, and verifies", async () => {
    driver.oldStillListed = false;
    const service = makeService();
    const id = await jobInAvailableState(service);
    const job = service.getJob(USER, id);
    expect(job?.status).toBe("done");
    expect(driver.calls.delete).toHaveLength(0);
    expect((job?.audit ?? []).some((event) => event.action === "old_already_gone")).toBe(true);
  });

  it("fails honestly when post-delete verification does not confirm", async () => {
    driver.verifyResult = {
      oldGone: false,
      newListed: true,
      complete: true,
      newListingId: NEW_ID,
      newSellerId: "owner-1",
      newPayloadHash: "approved-hash",
    };
    const service = makeService();
    const id = await jobInAvailableState(service);
    const job = service.getJob(USER, id);
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("Verification failed");
    expect(service.listHistory(USER)).toEqual([]);
  });
});

describe("duplicate guard", () => {
  it("requires reconciliation for a possible duplicate rather than adopting it", async () => {
    driver.duplicateId = NEW_ID;
    driver.availabilityQueue = ["available", "available"];
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    const after = await service.processJob(USER, job.id);
    expect(driver.calls.create).toHaveLength(0);
    expect(after?.status).toBe("needs_input");
    expect(after?.newListingId).toBeNull();
    expect((after?.audit ?? []).some((event) => event.action === "duplicate_reconciliation_required")).toBe(true);
  });
});

describe("resume after restart", () => {
  it("resumes an in-review job from the persisted store with a fresh service", async () => {
    driver.availabilityQueue = ["available", "available"];
    const service1 = makeService();
    const job = await service1.createJob(USER, OLD_ID);
    await service1.processJob(USER, job.id);
    expect(service1.getJob(USER, job.id)?.status).toBe("in_review");

    // Simulate a server restart: a brand-new Store over the same data
    // dir and a brand-new JobService — only the persisted record carries.
    const store2 = new Store(dataDir);
    await store2.load();
    const service2 = new JobService(store2, driver, dataDir, {
      dryRun: false,
      pollIntervalMs: POLL_MS,
      stuckAfterMs: STUCK_MS,
      now: () => clock,
      random: () => 0.5,
    });
    advanceClock(POLL_MS);
    await service2.processDueJobs();
    expect(service2.getJob(USER, job.id)?.status).toBe("done");
    expect(service2.listHistory(USER)).toHaveLength(1);
  });

  it("does not duplicate durable history when a completion write is replayed", async () => {
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    job.status = "deleting";
    job.newListingId = NEW_ID;
    job.newListingUrl = `https://www.facebook.com/marketplace/item/${NEW_ID}`;
    await store.updateJob(job);
    await store.addHistory(USER, {
      id: "history-existing",
      jobId: job.id,
      title: job.listingTitle,
      oldListingId: OLD_ID,
      oldListingUrl: job.oldListingUrl,
      newListingId: NEW_ID,
      newListingUrl: job.newListingUrl,
      completedAt: clock.toISOString(),
      suppliedFields: job.suppliedFields,
    });
    await service.processJob(USER, job.id);
    expect(service.listHistory(USER).filter((entry) => entry.jobId === job.id)).toHaveLength(1);
  });

  it("resumes a job interrupted in creating as reconciliation, never retries or adopts", async () => {
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    const crashed = service.getJob(USER, job.id);
    crashed!.status = "creating";
    await store.updateJob(crashed!);
    driver.duplicateId = NEW_ID;
    const after = await service.processJob(USER, job.id);
    expect(after?.status).toBe("needs_input");
    expect(after?.newListingId).toBeNull();
    expect(driver.calls.create).toHaveLength(0);
    expect(driver.calls.duplicateChecks).toBe(0);
  });

  it("does not duplicate a history row when restart replays the finish step", async () => {
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    await service.processJob(USER, job.id);
    const persisted = service.getJob(USER, job.id)!;
    persisted.status = "deleting";
    persisted.historyRecorded = false;
    driver.verifiedPayloadHash = persisted.approvedPayloadHash;
    await store.updateJob(persisted);
    await store.addHistory(USER, {
      id: "history-before-crash",
      jobId: job.id,
      title: persisted.listingTitle,
      oldListingId: persisted.listingId,
      oldListingUrl: persisted.oldListingUrl,
      newListingId: persisted.newListingId!,
      newListingUrl: persisted.newListingUrl!,
      completedAt: clock.toISOString(),
      suppliedFields: persisted.suppliedFields,
    });
    const resumed = makeService();
    await resumed.processJob(USER, job.id);
    expect(resumed.listHistory(USER).filter((entry) => entry.jobId === job.id)).toHaveLength(1);
  });
});

describe("dry-run jobs", () => {
  it("walks every step but never performs a real create or delete, and records no history", async () => {
    const service = makeService(true);
    const job = await service.createJob(USER, OLD_ID);
    expect(job.dryRun).toBe(true);

    const after = await service.processJob(USER, job.id);
    expect(after?.status).toBe("done");
    // The driver only ever saw dry-run calls.
    expect(driver.calls.create).toEqual([expect.objectContaining({ dryRun: true })]);
    expect(driver.calls.delete).toEqual([{ listingId: OLD_ID, dryRun: true }]);
    // No real availability polling happened and no history was recorded.
    expect(driver.calls.check).toHaveLength(0);
    expect(service.listHistory(USER)).toEqual([]);
    const actions = (after?.audit ?? []).map((event) => event.action);
    expect(actions).toContain("create_dry_run");
    expect(actions).toContain("watch_simulated");
    expect(actions).toContain("delete_dry_run");
    expect(actions).toContain("verify_simulated");
  });

  it("describes dry-run create as skipped rather than claiming the Facebook form was filled", async () => {
    const service = makeService(true);
    const job = await service.createJob(USER, OLD_ID);
    const completed = await service.processJob(USER, job.id);
    const createAudit = completed?.audit.find((event) => event.action === "create_dry_run");
    expect(createAudit?.detail).toMatch(/skipped.*browser create flow/i);
    expect(createAudit?.detail).not.toMatch(/form was filled/i);
  });
});

describe("production Facebook driver mutation gate", () => {
  it("does not trust non-empty selling cards without positive surface and completion evidence", async () => {
    const browser = {
      ensureSession: async () => undefined,
      refreshStatus: async () => "connected",
      collectSnapshotAt: async () => ({
        url: "https://www.facebook.com/marketplace/you/selling",
        text: "",
        images: [],
        videos: [],
        sellingCards: [{
          href: "https://www.facebook.com/marketplace/item/222",
          title: "Widget",
          priceText: "$30",
          statusText: "Active",
          imageUrl: "https://cdn.example/a/photo-1.jpg",
        }],
      }),
    } as unknown as BrowserManager;
    const driver = new FacebookDriver(browser);
    const result = await driver.findPossibleDuplicate(USER, {
      listingId: OLD_ID,
      title: "widget",
      price: "30",
      photoKey: "photo-1.jpg",
    });
    expect(result).toMatchObject({ kind: "unknown" });
  });

  it("does not treat an incomplete selling-list read as an empty duplicate set", async () => {
    const browser = {
      ensureSession: async () => undefined,
      refreshStatus: async () => "connected",
      collectSnapshotAt: async () => ({
        url: "https://www.facebook.com/marketplace/you/selling",
        text: "",
        images: [],
        videos: [],
        sellingCards: [],
      }),
    } as unknown as BrowserManager;
    const driver = new FacebookDriver(browser);
    const result = await driver.findPossibleDuplicate(USER, {
      listingId: OLD_ID,
      title: "widget",
      price: "30",
      photoKey: "photo-1.jpg",
    });
    expect(result).toMatchObject({ kind: "unknown" });
  });

  it("refuses a requested live create before touching the browser", async () => {
    let touched = false;
    const browser = {
      ensureSession: async () => { touched = true; },
      refreshStatus: async () => { touched = true; return "connected"; },
      collectSnapshotAt: async () => { touched = true; return null; },
    } as unknown as BrowserManager;
    const driver = new FacebookDriver(browser);
    const outcome = await driver.createListing(
      USER,
      {
        title: "Widget",
        price: "$30",
        description: "A fine widget.",
        category: "Toys & Games",
        condition: "New",
        attributes: {},
        location: "San Diego, CA",
        delivery: { type: "Local pickup only", shipping: false, meetup: { public: false, doorPickup: false, doorDropoff: false } },
        photoFiles: ["photo-1.jpg"],
        photoUrls: ["https://cdn.example/a/photo-1.jpg"],
        videoFile: null,
      },
      [],
      null,
      { dryRun: false },
    );
    expect(outcome.kind).toBe("blocked");
    expect(touched).toBe(false);
  });

  it("never opens a destructive delete path, including in dry run", async () => {
    let touched = false;
    const browser = {
      ensureSession: async () => { touched = true; },
      refreshStatus: async () => { touched = true; return "connected"; },
      collectSnapshotAt: async () => { touched = true; return null; },
    } as unknown as BrowserManager;
    const driver = new FacebookDriver(browser);
    const dryRun = await driver.deleteListing(USER, OLD_ID, { dryRun: true });
    const live = await driver.deleteListing(USER, OLD_ID, { dryRun: false });
    expect(dryRun.kind).toBe("dry_run");
    expect(live.kind).toBe("not_deleted");
    expect(touched).toBe(false);
  });
});
