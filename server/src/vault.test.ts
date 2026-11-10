import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  recoverCloneData,
  type ArchiveWriter,
  type FileDownloader,
} from "./recovery.js";
import { decodeImageInfo } from "./imageDecode.js";
import { ScrapeService } from "./scrapeService.js";
import type { BrowserManager } from "./browserManager.js";
import type { Store } from "./store.js";
import type { PageSnapshot } from "./snapshot.js";
import {
  HOT_WHEELS_ID,
  SWITCHES_ID,
  hotWheelsEditSnapshot,
  hotWheelsListingSnapshot,
  switchesEditStep1Snapshot,
  switchesEditStep2Snapshot,
  switchesListingSnapshot,
} from "./fixtures/index.js";

class MemoryArchive implements ArchiveWriter {
  readonly files = new Map<string, Buffer>();

  async save(fileName: string, data: Buffer): Promise<void> {
    this.files.set(fileName, data);
  }
}

const VALID_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/AP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8BP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8BP//Z", "base64");

const okDownloader: FileDownloader = async () => Buffer.from(VALID_JPEG);

describe("vault records", () => {
  it("populates per-photo vault records with sha256, contentType, dimensions, bytes and positions", async () => {
    const archive = new MemoryArchive();
    const recovery = await recoverCloneData(
      HOT_WHEELS_ID,
      { editStep1: hotWheelsEditSnapshot, editStep2: null, listing: hotWheelsListingSnapshot },
      okDownloader,
      archive,
    );
    const expectedSha = createHash("sha256").update(VALID_JPEG).digest("hex");
    const info = await decodeImageInfo(VALID_JPEG);
    expect(recovery.photos.vault).toHaveLength(3);
    for (const [index, entry] of (recovery.photos.vault ?? []).entries()) {
      expect(entry).not.toBeNull();
      expect(entry?.position).toBe(index);
      expect(entry?.file).toBe(recovery.photos.files[index]);
      expect(entry?.sha256).toBe(expectedSha);
      expect(entry?.contentType).toBe("image/jpeg");
      expect(entry?.width).toBe(info.width);
      expect(entry?.height).toBe(info.height);
      expect(entry?.bytes).toBe(VALID_JPEG.length);
    }
  });

  it("recovers from a payload-only gallery (no DOM gallery completeness) and vaults every photo", async () => {
    const listing = structuredClone(hotWheelsListingSnapshot) as PageSnapshot;
    listing.payloadPhotos = hotWheelsListingSnapshot.images.map((url, index) => ({
      id: `payload-${index + 1}`,
      url,
      width: 1200,
      height: 900,
    }));
    // The DOM gallery no longer establishes completeness on its own.
    listing.gallery = {
      state: "unknown",
      expectedCount: null,
      observedCount: 0,
      videoPresence: "absent",
    };
    const recovery = await recoverCloneData(
      HOT_WHEELS_ID,
      { editStep1: hotWheelsEditSnapshot, editStep2: null, listing },
      okDownloader,
      new MemoryArchive(),
    );
    expect(recovery.photos.urls).toEqual(hotWheelsListingSnapshot.images);
    expect(recovery.photos.identities).toEqual(["payload-1", "payload-2", "payload-3"]);
    expect(recovery.photos.downloaded).toBe(3);
    expect(recovery.photos.complete).toBe(true);
    expect(recovery.photos.vault?.every(Boolean)).toBe(true);
  });

  it("gives failed photos a null vault entry, aligned by position", async () => {
    const failing: FileDownloader = async (url) => {
      if (url.includes("photo-2")) throw new Error("CDN refused");
      return Buffer.from(VALID_JPEG);
    };
    const recovery = await recoverCloneData(
      HOT_WHEELS_ID,
      { editStep1: hotWheelsEditSnapshot, editStep2: null, listing: hotWheelsListingSnapshot },
      failing,
      new MemoryArchive(),
    );
    expect(recovery.photos.vault).toHaveLength(3);
    expect(recovery.photos.vault?.[0]).not.toBeNull();
    expect(recovery.photos.vault?.[1]).toBeNull();
    expect(recovery.photos.vault?.[2]).not.toBeNull();
    expect(recovery.photos.files[1]).toBeNull();
  });
});

describe("403 re-mint retry", () => {
  it("calls remint once on a 403, retries with the fresh URL, records it, and vaults the photo", async () => {
    const originalUrl = hotWheelsListingSnapshot.images[1];
    const freshUrl = "https://cdn.fixture.local/hot-wheels/photo-2-fresh.jpg";
    const remint = vi.fn(async (_index: number) => freshUrl);
    const downloader: FileDownloader = async (url) => {
      if (url === originalUrl) throw new Error("CDN returned HTTP 403");
      return Buffer.from(VALID_JPEG);
    };
    const recovery = await recoverCloneData(
      HOT_WHEELS_ID,
      { editStep1: hotWheelsEditSnapshot, editStep2: null, listing: hotWheelsListingSnapshot },
      downloader,
      new MemoryArchive(),
      new Date(),
      {},
      { remint },
    );
    expect(remint).toHaveBeenCalledTimes(1);
    expect(remint).toHaveBeenCalledWith(1);
    expect(recovery.photos.urls[1]).toBe(freshUrl);
    expect(recovery.photos.files[1]).toMatch(/^photo-[a-f0-9]{64}[.]jpg$/);
    expect(recovery.photos.vault?.[1]).not.toBeNull();
    expect(recovery.photos.vault?.[1]?.file).toBe(recovery.photos.files[1]);
    expect(recovery.photos.downloaded).toBe(3);
  });

  it("does not call remint for a non-403 failure", async () => {
    const remint = vi.fn(async (_index: number) => "https://cdn.fixture.local/should-not-be-used.jpg");
    const recovery = await recoverCloneData(
      HOT_WHEELS_ID,
      { editStep1: hotWheelsEditSnapshot, editStep2: null, listing: hotWheelsListingSnapshot },
      async (url) => {
        if (url.includes("photo-2")) throw new Error("CDN refused");
        return Buffer.from(VALID_JPEG);
      },
      new MemoryArchive(),
      new Date(),
      {},
      { remint },
    );
    expect(remint).not.toHaveBeenCalled();
    expect(recovery.photos.files[1]).toBeNull();
    expect(recovery.photos.vault?.[1]).toBeNull();
    expect(recovery.photos.urls[1]).toBe(hotWheelsListingSnapshot.images[1]);
  });

  it("records the slot as failed when remint returns null", async () => {
    const remint = vi.fn(async (_index: number) => null);
    const recovery = await recoverCloneData(
      HOT_WHEELS_ID,
      { editStep1: hotWheelsEditSnapshot, editStep2: null, listing: hotWheelsListingSnapshot },
      async (url) => {
        if (url.includes("photo-2")) throw new Error("CDN returned HTTP 403");
        return Buffer.from(VALID_JPEG);
      },
      new MemoryArchive(),
      new Date(),
      {},
      { remint },
    );
    expect(remint).toHaveBeenCalledTimes(1);
    expect(recovery.photos.files[1]).toBeNull();
    expect(recovery.photos.vault?.[1]).toBeNull();
    expect(recovery.photos.reasons?.[1]).toContain("403");
  });
});

describe("ScrapeService remint wiring", () => {
  it("re-collects the listing page on a 403 and retries with the URL matched by slot identity", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "relist-vault-"));
    try {
      const freshListing = structuredClone(switchesListingSnapshot) as PageSnapshot;
      const freshUrl = "https://cdn.fixture.local/switches/photo-3-fresh.jpg";
      // Same identity (switch-photo-3), fresh URL, moved position proves
      // identity matching is preferred over the raw index.
      freshListing.gallery = {
        ...freshListing.gallery!,
        slots: [
          freshListing.gallery!.slots![1],
          freshListing.gallery!.slots![2],
          freshListing.gallery!.slots![0],
          freshListing.gallery!.slots![3],
          freshListing.gallery!.slots![4],
        ].map((slot) => (slot.identity === "switch-photo-3" ? { ...slot, url: freshUrl } : slot)),
      };
      freshListing.images = (freshListing.gallery.slots ?? []).map((slot) => slot.url);

      let listingCollections = 0;
      const store = {
        getListings: () => [{ id: SWITCHES_ID }],
        getClone: () => null,
        saveClone: vi.fn(async () => undefined),
      } as unknown as Store;
      const browser = {
        withUserOperation: async (_userId: string, operation: () => Promise<unknown>) => operation(),
        ensureSession: async () => undefined,
        refreshStatus: async () => "connected",
        collectSnapshotAt: async (_userId: string, url: string) => {
          if (url.includes("/edit/")) return switchesEditStep1Snapshot;
          if (url.includes("/item/")) {
            listingCollections += 1;
            return listingCollections === 1 ? switchesListingSnapshot : freshListing;
          }
          return null;
        },
        advanceWizard: async () => true,
        collectCurrentSnapshot: async () => switchesEditStep2Snapshot,
      } as unknown as BrowserManager;
      const originalUrl = switchesListingSnapshot.images[2];
      const downloader: FileDownloader = async (url) => {
        // The switches fixture also carries a video; serve JPEG bytes for
        // photos and let the video slot fail validation harmlessly.
        if (url === originalUrl) throw new Error("CDN returned HTTP 403");
        return Buffer.from(VALID_JPEG);
      };
      const service = new ScrapeService(store, browser, dataDir, downloader, () => new Date("2026-11-10T00:00:00Z"));
      const record = await service.recoverListing("user-1", SWITCHES_ID);
      expect(listingCollections).toBeGreaterThanOrEqual(2);
      expect(record.recovery?.photos.urls[2]).toBe(freshUrl);
      expect(record.recovery?.photos.vault?.[2]).not.toBeNull();
      expect(record.recovery?.photos.downloaded).toBe(5);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
