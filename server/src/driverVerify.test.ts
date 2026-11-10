import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserManager } from "./browserManager.js";
import { recovered, type StoredClone, type SyncedListing } from "./cloneTypes.js";
import {
  CREATE_LISTING_URL,
  FacebookDriver,
  UPLOAD_COUNT_SCRIPT,
  type CreateOutcome,
  type DeleteOutcome,
  type MarketplaceDriver,
  type PublishedListingVerification,
  type VerifyResult,
} from "./facebookDriver.js";
import type { ListingAvailability, ListingFingerprint } from "./jobLogic.js";
import { JobService } from "./jobService.js";
import type { CloneJobData } from "./jobTypes.js";
import {
  SELLING_LIST_URL,
  listingPageUrl,
  type PageSnapshot,
} from "./snapshot.js";
import { Store } from "./store.js";

const USER = "user-1";
const OLD_ID = "111";
const NEW_ID = "222";
const POLL_MS = 15 * 60 * 1000;
const STUCK_MS = 48 * 60 * 60 * 1000;
const noPace = async () => undefined;

// ---------------------------------------------------------------------------
// Fake BrowserManager: marker scripts are recognised by string, snapshots
// are routed by URL. No browser, no Facebook.

class FakeBrowser {
  /** Upload-count results, consumed in order; the last one repeats. */
  uploadCounts: Array<number | null> = [];
  uploadCountCalls = 0;
  publishClicked = false;
  uploads: string[][] = [];
  sellingSnapshot: PageSnapshot | null = null;
  listingSnapshots = new Map<string, PageSnapshot | null>();
  currentSnapshot: PageSnapshot | null = {
    url: listingPageUrl(NEW_ID),
    text: "",
    images: [],
    videos: [],
  };

  async ensureSession(): Promise<void> {}
  async refreshStatus(): Promise<string> {
    return "connected";
  }
  async collectSnapshotAt(_userId: string, url: string): Promise<PageSnapshot | null> {
    if (url === SELLING_LIST_URL) {
      return this.sellingSnapshot;
    }
    if (url === CREATE_LISTING_URL) {
      return { url, text: "", images: [], videos: [] };
    }
    const match = /\/marketplace\/item\/(\d+)/.exec(url);
    if (match) {
      return this.listingSnapshots.get(match[1]) ?? null;
    }
    return null;
  }
  async collectCurrentSnapshot(): Promise<PageSnapshot | null> {
    return this.currentSnapshot;
  }
  async uploadFiles(_userId: string, _selector: string, files: string[]): Promise<boolean> {
    this.uploads.push(files);
    return true;
  }
  async runScript(_userId: string, script: string): Promise<unknown> {
    if (script.includes("relist-upload-count")) {
      this.uploadCountCalls += 1;
      if (this.uploadCounts.length > 1) {
        return this.uploadCounts.shift() as number | null;
      }
      return this.uploadCounts[0] ?? null;
    }
    if (
      script.includes("relist-click-text") &&
      (script.includes('"publish"') || script.includes('"post"'))
    ) {
      this.publishClicked = true;
      return true;
    }
    return true;
  }
  async advanceWizard(): Promise<boolean> {
    return true;
  }
}

function makeDriver(browser: FakeBrowser): FacebookDriver {
  return new FacebookDriver(browser as unknown as BrowserManager, noPace);
}

function sellingSnapshot(cardIds: string[]): PageSnapshot {
  return {
    url: SELLING_LIST_URL,
    text: "",
    images: [],
    videos: [],
    surface: { kind: "selling_list", listingId: null, readiness: "ready" },
    completion: {
      state: "complete",
      expectedCount: cardIds.length,
      observedCount: cardIds.length,
    },
    sellingCards: cardIds.map((id) => ({
      href: listingPageUrl(id),
      title: "Widget",
      priceText: "$30",
      statusText: "Active",
      imageUrl: "https://cdn.example/a/photo-1.jpg",
    })),
  };
}

function listingSnapshot(
  id: string,
  slots: Array<{ identity: string; url: string }>,
  text = "",
): PageSnapshot {
  return {
    url: listingPageUrl(id),
    text,
    images: slots.map((slot) => slot.url),
    videos: [],
    surface: { kind: "listing", listingId: id, readiness: "ready" },
    gallery: {
      state: "complete",
      expectedCount: slots.length,
      observedCount: slots.length,
      videoPresence: "absent",
      slots,
    },
    form: {
      inputs: [],
      selects: [],
      checkboxes: [],
      switches: [],
      buttons: [{ label: "Edit listing", disabled: false }],
    },
  };
}

const CREATE_DATA: CloneJobData = {
  title: "Widget",
  price: "$30",
  description: "A fine widget.",
  category: "Toys & Games",
  condition: "Used - Like New",
  attributes: {},
  location: "San Diego, CA",
  delivery: {
    type: "Local pickup only",
    shipping: false,
    meetup: { public: false, doorPickup: false, doorDropoff: false },
  },
  photoFiles: ["photo-1.jpg", "photo-2.jpg"],
  photoUrls: ["https://cdn.example/a/photo-1.jpg", "https://cdn.example/a/photo-2.jpg"],
  videoFile: null,
};
const PHOTO_PATHS = ["/archive/photo-1.jpg", "/archive/photo-2.jpg"];

// ---------------------------------------------------------------------------

describe("create: upload count verification (blueprint §5 step 9)", () => {
  it("exports the marker-commented upload count script", () => {
    expect(UPLOAD_COUNT_SCRIPT).toContain("/* relist-upload-count */");
  });

  it("blocks without publishing when thumbnails settle below the photo count", async () => {
    const browser = new FakeBrowser();
    browser.uploadCounts = [1];
    const driver = makeDriver(browser);
    const outcome = await driver.createListing(USER, CREATE_DATA, PHOTO_PATHS, null, {
      dryRun: false,
    });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") {
      expect(outcome.reason).toContain("1 photo thumbnail");
      expect(outcome.reason).toContain("2 photos were uploaded");
    }
    expect(browser.uploadCountCalls).toBe(10);
    expect(browser.publishClicked).toBe(false);
  });

  it("returns unknown and does not publish when the count script yields no count", async () => {
    const browser = new FakeBrowser();
    browser.uploadCounts = [null];
    const driver = makeDriver(browser);
    const outcome = await driver.createListing(USER, CREATE_DATA, PHOTO_PATHS, null, {
      dryRun: false,
    });
    expect(outcome).toEqual({
      kind: "unknown",
      reason: "The photo uploads could not be verified on the create form.",
    });
    expect(browser.publishClicked).toBe(false);
  });

  it("publishes when the count reaches the expected number on a later poll", async () => {
    const browser = new FakeBrowser();
    browser.uploadCounts = [1, 2];
    const driver = makeDriver(browser);
    const outcome = await driver.createListing(USER, CREATE_DATA, PHOTO_PATHS, null, {
      dryRun: false,
    });
    expect(outcome).toEqual({
      kind: "created",
      listingId: NEW_ID,
      url: listingPageUrl(NEW_ID),
    });
    expect(browser.uploadCountCalls).toBe(2);
    expect(browser.publishClicked).toBe(true);
  });
});

describe("verifyPublishedListing (blueprint §5 step 10)", () => {
  const slots = [
    { identity: "media-1", url: "https://cdn.example/a/photo-1.jpg" },
    { identity: "media-2", url: "https://cdn.example/a/photo-2.jpg" },
  ];

  function browserWith(detail: PageSnapshot | null, cards: string[] = [NEW_ID]): FakeBrowser {
    const browser = new FakeBrowser();
    browser.sellingSnapshot = sellingSnapshot(cards);
    browser.listingSnapshots.set(NEW_ID, detail);
    return browser;
  }

  it("verifies when the card is listed and the gallery count and first identity match", async () => {
    const driver = makeDriver(browserWith(listingSnapshot(NEW_ID, slots)));
    const result = await driver.verifyPublishedListing(USER, NEW_ID, {
      photoCount: 2,
      firstPhotoIdentity: "media-1",
    });
    expect(result).toEqual({ state: "verified", reason: null });
  });

  it("is unknown when the gallery count does not match", async () => {
    const driver = makeDriver(browserWith(listingSnapshot(NEW_ID, slots.slice(0, 1))));
    const result = await driver.verifyPublishedListing(USER, NEW_ID, {
      photoCount: 2,
      firstPhotoIdentity: "media-1",
    });
    expect(result.state).toBe("unknown");
    expect(result.reason).toContain("gallery shows 1 photo");
  });

  it("is unknown when the first photo identity does not match", async () => {
    const wrongFirst = [
      { identity: "media-9", url: "https://cdn.example/a/photo-9.jpg" },
      slots[1],
    ];
    const driver = makeDriver(browserWith(listingSnapshot(NEW_ID, wrongFirst)));
    const result = await driver.verifyPublishedListing(USER, NEW_ID, {
      photoCount: 2,
      firstPhotoIdentity: "media-1",
    });
    expect(result.state).toBe("unknown");
    expect(result.reason).toContain("first photo does not match");
  });

  it("is unknown when the listing is absent from the selling list", async () => {
    const driver = makeDriver(browserWith(listingSnapshot(NEW_ID, slots), []));
    const result = await driver.verifyPublishedListing(USER, NEW_ID, {
      photoCount: 2,
      firstPhotoIdentity: "media-1",
    });
    expect(result.state).toBe("unknown");
    expect(result.reason).toContain("does not appear in the selling list");
  });

  it("is unknown when the selling list read is incomplete", async () => {
    const browser = browserWith(listingSnapshot(NEW_ID, slots));
    browser.sellingSnapshot = {
      url: SELLING_LIST_URL,
      text: "",
      images: [],
      videos: [],
      sellingCards: [],
    };
    const driver = makeDriver(browser);
    const result = await driver.verifyPublishedListing(USER, NEW_ID, { photoCount: 2 });
    expect(result.state).toBe("unknown");
  });
});

describe("verifyRecreate: delete verification (blueprint §6)", () => {
  it("does not call the old listing gone when its own page still reads available", async () => {
    const browser = new FakeBrowser();
    browser.sellingSnapshot = sellingSnapshot([NEW_ID]);
    browser.listingSnapshots.set(OLD_ID, listingSnapshot(OLD_ID, []));
    const driver = makeDriver(browser);
    const result = await driver.verifyRecreate(USER, OLD_ID, NEW_ID);
    expect(result.oldGone).toBe(false);
    expect(result.newListed).toBe(true);
    expect(result.complete).toBe(true);
  });

  it("confirms the old listing gone only when it is absent AND its page reports gone", async () => {
    const browser = new FakeBrowser();
    browser.sellingSnapshot = sellingSnapshot([NEW_ID]);
    browser.listingSnapshots.set(
      OLD_ID,
      listingSnapshot(OLD_ID, [], "This content isn't available right now."),
    );
    const driver = makeDriver(browser);
    const result = await driver.verifyRecreate(USER, OLD_ID, NEW_ID);
    expect(result.oldGone).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.newListed).toBe(true);
  });

  it("reports incomplete when the selling-list read is incomplete, even if the page is gone", async () => {
    const browser = new FakeBrowser();
    browser.sellingSnapshot = {
      url: SELLING_LIST_URL,
      text: "",
      images: [],
      videos: [],
      sellingCards: [],
    };
    browser.listingSnapshots.set(
      OLD_ID,
      listingSnapshot(OLD_ID, [], "This content isn't available right now."),
    );
    const driver = makeDriver(browser);
    const result = await driver.verifyRecreate(USER, OLD_ID, NEW_ID);
    expect(result.complete).toBe(false);
    expect(result.oldGone).toBe(false);
  });

  it("reports incomplete when the old listing's page reads unknown", async () => {
    const browser = new FakeBrowser();
    browser.sellingSnapshot = sellingSnapshot([NEW_ID]);
    // No seller-live buttons and no gone/review markers: availability
    // interprets this page as "unknown".
    const unknownPage = listingSnapshot(OLD_ID, [], "Some unrelated page text.");
    unknownPage.form = {
      inputs: [],
      selects: [],
      checkboxes: [],
      switches: [],
      buttons: [],
    };
    browser.listingSnapshots.set(OLD_ID, unknownPage);
    const driver = makeDriver(browser);
    const result = await driver.verifyRecreate(USER, OLD_ID, NEW_ID);
    expect(result.complete).toBe(false);
    expect(result.oldGone).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JobService wiring: an "available" listing whose photos do not verify
// must keep the job watching — never available, never deleting.

class WatchFakeDriver implements MarketplaceDriver {
  publishedState: "verified" | "unknown" = "unknown";
  publishedCalls: Array<{
    listingId: string;
    expected: { photoCount: number; firstPhotoIdentity?: string | null };
  }> = [];
  deleteCalls = 0;
  private approvedHash = "";

  async findPossibleDuplicate(
    _userId: string,
    _fp: ListingFingerprint,
  ): Promise<SyncedListing | null> {
    return null;
  }

  async createListing(
    _userId: string,
    _data: CloneJobData,
    _photoPaths: string[],
    _videoPath: string | null,
    options: { dryRun: boolean },
  ): Promise<CreateOutcome> {
    if (options.dryRun) {
      return { kind: "dry_run" };
    }
    return {
      kind: "created",
      listingId: NEW_ID,
      url: listingPageUrl(NEW_ID),
    };
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
    this.approvedHash = payloadHash;
    return { state: "verified", listingId, sellerMatchesOwner: true, payloadHash };
  }

  async verifyRecreate(): Promise<VerifyResult> {
    return {
      oldGone: true,
      newListed: true,
      complete: true,
      newListingId: NEW_ID,
      newSellerId: "owner-1",
      newPayloadHash: this.approvedHash,
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
    this.deleteCalls += 1;
    return { kind: "deleted" };
  }

  async verifyPublishedListing(
    _userId: string,
    listingId: string,
    expected: { photoCount: number; firstPhotoIdentity?: string | null },
  ): Promise<PublishedListingVerification> {
    this.publishedCalls.push({ listingId, expected });
    return this.publishedState === "verified"
      ? { state: "verified", reason: null }
      : { state: "unknown", reason: "The gallery could not be read yet." };
  }
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

describe("jobService watch step: photo verification gate", () => {
  let dataDir: string;
  let store: Store;
  let driver: WatchFakeDriver;
  let clock: Date;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "relist-driver-verify-"));
    store = new Store(dataDir);
    await store.load();
    driver = new WatchFakeDriver();
    clock = new Date("2026-11-09T12:00:00.000Z");
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
        url: listingPageUrl(OLD_ID),
        listedDate: "2026-10-01",
        syncedAt: "2026-11-09T10:00:00.000Z",
      },
    ]);
    await store.saveClone(USER, OLD_ID, completeClone());
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function makeService(): JobService {
    return new JobService(store, driver, dataDir, {
      dryRun: false,
      pollIntervalMs: POLL_MS,
      stuckAfterMs: STUCK_MS,
      now: () => clock,
      random: () => 0.5,
    });
  }

  it("keeps watching while photo verification is unknown, then proceeds once verified", async () => {
    const service = makeService();
    const job = await service.createJob(USER, OLD_ID);
    const created = await service.processJob(USER, job.id);
    expect(created?.status).toBe("in_review");
    expect(driver.publishedCalls).toHaveLength(0);

    // Available on its page, but the gallery does not verify yet:
    // the job must stay in review and the old listing must survive.
    clock = new Date(clock.getTime() + POLL_MS);
    const pending = await service.processJob(USER, job.id);
    expect(pending?.status).toBe("in_review");
    expect(driver.deleteCalls).toBe(0);
    expect(driver.publishedCalls).toEqual([
      {
        listingId: NEW_ID,
        expected: { photoCount: 1, firstPhotoIdentity: "media-1" },
      },
    ]);
    expect(
      (pending?.audit ?? []).some(
        (event) => event.action === "poll_photo_verification_pending",
      ),
    ).toBe(true);

    // Once the gallery verifies, the job proceeds through delete to done.
    driver.publishedState = "verified";
    clock = new Date(clock.getTime() + POLL_MS);
    const done = await service.processJob(USER, job.id);
    expect(done?.status).toBe("done");
    expect(driver.deleteCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("verifyNewListing: replacement attestation from page evidence", () => {
  const slots = [
    { identity: "media-1", url: "https://cdn.example/a/photo-1.jpg" },
    { identity: "media-2", url: "https://cdn.example/a/photo-2.jpg" },
  ];

  it("verifies when the exact id is in the owner's complete selling list and its page is live with a complete gallery", async () => {
    const browser = new FakeBrowser();
    browser.sellingSnapshot = sellingSnapshot([OLD_ID, NEW_ID]);
    browser.listingSnapshots.set(NEW_ID, listingSnapshot(NEW_ID, slots));
    const driver = makeDriver(browser);
    const result = await driver.verifyNewListing(USER, NEW_ID, listingPageUrl(NEW_ID), "approved-hash");
    expect(result).toEqual({
      state: "verified",
      listingId: NEW_ID,
      sellerMatchesOwner: true,
      payloadHash: "approved-hash",
    });
  });

  it("stays unknown when the id is absent from the selling list (no seller attestation)", async () => {
    const browser = new FakeBrowser();
    browser.sellingSnapshot = sellingSnapshot([OLD_ID]);
    browser.listingSnapshots.set(NEW_ID, listingSnapshot(NEW_ID, slots));
    const driver = makeDriver(browser);
    const result = await driver.verifyNewListing(USER, NEW_ID, listingPageUrl(NEW_ID), "approved-hash");
    expect(result.state).toBe("unknown");
    expect(result.sellerMatchesOwner).toBeNull();
  });

  it("stays unknown while the new listing is still in review", async () => {
    const browser = new FakeBrowser();
    browser.sellingSnapshot = sellingSnapshot([OLD_ID, NEW_ID]);
    browser.listingSnapshots.set(
      NEW_ID,
      listingSnapshot(NEW_ID, slots, "Your listing is in review"),
    );
    const driver = makeDriver(browser);
    const result = await driver.verifyNewListing(USER, NEW_ID, listingPageUrl(NEW_ID), "approved-hash");
    expect(result.state).toBe("unknown");
  });

  it("stays unknown when the gallery is incomplete", async () => {
    const browser = new FakeBrowser();
    browser.sellingSnapshot = sellingSnapshot([OLD_ID, NEW_ID]);
    const incomplete = listingSnapshot(NEW_ID, slots);
    incomplete.gallery = {
      state: "incomplete",
      expectedCount: 3,
      observedCount: 2,
      videoPresence: "absent",
      slots,
    };
    browser.listingSnapshots.set(NEW_ID, incomplete);
    const driver = makeDriver(browser);
    const result = await driver.verifyNewListing(USER, NEW_ID, listingPageUrl(NEW_ID), "approved-hash");
    expect(result.state).toBe("unknown");
  });
});
