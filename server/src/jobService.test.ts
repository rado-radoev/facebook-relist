import { mkdtemp, rm } from "node:fs/promises";
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
  duplicateId: string | null = null;
  createOutcome: CreateOutcome = { kind: "created", listingId: NEW_ID, url: `https://www.facebook.com/marketplace/item/${NEW_ID}` };
  deleteOutcome: DeleteOutcome = { kind: "deleted" };
  oldStillListed = true;
  verifyResult: VerifyResult = { oldGone: true, newListed: true };

  async findPossibleDuplicate(
    _userId: string,
    _fp: ListingFingerprint,
  ): Promise<SyncedListing | null> {
    this.calls.duplicateChecks += 1;
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

  async listingStillListed(): Promise<boolean> {
    return this.oldStillListed;
  }

  async verifyRecreate(): Promise<VerifyResult> {
    return this.verifyResult;
  }

  async deleteListing(
    _userId: string,
    listingId: string,
    options: { dryRun: boolean },
  ): Promise<DeleteOutcome> {
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
      photos: {
        urls: ["https://cdn.example/a/photo-1.jpg"],
        files: ["photo-1.jpg"],
        downloaded: 1,
      },
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

  it("refuses a second active job for the same user (per-user lock)", async () => {
    const service = makeService();
    await service.createJob(USER, OLD_ID);
    await expect(service.createJob(USER, OLD_ID)).rejects.toBeInstanceOf(ActiveJobExistsError);
  });

  it("refuses a job for a listing that is not in the user's synced list", async () => {
    const service = makeService();
    await expect(service.createJob(USER, "999")).rejects.toThrow(/not in this account's synced/);
  });

  it("keeps jobs isolated per user", async () => {
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    expect(service.getJob("someone-else", job.id)).toBeUndefined();
    expect(service.listJobs("someone-else")).toEqual([]);
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

  it("refuses to delete when the fresh delete-time check says in_review again", async () => {
    // Poll says available; the delete-time re-check says in_review.
    driver.availabilityQueue = ["available", "in_review"];
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    await service.processJob(USER, job.id);
    advanceClock(POLL_MS);
    const after = await service.processJob(USER, job.id);
    expect(after?.status).toBe("in_review");
    expect(driver.calls.delete).toHaveLength(0);
    expect((after?.audit ?? []).some((event) => event.action === "delete_deferred")).toBe(true);
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
    expect(after?.status).toBe("failed");
    expect(after?.error).toContain("Delete refused");
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
    driver.verifyResult = { oldGone: false, newListed: true };
    const service = makeService();
    const id = await jobInAvailableState(service);
    const job = service.getJob(USER, id);
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("Verification failed");
    expect(service.listHistory(USER)).toEqual([]);
  });
});

describe("duplicate guard", () => {
  it("adopts an already-created copy instead of creating a duplicate", async () => {
    driver.duplicateId = NEW_ID;
    driver.availabilityQueue = ["available", "available"];
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    const after = await service.processJob(USER, job.id);
    expect(driver.calls.create).toHaveLength(0);
    expect(after?.newListingId).toBe(NEW_ID);
    expect((after?.audit ?? []).some((event) => event.action === "duplicate_adopted")).toBe(true);
    advanceClock(POLL_MS);
    const done = await service.processJob(USER, job.id);
    expect(done?.status).toBe("done");
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

  it("resumes a job stuck mid-create by re-running the duplicate guard first", async () => {
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    // Force the persisted state a crash mid-create would leave behind.
    const crashed = service.getJob(USER, job.id);
    crashed!.status = "creating";
    await store.updateJob(crashed!);

    driver.duplicateId = NEW_ID; // the crashed attempt had actually posted it
    driver.availabilityQueue = ["available", "available"];
    const after = await service.processJob(USER, job.id);
    expect(driver.calls.create).toHaveLength(0);
    expect(after?.newListingId).toBe(NEW_ID);
    advanceClock(POLL_MS);
    const done = await service.processJob(USER, job.id);
    expect(done?.status).toBe("done");
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
});
