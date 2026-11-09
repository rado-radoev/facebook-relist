import { describe, expect, it, vi } from "vitest";
import { ScrapeFailedError, ScrapeService } from "./scrapeService.js";
import type { SyncedListing } from "./cloneTypes.js";
import type { BrowserManager } from "./browserManager.js";
import type { Store } from "./store.js";
import { SELLING_LIST_URL, type PageSnapshot } from "./snapshot.js";
import { sellingListSnapshot } from "./fixtures/index.js";

const existing: SyncedListing = {
  id: "old",
  title: "Good saved listing",
  price: "$10",
  status: "Available",
  statusText: "Active",
  photoUrl: "https://cdn.fixture.local/old.jpg",
  url: "https://www.facebook.com/marketplace/item/old",
  listedDate: null,
  syncedAt: "2026-01-01T00:00:00.000Z",
};

function makeService(snapshot: PageSnapshot) {
  const setListings = vi.fn(async () => undefined);
  const store = {
    getListings: () => [existing],
    setListings,
  } as unknown as Store;
  const browser = {
    ensureSession: async () => undefined,
    refreshStatus: async () => "connected",
    collectSnapshotAt: async (_userId: string, url: string) => snapshot.url === SELLING_LIST_URL ? snapshot : ({ ...snapshot, url }),
  } as unknown as BrowserManager;
  return { service: new ScrapeService(store, browser, "/synthetic-data", async () => Buffer.alloc(0)), setListings };
}

describe("ScrapeService sync validation", () => {
  it("keeps the last good synced listings and timestamp when extraction is not ready", async () => {
    const { service, setListings } = makeService({
      url: SELLING_LIST_URL,
      text: "Checkpoint",
      images: [],
      videos: [],
      sellingCards: [],
      surface: { kind: "unknown", listingId: null, readiness: "checkpoint" },
    });
    await expect(service.syncListings("user-1")).rejects.toBeInstanceOf(ScrapeFailedError);
    expect(setListings).not.toHaveBeenCalled();
  });

  it("rejects a selling-list snapshot with mismatched complete counts", async () => {
    const { service, setListings } = makeService({
      url: SELLING_LIST_URL,
      text: "Checkpoint",
      images: [],
      videos: [],
      sellingCards: [],
      surface: { kind: "selling_list", listingId: null, readiness: "ready" },
      completion: { state: "complete", expectedCount: 1, observedCount: 0 },
    });

    await expect(service.syncListings("user-1")).rejects.toBeInstanceOf(ScrapeFailedError);
    expect(setListings).not.toHaveBeenCalled();
  });

  it("does not persist a selling-list snapshot with a conflicting observed count", async () => {
    const snapshot = structuredClone(sellingListSnapshot);
    snapshot.completion = { state: "complete", expectedCount: 3, observedCount: 2 };
    const { service, setListings } = makeService(snapshot);

    await expect(service.syncListings("user-1")).rejects.toBeInstanceOf(ScrapeFailedError);
    expect(setListings).not.toHaveBeenCalled();
  });

  it("runs one user operation for full successful sync and persists empty success", async () => {
    const empty = structuredClone(sellingListSnapshot);
    empty.sellingCards = [];
    empty.completion = { state: "complete", expectedCount: 0, observedCount: 0 };
    const { service, setListings } = makeService(empty);
    const browser = (service as unknown as { browser: BrowserManager }).browser as BrowserManager & {
      withUserOperation?: (userId: string, operation: () => Promise<unknown>) => Promise<unknown>;
    };
    const withUserOperation = vi.fn(async (_userId: string, operation: () => Promise<unknown>) => operation());
    browser.withUserOperation = withUserOperation;
    const listings = await service.syncListings("user-1");
    expect(listings).toEqual([]);
    expect(withUserOperation).toHaveBeenCalledTimes(1);
    expect(setListings).toHaveBeenCalledWith("user-1", []);
  });
});
