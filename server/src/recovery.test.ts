import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FileArchive,
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

describe("FileArchive", () => {
  it("publishes concurrent identical media atomically and idempotently", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "relist-archive-"));
    const dir = path.join(parent, "archive");
    const archive = new FileArchive(dir);
    const name = `photo-${"a".repeat(64)}.jpg`;
    const data = Buffer.alloc(256 * 1024, 0x61);
    try {
      await expect(Promise.all([archive.save(name, data), archive.save(name, data)])).resolves.toEqual([undefined, undefined]);
      expect(await readFile(path.join(dir, name))).toEqual(data);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

class MemoryArchive implements ArchiveWriter {
  readonly files = new Map<string, Buffer>();

  async save(fileName: string, data: Buffer): Promise<void> {
    this.files.set(fileName, data);
  }
}

const VALID_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/AP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8BP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8BP//Z", "base64");
const VALID_MP4 = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"]);
const okDownloader: FileDownloader = async (url: string) => Buffer.from(url.includes("video") ? VALID_MP4 : VALID_JPEG);

function downloaderFailing(part: string): FileDownloader {
  return async (url: string) => {
    if (url.includes(part)) {
      throw new Error("CDN refused");
    }
    return Buffer.from(url.includes("video") ? VALID_MP4 : VALID_JPEG);
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
    expect(recovery.photos.files.every((file) => typeof file === "string" && file.startsWith("photo-") && file.endsWith(".jpg"))).toBe(true);
    expect(recovery.video).toEqual({
      present: true,
      state: "recovered",
      file: expect.stringMatching(/^video-[a-f0-9]{64}[.]mp4$/),
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
    expect(recovery.video.reason).toContain("CDN refused");
  });

  it("refuses recovery when the gallery count is absent or incomplete", async () => {
    const listing = structuredClone(switchesListingSnapshot);
    listing.gallery = { state: "incomplete", expectedCount: 6, observedCount: listing.images.length, videoPresence: "unknown" };
    await expect(recoverCloneData(
      SWITCHES_ID,
      { editStep1: switchesEditStep1Snapshot, editStep2: switchesEditStep2Snapshot, listing },
      okDownloader,
      new MemoryArchive(),
    )).rejects.toThrow("gallery completeness");
  });

  it("refuses a listing surface bound to a different requested id", async () => {
    const listing = structuredClone(switchesListingSnapshot);
    listing.surface = { kind: "listing", listingId: HOT_WHEELS_ID, readiness: "ready" };
    await expect(recoverCloneData(
      SWITCHES_ID,
      { editStep1: switchesEditStep1Snapshot, editStep2: switchesEditStep2Snapshot, listing },
      okDownloader,
      new MemoryArchive(),
    )).rejects.toThrow("requested listing");
  });

  it("keeps a missing video source unknown unless the gallery positively reports absence", async () => {
    const listing = structuredClone(hotWheelsListingSnapshot);
    listing.gallery = {
      state: "complete",
      expectedCount: 3,
      observedCount: 3,
      videoPresence: "unknown",
      slots: listing.images.map((url, index) => ({ identity: `slot-${index + 1}`, url })),
    };
    const recovery = await recoverCloneData(
      HOT_WHEELS_ID,
      { editStep1: hotWheelsEditSnapshot, editStep2: null, listing },
      okDownloader,
      new MemoryArchive(),
    );
    expect(recovery.video.state).toBe("unknown");
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
    expect(recovery.photos.files[3]).toMatch(/^photo-[a-f0-9]{64}[.]jpg$/);
  });
});

describe("recoverCloneData — Hot Wheels (the hard case)", () => {
  it("refuses to archive injected bytes that are not decodable images and preserves the slot reason", async () => {
    const recovery = await recoverCloneData(
      HOT_WHEELS_ID,
      { editStep1: hotWheelsEditSnapshot, editStep2: null, listing: hotWheelsListingSnapshot },
      async () => Buffer.from("this is not a JPEG or image"),
      new MemoryArchive(),
    );
    expect(recovery.photos.files[0]).toBeNull();
    expect(recovery.photos.reasons?.[0]).toContain("unsupported image format");
  });

  it("recovers 3 photos and fields, with condition and delivery honestly missing", async () => {
    const archive = new MemoryArchive();
    const recovery = await recoverCloneData(
      HOT_WHEELS_ID,
      { editStep1: hotWheelsEditSnapshot, editStep2: null, listing: hotWheelsListingSnapshot },
      okDownloader,
      archive,
    );
    expect(recovery.photos.downloaded).toBe(3);
    expect(recovery.photos.files.every((file) => typeof file === "string" && file.startsWith("photo-") && file.endsWith(".jpg"))).toBe(true);
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
      state: "recovered",
      reason: null,
    });
    expect(recovery.step2Blocked).toBe(true);
    expect(archive.files.size).toBe(3);
  });
});
