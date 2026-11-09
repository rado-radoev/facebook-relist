import { describe, expect, it } from "vitest";
import {
  recoverCloneData,
  type ArchiveWriter,
  type FileDownloader,
} from "./recovery.js";
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

const okDownloader: FileDownloader = async (url: string) => Buffer.from(`bytes:${url}`);

function downloaderFailing(part: string): FileDownloader {
  return async (url: string) => {
    if (url.includes(part)) {
      throw new Error("CDN refused");
    }
    return Buffer.from(`bytes:${url}`);
  };
}

describe("recoverCloneData — Mechanical Keyboard Switches", () => {
  it("downloads all 5 photos in order and recovers the video", async () => {
    const archive = new MemoryArchive();
    const recovery = await recoverCloneData(
      SWITCHES_ID,
      {
        editStep1: switchesEditStep1Snapshot,
        editStep2: switchesEditStep2Snapshot,
        listing: switchesListingSnapshot,
      },
      okDownloader,
      archive,
    );
    expect(recovery.photos.urls).toHaveLength(5);
    expect(recovery.photos.downloaded).toBe(5);
    expect(recovery.photos.files).toEqual([
      "photo-1.jpg",
      "photo-2.jpg",
      "photo-3.jpg",
      "photo-4.jpg",
      "photo-5.jpg",
    ]);
    expect(recovery.video).toEqual({
      present: true,
      state: "recovered",
      file: "video-1.mp4",
      reason: null,
    });
    expect(archive.files.size).toBe(6);
    expect(recovery.condition.value).toBe("Used - Like New");
    expect(recovery.delivery.value?.type).toBe("Local pickup only");
    expect(recovery.step2Blocked).toBe(false);
  });

  it("flags the video as present-not-downloaded when its download fails, keeping photos intact", async () => {
    const archive = new MemoryArchive();
    const recovery = await recoverCloneData(
      SWITCHES_ID,
      {
        editStep1: switchesEditStep1Snapshot,
        editStep2: switchesEditStep2Snapshot,
        listing: switchesListingSnapshot,
      },
      downloaderFailing("video"),
      archive,
    );
    expect(recovery.photos.downloaded).toBe(5);
    expect(recovery.video.present).toBe(true);
    expect(recovery.video.state).toBe("present_not_downloaded");
    expect(recovery.video.file).toBeNull();
    expect(recovery.video.reason).toContain("could not be downloaded");
  });

  it("records a failed photo at its own slot instead of dropping or shifting it", async () => {
    const archive = new MemoryArchive();
    const recovery = await recoverCloneData(
      SWITCHES_ID,
      {
        editStep1: switchesEditStep1Snapshot,
        editStep2: switchesEditStep2Snapshot,
        listing: switchesListingSnapshot,
      },
      downloaderFailing("photo-3"),
      archive,
    );
    expect(recovery.photos.downloaded).toBe(4);
    expect(recovery.photos.files[2]).toBeNull();
    expect(recovery.photos.files[3]).toBe("photo-4.jpg");
  });
});

describe("recoverCloneData — Hot Wheels (the hard case)", () => {
  it("recovers 3 photos and fields, with condition and delivery honestly missing", async () => {
    const archive = new MemoryArchive();
    const recovery = await recoverCloneData(
      HOT_WHEELS_ID,
      { editStep1: hotWheelsEditSnapshot, editStep2: null, listing: hotWheelsListingSnapshot },
      okDownloader,
      archive,
    );
    expect(recovery.photos.downloaded).toBe(3);
    expect(recovery.photos.files).toEqual(["photo-1.jpg", "photo-2.jpg", "photo-3.jpg"]);
    expect(recovery.video.state).toBe("none");
    expect(recovery.title.value).toBe("Nintendo Switch Hot Wheels Unleashed 2 Turbocharged");
    expect(recovery.category.value).toBe("Toys & Games");
    expect(recovery.condition.value).toBeNull();
    expect(recovery.condition.reason).toContain("nowhere");
    expect(recovery.delivery.value).toBeNull();
    expect(recovery.delivery.reason).toContain("blocked Step 2");
    expect(recovery.location).toEqual({
      value: "San Diego, CA",
      source: "listing_details",
      reason: null,
    });
    expect(recovery.step2Blocked).toBe(true);
    expect(archive.files.size).toBe(3);
  });
});
