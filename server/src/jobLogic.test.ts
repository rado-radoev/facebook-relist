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
      attributes: Object.assign(recovered({ Color: "Green" }, "edit_form"), { state: "recovered" as const }),
      location: recovered("San Diego, CA", "edit_form"),
      delivery: recovered(
        { type: "Local pickup only", shipping: false, meetup: { public: false, doorPickup: false, doorDropoff: false } },
        "edit_form",
      ),
      photos: Object.assign({
        urls: ["https://cdn.example/a/photo-1.jpg", "https://cdn.example/a/photo-2.jpg"],
        files: ["photo-1.jpg", "photo-2.jpg"],
        downloaded: 2,
      }, {
        complete: true,
        expectedCount: 2,
        identities: ["media-1", "media-2"],
        reasons: [null, null],
      }),
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

  it("preserves an explicit empty description edit instead of restoring recovered text", () => {
    const resolved = resolveJobData(
      storedClone({ picks: { condition: "New" }, edits: { description: "" } }),
    );
    expect(resolved.missing).toEqual([]);
    expect(resolved.data?.description).toBe("");
    expect(resolved.suppliedFields).toContain("description");
  });

  it("uses the photo selection, in archive order, never a failed download", () => {
    const clone = storedClone({ picks: { condition: "New" }, photoSelection: ["photo-2.jpg"] });
    const resolved = resolveJobData(clone);
    expect(resolved.data?.photoFiles).toEqual(["photo-2.jpg"]);
    expect(resolved.data?.photoUrls).toEqual(["https://cdn.example/a/photo-2.jpg"]);
    expect(resolved.suppliedFields).toContain("photos");
  });

  it("preserves the user's selected photo order", () => {
    const clone = storedClone({ picks: { condition: "New" }, photoSelection: ["photo-2.jpg", "photo-1.jpg"] });
    const resolved = resolveJobData(clone);
    expect(resolved.data?.photoFiles).toEqual(["photo-2.jpg", "photo-1.jpg"]);
    expect(resolved.data?.photoUrls).toEqual([
      "https://cdn.example/a/photo-2.jpg",
      "https://cdn.example/a/photo-1.jpg",
    ]);
  });

  it("preserves the owner's selected photo order in the job payload", () => {
    const clone = storedClone({ picks: { condition: "New" }, photoSelection: ["photo-2.jpg", "photo-1.jpg"] });
    const resolved = resolveJobData(clone);
    expect(resolved.data?.photoFiles).toEqual(["photo-2.jpg", "photo-1.jpg"]);
    expect(resolved.data?.photoUrls).toEqual([
      "https://cdn.example/a/photo-2.jpg",
      "https://cdn.example/a/photo-1.jpg",
    ]);
  });

  it("blocks selected media when the recovered gallery was incomplete", () => {
    const clone = storedClone({ picks: { condition: "New" }, photoSelection: ["photo-1.jpg"] });
    const photos = clone.recovery!.photos as NonNullable<typeof clone.recovery>["photos"] & {
      complete?: boolean;
    };
    photos.complete = false;
    const resolved = resolveJobData(clone);
    expect(resolved.data).toBeNull();
    expect(resolved.missing).toContain("photos");
  });

  it("blocks the job when no photo actually downloaded", () => {
    const clone = storedClone({ picks: { condition: "New" } });
    clone.recovery!.photos = { urls: ["https://cdn.example/a/p.jpg"], files: [null], downloaded: 0 };
    const resolved = resolveJobData(clone);
    expect(resolved.data).toBeNull();
    expect(resolved.missing).toContain("photos");
  });

  it("blocks the job when any recovered photo slot failed", () => {
    const clone = storedClone({ picks: { condition: "New" } });
    clone.recovery!.photos = {
      urls: ["https://cdn.example/a/one.jpg", "https://cdn.example/a/two.jpg"],
      files: ["photo-1.jpg", null],
      downloaded: 1,
    };
    const resolved = resolveJobData(clone);
    expect(resolved.data).toBeNull();
    expect(resolved.missing).toContain("photos");
  });

  it("blocks a selected subset when any gallery slot failed recovery", () => {
    const clone = storedClone({ picks: { condition: "New" }, photoSelection: ["photo-1.jpg"] });
    clone.recovery!.photos = Object.assign({
      urls: ["https://cdn.example/a/one.jpg", "https://cdn.example/a/two.jpg"],
      files: ["photo-1.jpg", null],
      downloaded: 1,
    }, {
      complete: true,
      expectedCount: 2,
      identities: ["media-1", "media-2"],
      reasons: [null, "Download failed"],
    });
    const resolved = resolveJobData(clone);
    expect(resolved.data).toBeNull();
    expect(resolved.missing).toContain("photos");
  });

  it("blocks a video that is present but was not downloaded", () => {
    const clone = storedClone({ picks: { condition: "New" } });
    clone.recovery!.video = {
      present: true,
      state: "present_not_downloaded",
      file: null,
      reason: "Download failed",
    };
    const resolved = resolveJobData(clone);
    expect(resolved.data).toBeNull();
    expect(resolved.missing).toContain("video");
  });

  it("blocks unknown video presence instead of treating it as absent", () => {
    const clone = storedClone({ picks: { condition: "New" } });
    clone.recovery!.video = { present: null as unknown as boolean, state: "none", file: null, reason: null };
    const resolved = resolveJobData(clone);
    expect(resolved.data).toBeNull();
    expect(resolved.missing).toContain("video");
  });

  it("blocks inconsistent photo slot and download-count evidence", () => {
    const clone = storedClone({ picks: { condition: "New" } });
    clone.recovery!.photos.downloaded = 1;
    const resolved = resolveJobData(clone);
    expect(resolved.data).toBeNull();
    expect(resolved.missing).toContain("photos");
  });

  it("blocks legacy photos whose gallery completeness was never established", () => {
    const clone = storedClone({ picks: { condition: "New" } });
    clone.recovery!.photos = {
      urls: ["https://cdn.example/a/photo-1.jpg", "https://cdn.example/a/photo-2.jpg"],
      files: ["photo-1.jpg", "photo-2.jpg"],
      downloaded: 2,
    };
    const resolved = resolveJobData(clone);
    expect(resolved.data).toBeNull();
    expect(resolved.missing).toContain("photos");
  });

  it("does not use a non-null field value when updated recovery marks it unknown", () => {
    const clone = storedClone({ picks: { condition: "New" } });
    clone.recovery!.title = Object.assign(recovered("Widget", "edit_form"), { state: "unknown" as const });
    const resolved = resolveJobData(clone);
    expect(resolved.data).toBeNull();
    expect(resolved.missing).toContain("title");
  });

  it("accepts an explicit field pick when recovery marked that field unknown", () => {
    const clone = storedClone({ picks: { condition: "New" } });
    clone.recovery!.condition = Object.assign(missing<string>("Condition was unreadable."), {
      state: "unknown" as const,
    });
    const resolved = resolveJobData(clone);
    expect(resolved.missing).toEqual([]);
    expect(resolved.data?.condition).toBe("New");
    expect(resolved.suppliedFields).toContain("condition");
  });

  it("blocks a photo selection containing an unrecognized archive file", () => {
    const clone = storedClone({ picks: { condition: "New" }, photoSelection: ["other-user.jpg"] });
    const resolved = resolveJobData(clone);
    expect(resolved.data).toBeNull();
    expect(resolved.missing).toContain("photos");
  });

  it("blocks a photo recovery path that escapes the archive basename", () => {
    const clone = storedClone({ picks: { condition: "New" } });
    clone.recovery!.photos.files[0] = "../../other-user/secret.jpg";
    const resolved = resolveJobData(clone);
    expect(resolved.data).toBeNull();
    expect(resolved.missing).toContain("photos");
  });

  it("requires a user decision for unknown shipping and meetup details", () => {
    const clone = storedClone({ picks: { condition: "New", delivery: "Local pickup only" } });
    clone.recovery!.delivery = missing("Step 2 blocked.");
    const resolved = resolveJobData(clone);
    expect(resolved.data).toBeNull();
    expect(resolved.missing).toContain("delivery.shipping");
    expect(resolved.missing).toContain("delivery.meetup");
  });

  it("does not treat unknown attributes as an empty recovered set", () => {
    const clone = storedClone({ picks: { condition: "New" } });
    clone.recovery!.attributes = missing("Attributes were unreadable.");
    const resolved = resolveJobData(clone);
    expect(resolved.data).toBeNull();
    expect(resolved.missing).toContain("attributes");
  });

  it("does not interpret a mismatched listing page as the requested listing", () => {
    const snap = snapshot({
      url: "https://www.facebook.com/marketplace/item/999",
      form: {
        inputs: [],
        selects: [],
        checkboxes: [],
        switches: [],
        buttons: [{ label: "Edit listing", disabled: false }],
      },
    });
    expect(interpretListingAvailability(snap, "222")).toBe("unknown");
  });

  it("does not infer availability from generic details and a price", () => {
    const snap = snapshot({
      text: "Widget $30 Listed in San Diego, CA",
      detailRows: [{ label: "Condition", value: "Used - like new" }],
    });
    expect(interpretListingAvailability(snap, "222")).toBe("unknown");
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

  it("does not treat same-day title+price as a duplicate when the photo differs", () => {
    const fp = fingerprintOf(data, "111");
    const rotated = card({ photoUrl: "https://cdn.example/other/zzz.jpg", listedDate: "2026-11-09" });
    expect(matchesFingerprint(rotated, fp, "2026-11-09")).toBe(false);
  });

  it("does not treat a listing date as proof that a duplicate is this job's copy", () => {
    const fp = fingerprintOf(data, "111");
    const sameDayUnrelated = card({
      photoUrl: "https://cdn.example/other/zzz.jpg",
      listedDate: "2026-11-09",
    });
    expect(matchesFingerprint(sameDayUnrelated, fp, "2026-11-09")).toBe(false);
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
    expect(interpretListingAvailability(snap, "222")).toBe("available");
  });

  it("reads a review banner as in_review", () => {
    const snap = snapshot({ text: "Your listing is in review. We'll let you know." });
    expect(interpretListingAvailability(snap, "222")).toBe("in_review");
  });


  it("reads a dead page as gone", () => {
    const snap = snapshot({ text: "This listing is no longer available." });
    expect(interpretListingAvailability(snap, "222")).toBe("gone");
  });

  it("does not infer availability from generic details and a price", () => {
    const snap = snapshot({
      text: "Widget $30 Listed in San Diego, CA",
      detailRows: [{ label: "Condition", value: "Used - like new" }],
    });
    expect(interpretListingAvailability(snap, "222")).toBe("unknown");
  });

  it("is honestly unknown for an unreadable page", () => {
    expect(interpretListingAvailability(snapshot({ text: "Something else entirely" }), "222")).toBe(
      "unknown",
    );
  });
});
