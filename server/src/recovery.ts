// Clone recovery orchestration: parsed page snapshots in, a persisted
// CloneRecovery out — including downloading the actual photo files (and
// attempting the video) into the backend archive.
//
// The downloader and archive writer are injectable so tests can run the
// whole recovery against fixture snapshots with a fake CDN. Nothing here
// touches Facebook: callers hand in snapshots they already collected.

import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { spawn } from "node:child_process";
import path from "node:path";
import { decodeImageInfo, type ImageDecodeDeps } from "./imageDecode.js";
import type {
  CloneRecovery,
  PhotoRecovery,
  VideoRecovery,
  VaultPhoto,
} from "./cloneTypes.js";
import {
  buildCloneFields,
  effectiveGallery,
  parseEditForm,
  parseGallery,
  parseListingDetails,
} from "./facebookExtract.js";
import type { PageSnapshot } from "./snapshot.js";

export type { VaultPhoto } from "./cloneTypes.js";

/** Re-mint a fresh CDN URL for the photo at `index` (e.g. after a 403
 *  from an expired signed URL). Returns null when no fresh URL is available. */
export type RemintCallback = (index: number) => Promise<string | null>;

export interface RecoverPhotosOptions {
  remint?: RemintCallback;
}

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
    if (!/^photo-[a-f0-9]{64}[.](?:jpg|png|webp|gif)$/.test(fileName) && !/^video-[a-f0-9]{64}[.](?:mp4|mov|webm)$/.test(fileName)) {
      throw new Error("Invalid immutable media id");
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const filePath = path.join(this.dir, fileName);
    const tempPath = path.join(this.dir, `.${fileName}.${randomUUID()}.tmp`);
    try {
      const handle = await open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(tempPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(filePath);
      if (!existing.equals(data)) throw new Error("Immutable media id collision");
    } finally {
      await unlink(tempPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

/** Default downloader: plain HTTPS fetch of Facebook's signed CDN URLs.
 *  Those URLs are downloadable directly (verified in the spike); the
 *  browser-session fallback is a Sprint 4 live-verification item. */
const MEDIA_HOSTS = ["fbcdn.net", "fbsbx.com", "fbsbx.net"];
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MEDIA_TIMEOUT_MS = 15_000;

function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    const [a, b] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && octets[2] === 100) ||
      (a === 203 && b === 0 && octets[2] === 113));
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return isPublicAddress(normalized.slice(7));
    return !(normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff"));
  }
  return false;
}

async function validateMediaUrl(raw: string): Promise<{ url: URL; address: string; family: number }> {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("Media URL must use HTTPS without credentials or a custom port");
  }
  if (!MEDIA_HOSTS.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
    throw new Error("Media host is not an approved Facebook CDN");
  }
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname, family: isIP(url.hostname) }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("Media host did not resolve exclusively to public addresses");
  }
  return { url, address: addresses[0].address, family: addresses[0].family };
}

function requestMedia(url: URL, address: string, family: number, maxBytes: number): Promise<{ data: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: url.hostname,
      servername: url.hostname,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { accept: "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" },
      lookup: (_hostname, _options, callback) => callback(null, address, family),
      timeout: MEDIA_TIMEOUT_MS,
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        resolve({ data: Buffer.from(response.headers.location), contentType: `redirect:${status}` });
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`CDN returned HTTP ${status}`));
        return;
      }
      const contentType = (response.headers["content-type"] ?? "").split(";")[0].toLowerCase();
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (declaredLength > maxBytes) {
        response.destroy(new Error("Media exceeds the download size limit"));
        reject(new Error("Media exceeds the download size limit"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy(new Error("Media exceeds the download size limit"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => resolve({ data: Buffer.concat(chunks), contentType }));
      response.on("error", reject);
    });
    request.setTimeout(MEDIA_TIMEOUT_MS, () => request.destroy(new Error("Media download timed out")));
    request.on("error", reject);
    request.end();
  });
}

export const defaultDownloader: FileDownloader = async (rawUrl: string): Promise<Buffer> => {
  let raw = rawUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const { url, address, family } = await validateMediaUrl(raw);
    const response = await requestMedia(url, address, family, MAX_VIDEO_BYTES);
    if (response.contentType.startsWith("redirect:")) {
      if (redirects === MAX_REDIRECTS) throw new Error("Too many media redirects");
      raw = new URL(response.data.toString("utf8"), url).toString();
      continue;
    }
    if (response.data.length > MAX_VIDEO_BYTES) throw new Error("Media exceeds the download size limit");
    Object.defineProperty(response.data, "contentType", { value: response.contentType });
    return response.data;
  }
  throw new Error("Too many media redirects");
};

function mediaContentType(data: Buffer): string | null {
  return (data as Buffer & { contentType?: string }).contentType ?? null;
}

async function validateImageDetailed(
  data: Buffer,
  deps: ImageDecodeDeps = {},
): Promise<{ extension: string; format: string; contentType: string; width: number; height: number }> {
  if (!data.length || data.length > MAX_MEDIA_BYTES) throw new Error("Image is empty or exceeds the 25 MB limit");
  const info = await decodeImageInfo(data, deps);
  const formats: Record<string, { extension: string; contentType: string }> = {
    jpeg: { extension: "jpg", contentType: "image/jpeg" },
    png: { extension: "png", contentType: "image/png" },
    webp: { extension: "webp", contentType: "image/webp" },
    gif: { extension: "gif", contentType: "image/gif" },
  };
  const format = info.format;
  const supported = formats[format];
  if (!supported || info.width < 1 || info.height < 1) throw new Error("Downloaded content is not a supported, decodable image");
  const declared = mediaContentType(data);
  if (declared && declared !== supported.contentType) throw new Error("Image media type does not match decoded bytes");
  return { extension: supported.extension, format, contentType: supported.contentType, width: info.width, height: info.height };
}

export async function validateImage(data: Buffer, deps: ImageDecodeDeps = {}): Promise<{ extension: string; format: string }> {
  const { extension, format } = await validateImageDetailed(data, deps);
  return { extension, format };
}

async function validateVideo(data: Buffer): Promise<{ extension: string; contentType: string }> {
  if (!data.length || data.length > MAX_VIDEO_BYTES) throw new Error("Video is empty or exceeds the 100 MB limit");
  const type = mediaContentType(data);
  if (!data.subarray(4, 8).equals(Buffer.from("ftyp")) && !data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    throw new Error("Downloaded content is not a supported video container");
  }
  const probe = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type", "-of", "default=noprint_wrappers=1:nokey=1", "pipe:0"], { stdio: ["pipe", "pipe", "ignore"] });
  const result = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => probe.kill("SIGKILL"), 8_000);
    probe.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8").slice(0, 1000); });
    probe.on("error", (error) => { clearTimeout(timer); reject(error); });
    probe.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error("Video decode validation failed")); });
    probe.stdin.end(data);
  });
  if (!result.split(/\s+/).includes("video")) throw new Error("Video contains no decodable video stream");
  const extension = data.subarray(4, 8).toString("ascii") === "ftyp" ? "mp4" : "webm";
  const expected = extension === "mp4" ? "video/mp4" : "video/webm";
  if (type && type !== expected && !(extension === "mp4" && type === "video/quicktime")) throw new Error("Video media type does not match its container");
  return { extension: extension === "mp4" && type === "video/quicktime" ? "mov" : extension, contentType: type ?? expected };
}

export interface RecoveryInput {
  editStep1: PageSnapshot | null;
  editStep2: PageSnapshot | null;
  listing: PageSnapshot;
}

function isHttp403(error: unknown): boolean {
  return error instanceof Error && /\b403\b/.test(error.message);
}

async function recoverPhotos(
  urls: string[],
  gallery: PageSnapshot["gallery"],
  downloader: FileDownloader,
  archive: ArchiveWriter,
  imageDeps: ImageDecodeDeps = {},
  options: RecoverPhotosOptions = {},
): Promise<PhotoRecovery> {
  const files: Array<string | null> = [];
  const reasons: Array<string | null> = [];
  const vault: Array<VaultPhoto | null> = [];
  const effectiveUrls = [...urls];
  let downloaded = 0;
  if (!gallery?.slots || gallery.slots.length !== urls.length || gallery.slots.some((slot, index) => slot.url !== urls[index] || !slot.identity)) {
    throw new Error("Listing gallery is missing ordered stable media identities");
  }
  const slots = gallery.slots;
  const identities = slots.map((slot) => slot.identity);
  if (new Set(identities).size !== identities.length) throw new Error("Listing gallery contains duplicate media identities");
  for (const [index, originalUrl] of urls.entries()) {
    // Download phase: only a download error indicating HTTP 403 (an
    // expired signed CDN URL) earns one re-mint + retry. Validation or
    // archive failures, and any other download error, never re-mint.
    let data: Buffer | null = null;
    let downloadError: unknown = null;
    try {
      data = await downloader(originalUrl);
    } catch (error) {
      if (options.remint && isHttp403(error)) {
        let fresh: string | null = null;
        try {
          fresh = await options.remint(index);
        } catch {
          fresh = null;
        }
        if (fresh) {
          effectiveUrls[index] = fresh;
          try {
            data = await downloader(fresh);
          } catch (retryError) {
            downloadError = retryError;
          }
        } else {
          downloadError = error;
        }
      } else {
        downloadError = error;
      }
    }
    if (downloadError !== null || data === null) {
      // A failed photo is recorded as missing-at-that-slot, never dropped
      // silently and never replaced with another listing's image.
      files.push(null);
      vault.push(null);
      reasons.push(
        downloadError instanceof Error
          ? downloadError.message
          : "Photo could not be validated or downloaded.",
      );
      continue;
    }
    try {
      const detailed = await validateImageDetailed(data, imageDeps);
      const identity = slots[index].identity;
      const fileName = `photo-${createHash("sha256").update(identity).update(data).digest("hex")}.${detailed.extension}`;
      await archive.save(fileName, data);
      files.push(fileName);
      vault.push({
        position: index,
        file: fileName,
        sha256: createHash("sha256").update(data).digest("hex"),
        contentType: detailed.contentType,
        width: detailed.width,
        height: detailed.height,
        bytes: data.length,
      });
      reasons.push(null);
      downloaded += 1;
    } catch (error) {
      files.push(null);
      vault.push(null);
      reasons.push(error instanceof Error ? error.message : "Photo could not be validated or downloaded.");
    }
  }
  return {
    urls: effectiveUrls,
    files,
    vault,
    downloaded,
    expectedCount: gallery?.expectedCount ?? null,
    complete: Boolean(gallery?.state === "complete" && gallery.expectedCount === effectiveUrls.length && files.every(Boolean)),
    identities,
    reasons,
  };
}

async function recoverVideo(
  urls: string[],
  presence: NonNullable<PageSnapshot["gallery"]>["videoPresence"] | undefined,
  downloader: FileDownloader,
  archive: ArchiveWriter,
): Promise<VideoRecovery> {
  const unique = [...new Set(urls.filter((url) => url.length > 0))];
  if (unique.length === 0) {
    if (presence === "absent") return { present: false, state: "none", file: null, reason: null };
    if (presence === "present") return { present: true, state: "present_not_downloaded", file: null, reason: "The gallery reports a video but exposes no downloadable source." };
    return { present: null, state: "unknown", file: null, reason: "The listing gallery did not positively report whether a video is present." };
  }
  const url = unique[0];
  try {
    const data = await downloader(url);
    const { extension } = await validateVideo(data);
    const fileName = `video-${createHash("sha256").update(url).update(data).digest("hex")}.${extension}`;
    await archive.save(fileName, data);
    return { present: true, state: "recovered", file: fileName, reason: null };
  } catch (error) {
    return {
      present: true,
      state: "present_not_downloaded",
      file: null,
      reason: error instanceof Error ? error.message : "The video file could not be downloaded or validated.",
    };
  }
}

export async function recoverCloneData(
  listingId: string,
  input: RecoveryInput,
  downloader: FileDownloader,
  archive: ArchiveWriter,
  now: Date = new Date(),
  imageDeps: ImageDecodeDeps = {},
  options: RecoverPhotosOptions = {},
): Promise<CloneRecovery> {
  if (input.listing.surface?.kind !== "listing" || input.listing.surface.readiness !== "ready" || input.listing.surface.listingId !== listingId) {
    throw new Error("The listing surface identity or readiness does not match the requested listing");
  }
  if (input.editStep1 && (input.editStep1.surface?.kind !== "edit_form" || input.editStep1.surface.readiness !== "ready" || input.editStep1.surface.listingId !== listingId)) {
    throw new Error("The edit surface identity or readiness does not match the requested listing");
  }
  if (input.editStep2 && (input.editStep2.surface?.kind !== "edit_form" || input.editStep2.surface.readiness !== "ready" || input.editStep2.surface.listingId !== listingId)) {
    throw new Error("The Step 2 surface identity or readiness does not match the requested listing");
  }
  const gallery = effectiveGallery(input.listing);
  const urls = parseGallery(input.listing);
  if (!gallery || gallery.state !== "complete" || gallery.expectedCount === null || gallery.expectedCount !== gallery.observedCount || gallery.observedCount !== urls.length) {
    throw new Error("Listing gallery completeness is missing or inconsistent");
  }
  const edit = input.editStep1 ? parseEditForm(input.editStep1, input.editStep2) : null;
  const details = parseListingDetails(input.listing);
  const fields = buildCloneFields(edit, details);
  const photos = await recoverPhotos(urls, gallery, downloader, archive, imageDeps, options);
  const video = await recoverVideo(input.listing.videos, gallery.videoPresence, downloader, archive);

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
