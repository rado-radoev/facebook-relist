// Boot-safety and fallback tests for image decoding.
//
// The sharp mock below reproduces the owner's Docker host failure: the
// prebuilt binary throws at load time on a CPU without x86-64-v2. With
// that mock active for this whole file, the fact that these imports and
// tests run at all proves the module graph (recovery, the Fastify app)
// no longer depends on sharp loading. Fallback behavior is exercised
// with injected loaders/probes, plus one end-to-end pass through the
// real ffprobe binary.

import { describe, expect, it, vi } from "vitest";

vi.mock("sharp", () => {
  throw new Error(
    'Could not load the "sharp" module using the linux-x64 runtime\n' +
    "Unsupported CPU: Prebuilt binaries for linux-x64 require v2 microarchitecture",
  );
});

import {
  ImageDecoderUnavailableError,
  decodeImageInfo,
  type ImageProbe,
  type SharpLoader,
} from "./imageDecode.js";
import { recoverCloneData, validateImage, type ArchiveWriter } from "./recovery.js";
import {
  HOT_WHEELS_ID,
  hotWheelsEditSnapshot,
  hotWheelsListingSnapshot,
} from "./fixtures/index.js";

const VALID_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/AP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8BP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8BP//Z", "base64");

const sharpUnavailable: SharpLoader = async () => {
  throw new Error("Unsupported CPU: Prebuilt binaries for linux-x64 require v2 microarchitecture");
};

const probeUnavailable: ImageProbe = async () => {
  throw Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT" });
};

function probeReturning(streams: Array<{ codecName: string; codecType: string; width: number | null; height: number | null }>): ImageProbe {
  return async () => ({ streams });
}

const jpegProbe = probeReturning([{ codecName: "mjpeg", codecType: "video", width: 960, height: 960 }]);

function withContentType(data: Buffer, contentType: string): Buffer {
  const copy = Buffer.from(data);
  Object.defineProperty(copy, "contentType", { value: contentType });
  return copy;
}

class MemoryArchive implements ArchiveWriter {
  readonly files = new Map<string, Buffer>();

  async save(fileName: string, data: Buffer): Promise<void> {
    this.files.set(fileName, data);
  }
}

describe("module graph with an unloadable sharp", () => {
  it("imports recovery and builds the app module graph without sharp", async () => {
    expect(typeof recoverCloneData).toBe("function");
    const appModule = await import("./app.js");
    expect(typeof appModule.buildApp).toBe("function");
  });
});

describe("decodeImageInfo ffprobe fallback (sharp cannot load)", () => {
  it("accepts a valid image reported by the probe", async () => {
    const info = await decodeImageInfo(VALID_JPEG, { loadSharp: sharpUnavailable, probeImage: jpegProbe });
    expect(info).toEqual({ format: "jpeg", width: 960, height: 960 });
  });

  it("maps png, webp and gif probe codecs to formats", async () => {
    for (const [codecName, format] of [["png", "png"], ["webp", "webp"], ["gif", "gif"]] as const) {
      const info = await decodeImageInfo(VALID_JPEG, {
        loadSharp: sharpUnavailable,
        probeImage: probeReturning([{ codecName, codecType: "video", width: 10, height: 10 }]),
      });
      expect(info.format).toBe(format);
    }
  });

  it("rejects a probe result with no image stream", async () => {
    await expect(decodeImageInfo(VALID_JPEG, {
      loadSharp: sharpUnavailable,
      probeImage: probeReturning([]),
    })).rejects.toThrow("not a supported, decodable image");
  });

  it("rejects a probe result with more than one stream", async () => {
    await expect(decodeImageInfo(VALID_JPEG, {
      loadSharp: sharpUnavailable,
      probeImage: probeReturning([
        { codecName: "mjpeg", codecType: "video", width: 10, height: 10 },
        { codecName: "mjpeg", codecType: "video", width: 10, height: 10 },
      ]),
    })).rejects.toThrow("not a supported, decodable image");
  });

  it("rejects a non-image codec", async () => {
    await expect(decodeImageInfo(VALID_JPEG, {
      loadSharp: sharpUnavailable,
      probeImage: probeReturning([{ codecName: "h264", codecType: "video", width: 10, height: 10 }]),
    })).rejects.toThrow("not a supported, decodable image");
  });

  it("rejects dimensions over the pixel cap", async () => {
    await expect(decodeImageInfo(VALID_JPEG, {
      loadSharp: sharpUnavailable,
      probeImage: probeReturning([{ codecName: "mjpeg", codecType: "video", width: 8000, height: 6000 }]),
    })).rejects.toThrow("pixel limit");
  });

  it("throws the decoder-unavailable error when ffprobe cannot run either", async () => {
    await expect(decodeImageInfo(VALID_JPEG, {
      loadSharp: sharpUnavailable,
      probeImage: probeUnavailable,
    })).rejects.toBeInstanceOf(ImageDecoderUnavailableError);
    await expect(decodeImageInfo(VALID_JPEG, {
      loadSharp: sharpUnavailable,
      probeImage: probeUnavailable,
    })).rejects.toThrow("Image decoder unavailable on this host");
  });
});

describe("validateImage through the fallback", () => {
  it("accepts a valid image and returns the jpg extension", async () => {
    await expect(validateImage(VALID_JPEG, { loadSharp: sharpUnavailable, probeImage: jpegProbe }))
      .resolves.toEqual({ extension: "jpg", format: "jpeg" });
  });

  it("accepts when the declared content type matches the probed format", async () => {
    await expect(validateImage(withContentType(VALID_JPEG, "image/jpeg"), { loadSharp: sharpUnavailable, probeImage: jpegProbe }))
      .resolves.toEqual({ extension: "jpg", format: "jpeg" });
  });

  it("rejects when the declared content type does not match the probed format", async () => {
    await expect(validateImage(withContentType(VALID_JPEG, "image/png"), { loadSharp: sharpUnavailable, probeImage: jpegProbe }))
      .rejects.toThrow("Image media type does not match decoded bytes");
  });

  it("works end to end through the real ffprobe binary (mocked-broken sharp, default probe)", async () => {
    await expect(validateImage(VALID_JPEG)).resolves.toEqual({ extension: "jpg", format: "jpeg" });
  });
});

describe("recoverCloneData when no image decoder is available", () => {
  it("records failed photo slots with the decoder reason instead of crashing", async () => {
    const recovery = await recoverCloneData(
      HOT_WHEELS_ID,
      { editStep1: hotWheelsEditSnapshot, editStep2: null, listing: hotWheelsListingSnapshot },
      async () => Buffer.from(VALID_JPEG),
      new MemoryArchive(),
      new Date(),
      { loadSharp: sharpUnavailable, probeImage: probeUnavailable },
    );
    expect(recovery.photos.downloaded).toBe(0);
    expect(recovery.photos.files).toEqual([null, null, null]);
    expect(recovery.photos.reasons?.[0]).toContain("Image decoder unavailable on this host");
    expect(recovery.title.value).toBe("Nintendo Switch Hot Wheels Unleashed 2 Turbocharged");
  });
});
