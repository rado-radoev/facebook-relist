import { describe, expect, it } from "vitest";
import { applyClone } from "./cloneMapping";
import type { Listing, StoredClone } from "../types";

const listing: Listing = {
  listing_id: "synthetic-1",
  accountId: "synthetic-user",
  title: "Synthetic title",
  price: "$5",
  condition: "New",
  description: "Recovered text",
  location: "Synthetic town",
  status: "Available",
  creation_date: "",
  product_url: "https://example.invalid/item",
  photo: "blob:synthetic",
  photoCount: null,
  videoCount: 0,
  category: "Other",
  delivery: "Local pickup only",
  locationLabel: "Synthetic town",
  source: "synced",
};

const clone = {
  recovery: {
    listingId: "synthetic-1",
    recoveredAt: "2026-11-09T00:00:00Z",
    title: { value: "Synthetic title", source: "edit_form", state: "recovered", reason: null },
    price: { value: "$5", source: "edit_form", state: "recovered", reason: null },
    description: { value: null, source: null, state: "unknown", reason: "Description surface did not finish loading." },
    category: { value: null, source: null, state: "not_applicable", reason: "This category has no applicable attributes." },
    condition: { value: "New", source: "edit_form", state: "recovered", reason: null },
    attributes: { value: null, source: null, state: "unknown", reason: "Attribute controls were not readable." },
    location: { value: "Synthetic town", source: "edit_form", state: "recovered", reason: null },
    delivery: { value: { type: "Local pickup only", shipping: null, meetup: null }, source: "edit_form", state: "recovered", reason: null },
    photos: {
      urls: ["https://example.invalid/a.jpg", "https://example.invalid/b.jpg"],
      files: ["sha256-a.jpg", null],
      downloaded: 1,
      expectedCount: 3,
      complete: false,
      identities: ["media-a", "media-b"],
      reasons: [null, "Photo download returned HTTP 503."],
    },
    video: { present: null, state: "unknown", file: null, reason: "Video presence could not be verified." },
    step2Blocked: false,
  },
  picks: {},
  edits: {},
  photoSelection: null,
  updatedAt: "2026-11-09T00:00:00Z",
} as unknown as StoredClone;

describe("applyClone recovery provenance", () => {
  it("preserves unknown, not-applicable, and incomplete media states without inferring absence", () => {
    const result = applyClone(listing, clone);

    expect(result.fieldStates?.description).toBe("unknown");
    expect(result.fieldStates?.category).toBe("not_applicable");
    expect(result.fieldStates?.attributes).toBe("unknown");
    expect(result.fieldStates?.photos).toBe("missing");
    expect(result.photoReasons).toEqual([null, "Photo download returned HTTP 503."]);
    expect(result.videoPresence).toBe("unknown");
    expect(result.videoState).toBe("unknown");
  });
});
