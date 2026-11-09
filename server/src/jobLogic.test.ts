import { describe, expect, it } from "vitest";
import { missing, recovered, type StoredClone, type SyncedListing } from "./cloneTypes.js";
import {
  fingerprintOf,
  interpretListingAvailability,
  matchesFingerprint,
  parseAttributesText,
  resolveJobData,
} from "./jobLogic.js";
import type { PageSnapshot } from "./snapshot.js";

const NOW = "2026-11-09T12:00:00.000Z";

function storedClone(overrides: Partial<StoredClone> = {}): StoredClone {
  return {
    recovery: {
      listingId: "111",
      recoveredAt: NOW,
      title: recovered("Widget", "edit_form"),
      price: recovered("$30", "edit_form"),
      description: recovered("A fine widget.", "edit_form"),
      category: recovered("Toys & Games", "edit_form"),
      condition: missing<string>("Not present anywhere."),
      attributes: recovered({ Color: "Green" }, "edit_form"),
      location: recovered("San Diego, CA", "edit_form"),
      delivery: recovered(
        { type: "Local pickup only", shipping: false, meetup: { public: false, doorPickup: false, doorDropoff: false } },
        "edit_form",
      ),
      photos: {
        urls: ["https://cdn.example/a/photo-1.jpg", "https://cdn.example/a/photo-2.jpg"],
        files: ["photo-1.jpg", "photo-2.jpg"],
        downloaded: 2,
      },
      video: { present: false, state: "none", file: null, reason: null },
      step2Blocked: false,
    },
    picks: {},
    edits: {},
    photoSelection: null,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("resolveJobData", () => {
  it("reports a missing field instead of inventing it", () => {
    const resolved = resolveJobData(storedClone());
    expect(resolved.data).toBeNull();
    expect(resolved.missing).toEqual(["condition"]);
  });

  it("fills a missing field from the person's pick and marks it supplied", () => {
    const resolved = resolveJobData(storedClone({ picks: { condition: "Used - Like New" } }));
    expect(resolved.missing).toEqual([]);
    expect(resolved.data?.condition).toBe("Used - Like New");
    expect(resolved.suppliedFields).toContain("condition");
  });

  it("applies edits over recovered values and marks them supplied", () => {
    const resolved = resolveJobData(
      storedClone({
        picks: { condition: "New" },
        edits: { price: "$25", title: "Widget (reduced)" },
      }),
    );
    expect(resolved.data?.price).toBe("$25");
    expect(resolved.data?.title).toBe("Widget (reduced)");
    expect(resolved.suppliedFields).toContain("price");
    expect(resolved.suppliedFields).toContain("title");
  });

  it("uses the photo selection, in archive order, never a failed download", () => {
    const clone = storedClone({ picks: { condition: "New" }, photoSelection: ["photo-2.jpg"] });
    const resolved = resolveJobData(clone);
    expect(resolved.data?.photoFiles).toEqual(["photo-2.jpg"]);
    expect(resolved.data?.photoUrls).toEqual(["https://cdn.example/a/photo-2.jpg"]);
    expect(resolved.suppliedFields).toContain("photos");
  });

  it("blocks the job when no photo actually downloaded", () => {
    const clone = storedClone({ picks: { condition: "New" } });
    clone.recovery!.photos = { urls: ["https://cdn.example/a/p.jpg"], files: [null], downloaded: 0 };
    const resolved = resolveJobData(clone);
    expect(resolved.data).toBeNull();
    expect(resolved.missing).toContain("photos");
  });

  it("resolves a delivery pick into a DeliveryInfo with unknown shipping/meetup", () => {
    const clone = storedClone({
      picks: { condition: "New", delivery: "Local pickup only" },
    });
    clone.recovery!.delivery = missing("Step 2 blocked.");
    const resolved = resolveJobData(clone);
    expect(resolved.data?.delivery).toEqual({
      type: "Local pickup only",
      shipping: null,
      meetup: null,
    });
    expect(resolved.suppliedFields).toContain("delivery");
  });

  it("parses edited attributes from Label: Value lines", () => {
    const clone = storedClone({
      picks: { condition: "New" },
      edits: { attributes: "Color: Blue\nSize: Large\nnot a pair" },
    });
    const resolved = resolveJobData(clone);
    expect(resolved.data?.attributes).toEqual({ Color: "Blue", Size: "Large" });
    expect(parseAttributesText("")).toEqual({});
  });

  it("requires a clone check before any job data exists", () => {
    const resolved = resolveJobData(storedClone({ recovery: null }));
    expect(resolved.data).toBeNull();
    expect(resolved.missing).toEqual(["clone_check"]);
  });
});

// ---------------------------------------------------------------------------

function card(overrides: Partial<SyncedListing> = {}): SyncedListing {
  return {
    id: "222",
    title: "Widget",
    price: "$30",
    status: "Available",
    statusText: "Active",
    photoUrl: "https://cdn.example/a/photo-1.jpg",
    url: "https://www.facebook.com/marketplace/item/222",
    listedDate: "2026-11-09",
    syncedAt: NOW,
    ...overrides,
  };
}

describe("duplicate fingerprint", () => {
  const data = {
    title: "Widget",
    price: "$30",
    description: "A fine widget.",
    category: "Toys & Games",
    condition: "New",
    attributes: {},
    location: "San Diego, CA",
    delivery: { type: "Local pickup only", shipping: false, meetup: null },
    photoFiles: ["photo-1.jpg"],
    photoUrls: ["https://cdn.example/a/photo-1.jpg"],
    videoFile: null,
  };

  it("matches a card with the same title, price, and photo file", () => {
    const fp = fingerprintOf(data, "111");
    expect(matchesFingerprint(card(), fp, "2026-11-09")).toBe(true);
  });

  it("never matches the job's own old listing", () => {
    const fp = fingerprintOf(data, "111");
    expect(matchesFingerprint(card({ id: "111" }), fp, "2026-11-09")).toBe(false);
  });

  it("matches on title+price when the card was listed today (rotated photo URL)", () => {
    const fp = fingerprintOf(data, "111");
    const rotated = card({ photoUrl: "https://cdn.example/other/zzz.jpg", listedDate: "2026-11-09" });
    expect(matchesFingerprint(rotated, fp, "2026-11-09")).toBe(true);
  });

  it("does not match an older same-title listing with a different photo", () => {
    const fp = fingerprintOf(data, "111");
    const older = card({ photoUrl: "https://cdn.example/other/zzz.jpg", listedDate: "2026-10-01" });
    expect(matchesFingerprint(older, fp, "2026-11-09")).toBe(false);
  });

  it("does not match a different price", () => {
    const fp = fingerprintOf(data, "111");
    expect(matchesFingerprint(card({ price: "$45" }), fp, "2026-11-09")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

function snapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: "https://www.facebook.com/marketplace/item/222",
    text: "",
    images: [],
    videos: [],
    detailRows: [],
    form: { inputs: [], selects: [], checkboxes: [], switches: [], buttons: [] },
    ...overrides,
  };
}

describe("interpretListingAvailability", () => {
  it("reads seller controls on a live listing as available", () => {
    const snap = snapshot({
      form: {
        inputs: [],
        selects: [],
        checkboxes: [],
        switches: [],
        buttons: [
          { label: "Edit listing", disabled: false },
          { label: "Mark as sold", disabled: false },
        ],
      },
    });
    expect(interpretListingAvailability(snap)).toBe("available");
  });

  it("reads a review banner as in_review", () => {
    const snap = snapshot({ text: "Your listing is in review. We'll let you know." });
    expect(interpretListingAvailability(snap)).toBe("in_review");
  });

  it("reads a dead page as gone", () => {
    const snap = snapshot({ text: "This listing is no longer available." });
    expect(interpretListingAvailability(snap)).toBe("gone");
  });

  it("reads a buyer-visible page with details and a price as available", () => {
    const snap = snapshot({
      text: "Widget $30 Listed in San Diego, CA",
      detailRows: [{ label: "Condition", value: "Used - like new" }],
    });
    expect(interpretListingAvailability(snap)).toBe("available");
  });

  it("is honestly unknown for an unreadable page", () => {
    expect(interpretListingAvailability(snapshot({ text: "Something else entirely" }))).toBe(
      "unknown",
    );
  });
});
