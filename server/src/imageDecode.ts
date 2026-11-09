// Image decoding for photo validation, isolated behind lazy loaders.
//
// sharp is the primary decoder, but its prebuilt binary refuses to load
// on CPUs without x86-64-v2 features ("Unsupported CPU") — and because a
// static import would run at module load, that failure used to take the
// ENTIRE backend down at boot on such a host, even though decoding is
// only needed during clone photo recovery. So sharp is loaded with a
// dynamic import, only when a photo actually needs validating, and only
// a load failure (never a decode failure) engages the ffprobe fallback:
// once sharp loads, its decode errors propagate byte-for-byte as before.
//
// The fallback probes the bytes with ffprobe (the same spawn pattern
// validateVideo uses) and accepts only a single still-image stream
// under the same pixel cap. If neither validator can run, decoding
// throws ImageDecoderUnavailableError — callers turn that into a
// per-photo failure, never a process crash, and never a silent accept.

import { spawn } from "node:child_process";

export const MAX_IMAGE_PIXELS = 40_000_000;

export interface DecodedImageInfo {
  format: string;
  width: number;
  height: number;
}

export interface SharpInstance {
  rotate(): {
    toBuffer(options: { resolveWithObject: true }): Promise<{ info: DecodedImageInfo }>;
  };
}

export type SharpFactory = (
  data: Buffer,
  options: { limitInputPixels: number; failOn: string },
) => SharpInstance;

export type SharpLoader = () => Promise<SharpFactory>;

const loadSharpDefault: SharpLoader = async () => {
  const mod = await import("sharp");
  return mod.default as unknown as SharpFactory;
};

export interface ProbeStream {
  codecName: string;
  codecType: string;
  width: number | null;
  height: number | null;
}

export interface ImageProbeResult {
  streams: ProbeStream[];
}

export type ImageProbe = (data: Buffer) => Promise<ImageProbeResult>;

const PROBE_TIMEOUT_MS = 8_000;

const ffprobeImageDefault: ImageProbe = async (data: Buffer): Promise<ImageProbeResult> => {
  const probe = spawn("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_name,codec_type,width,height",
    "-of", "json",
    "pipe:0",
  ], { stdio: ["pipe", "pipe", "ignore"] });
  const raw = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => probe.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    probe.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8").slice(0, 65_536); });
    probe.on("error", (error) => { clearTimeout(timer); reject(error); });
    probe.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`ffprobe exited with code ${code ?? "unknown"}`));
      }
    });
    probe.stdin.end(data);
  });
  const parsed = JSON.parse(raw) as {
    streams?: Array<{ codec_name?: string; codec_type?: string; width?: number; height?: number }>;
  };
  const streams = (parsed.streams ?? []).map((stream) => ({
    codecName: stream.codec_name ?? "",
    codecType: stream.codec_type ?? "",
    width: typeof stream.width === "number" ? stream.width : null,
    height: typeof stream.height === "number" ? stream.height : null,
  }));
  return { streams };
};

export class ImageDecoderUnavailableError extends Error {
  constructor(sharpError: unknown, probeError: unknown) {
    const sharpMessage = sharpError instanceof Error ? sharpError.message : String(sharpError);
    const probeMessage = probeError instanceof Error ? probeError.message : String(probeError);
    super(
      "Image decoder unavailable on this host: the sharp image library failed to load " +
      `(${sharpMessage}) and the ffprobe fallback could not validate the image (${probeMessage}). ` +
      "Photo validation is unavailable until one of them works on this host.",
    );
    this.name = "ImageDecoderUnavailableError";
  }
}

export interface ImageDecodeDeps {
  loadSharp?: SharpLoader;
  probeImage?: ImageProbe;
}

const PROBE_CODEC_FORMATS: Record<string, string> = {
  mjpeg: "jpeg",
  png: "png",
  webp: "webp",
  gif: "gif",
};

async function decodeWithProbe(data: Buffer, probeImage: ImageProbe, sharpError: unknown): Promise<DecodedImageInfo> {
  let result: ImageProbeResult;
  try {
    result = await probeImage(data);
  } catch (probeError) {
    throw new ImageDecoderUnavailableError(sharpError, probeError);
  }
  if (result.streams.length !== 1) {
    throw new Error("Downloaded content is not a supported, decodable image");
  }
  const stream = result.streams[0];
  const format = PROBE_CODEC_FORMATS[stream.codecName];
  if (!format || stream.width === null || stream.height === null) {
    throw new Error("Downloaded content is not a supported, decodable image");
  }
  if (stream.width * stream.height > MAX_IMAGE_PIXELS) {
    throw new Error(`Image exceeds the ${MAX_IMAGE_PIXELS} pixel limit`);
  }
  return { format, width: stream.width, height: stream.height };
}

/**
 * Decode image bytes to their format/dimensions. Uses sharp when it
 * loads (identical options and error behavior to the historical direct
 * call); falls back to ffprobe only when sharp itself cannot load.
 */
export async function decodeImageInfo(data: Buffer, deps: ImageDecodeDeps = {}): Promise<DecodedImageInfo> {
  const loadSharp = deps.loadSharp ?? loadSharpDefault;
  const probeImage = deps.probeImage ?? ffprobeImageDefault;
  let factory: SharpFactory | null = null;
  let loadError: unknown = null;
  try {
    factory = await loadSharp();
  } catch (error) {
    loadError = error;
  }
  if (factory) {
    const decoded = await factory(data, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "error" })
      .rotate()
      .toBuffer({ resolveWithObject: true });
    return decoded.info;
  }
  return decodeWithProbe(data, probeImage, loadError);
}
