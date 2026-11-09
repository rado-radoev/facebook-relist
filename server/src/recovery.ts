// Clone recovery orchestration: parsed page snapshots in, a persisted
// CloneRecovery out — including downloading the actual photo files (and
// attempting the video) into the backend archive.
//
// The downloader and archive writer are injectable so tests can run the
// whole recovery against fixture snapshots with a fake CDN. Nothing here
// touches Facebook: callers hand in snapshots they already collected.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CloneRecovery,
  PhotoRecovery,
  VideoRecovery,
} from "./cloneTypes.js";
import {
  buildCloneFields,
  parseEditForm,
  parseGallery,
  parseListingDetails,
} from "./facebookExtract.js";
import type { PageSnapshot } from "./snapshot.js";

export type FileDownloader = (url: string) => Promise<Buffer>;

export interface ArchiveWriter {
  save(fileName: string, data: Buffer): Promise<void>;
}

/** Archive folder for one user's one listing: <dataDir>/archive/<userId>/<listingId>/ */
export function archiveDirFor(dataDir: string, userId: string, listingId: string): string {
  return path.join(dataDir, "archive", userId, listingId);
}

export class FileArchive implements ArchiveWriter {
  constructor(private readonly dir: string) {}

  async save(fileName: string, data: Buffer): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, fileName), data);
  }
}

/** Default downloader: plain HTTPS fetch of Facebook's signed CDN URLs.
 *  Those URLs are downloadable directly (verified in the spike); the
 *  browser-session fallback is a Sprint 4 live-verification item. */
export const defaultDownloader: FileDownloader = async (url: string): Promise<Buffer> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
};

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm"]);
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

function extensionFor(url: string, allowed: Set<string>, fallback: string): string {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return allowed.has(ext) ? ext : fallback;
  } catch {
    return fallback;
  }
}

export interface RecoveryInput {
  editStep1: PageSnapshot | null;
  editStep2: PageSnapshot | null;
  listing: PageSnapshot;
}

async function recoverPhotos(
  urls: string[],
  downloader: FileDownloader,
  archive: ArchiveWriter,
): Promise<PhotoRecovery> {
  const files: Array<string | null> = [];
  let downloaded = 0;
  for (const [index, url] of urls.entries()) {
    const fileName = `photo-${index + 1}${extensionFor(url, IMAGE_EXTENSIONS, ".jpg")}`;
    try {
      const data = await downloader(url);
      await archive.save(fileName, data);
      files.push(fileName);
      downloaded += 1;
    } catch {
      // A failed photo is recorded as missing-at-that-slot, never dropped
      // silently and never replaced with another listing's image.
      files.push(null);
    }
  }
  return { urls, files, downloaded };
}

async function recoverVideo(
  urls: string[],
  downloader: FileDownloader,
  archive: ArchiveWriter,
): Promise<VideoRecovery> {
  const unique = [...new Set(urls.filter((url) => url.length > 0))];
  if (unique.length === 0) {
    return { present: false, state: "none", file: null, reason: null };
  }
  const url = unique[0];
  try {
    const data = await downloader(url);
    if (data.length > MAX_VIDEO_BYTES) {
      return {
        present: true,
        state: "present_not_downloaded",
        file: null,
        reason: "The video file is larger than the archive limit (100 MB).",
      };
    }
    const fileName = `video-1${extensionFor(url, VIDEO_EXTENSIONS, ".mp4")}`;
    await archive.save(fileName, data);
    return { present: true, state: "recovered", file: fileName, reason: null };
  } catch {
    return {
      present: true,
      state: "present_not_downloaded",
      file: null,
      reason: "The video file could not be downloaded from Facebook's CDN.",
    };
  }
}

export async function recoverCloneData(
  listingId: string,
  input: RecoveryInput,
  downloader: FileDownloader,
  archive: ArchiveWriter,
  now: Date = new Date(),
): Promise<CloneRecovery> {
  const edit = input.editStep1 ? parseEditForm(input.editStep1, input.editStep2) : null;
  const details = parseListingDetails(input.listing);
  const fields = buildCloneFields(edit, details);
  const photos = await recoverPhotos(parseGallery(input.listing), downloader, archive);
  const video = await recoverVideo(input.listing.videos, downloader, archive);
  return {
    listingId,
    recoveredAt: now.toISOString(),
    title: fields.title,
    price: fields.price,
    description: fields.description,
    category: fields.category,
    condition: fields.condition,
    attributes: fields.attributes,
    location: fields.location,
    delivery: fields.delivery,
    photos,
    video,
    step2Blocked: fields.step2Blocked,
  };
}
