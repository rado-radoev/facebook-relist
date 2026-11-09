import { describe, expect, it } from "vitest";
import {
  buildCloneFields,
  normalizeCondition,
  normalizeSellingStatus,
  parseEditForm,
  parseListedDate,
  parseListingDetails,
  parseSellingCards,
} from "./facebookExtract.js";
import {
  hotWheelsEditSnapshot,
  hotWheelsListingSnapshot,
  sellingListSnapshot,
  switchesEditStep1Snapshot,
  switchesEditStep2Snapshot,
  switchesListingSnapshot,
} from "./fixtures/index.js";
import type { PageSnapshot } from "./snapshot.js";

const NOW = new Date("2026-11-09T12:00:00Z");

describe("parseSellingCards", () => {
  it("maps the fixture selling list to synced listings", () => {
    const listings = parseSellingCards(sellingListSnapshot.sellingCards ?? [], NOW);
    expect(listings).toHaveLength(2);

    const hotWheels = listings[0];
    expect(hotWheels.id).toBe("2173406210055821");
    expect(hotWheels.title).toBe("Nintendo Switch Hot Wheels Unleashed 2 Turbocharged");
    expect(hotWheels.price).toBe("$30");
    expect(hotWheels.status).toBe("Available");
    expect(hotWheels.listedDate).toBe("2026-10-11");
    expect(hotWheels.url).toBe("https://www.facebook.com/marketplace/item/2173406210055821");
    expect(hotWheels.photoUrl).toContain("hot-wheels/photo-1.jpg");

    const switches = listings[1];
    expect(switches.id).toBe("1452483746465654");
    expect(switches.listedDate).toBe("2026-03-04");
  });

  it("drops cards without a listing id and dedupes repeats", () => {
    const cards = [
      { href: "https://www.facebook.com/marketplace", title: "x", priceText: "", statusText: "", imageUrl: "" },
      ...(sellingListSnapshot.sellingCards ?? []),
      ...(sellingListSnapshot.sellingCards ?? []),
    ];
    expect(parseSellingCards(cards, NOW)).toHaveLength(2);
  });
});

describe("normalizeSellingStatus / parseListedDate", () => {
  it("normalizes the selling-list vocabulary", () => {
    expect(normalizeSellingStatus("Active · Listed on 10/11")).toBe("Available");
    expect(normalizeSellingStatus("Sold")).toBe("Sold");
    expect(normalizeSellingStatus("Out of stock")).toBe("Out of stock");
    expect(normalizeSellingStatus("In stock · Listed on 3/4")).toBe("In stock");
  });

  it("infers the most recent matching year for listed dates", () => {
    expect(parseListedDate("Listed on 10/11", NOW)).toBe("2026-10-11");
    expect(parseListedDate("Listed on 12/25", new Date("2026-01-10T00:00:00Z"))).toBe("2025-12-25");
    expect(parseListedDate("no date here", NOW)).toBeNull();
  });
});

describe("normalizeCondition", () => {
  it("canonicalizes Facebook's casing/dash variants", () => {
    expect(normalizeCondition("Used - like new")).toBe("Used - Like New");
    expect(normalizeCondition("Used – Good")).toBe("Used - Good");
    expect(normalizeCondition("Used - Fair")).toBe("Used - Fair");
    expect(normalizeCondition("New")).toBe("New");
  });
});

describe("parseEditForm — Mechanical Keyboard Switches (full pass)", () => {
  const edit = parseEditForm(switchesEditStep1Snapshot, switchesEditStep2Snapshot);

  it("recovers every Step 1 field", () => {
    expect(edit).not.toBeNull();
    expect(edit?.title).toContain("Mechanical Keyboard");
    expect(edit?.price).toBe("$30");
    expect(edit?.description).toContain("KEYS ONLY");
    expect(edit?.category).toBe("Keyboards & Keypads");
    expect(edit?.condition).toBe("Used - Like New");
    expect(edit?.attributes).toEqual({
      "Is Wireless": "Yes",
      Color: "Green",
      "Has Bluetooth": "Yes",
    });
    expect(edit?.conditionEmpty).toBe(false);
    expect(edit?.step2Blocked).toBe(false);
  });

  it("recovers Step 2 exactly: San Diego, local pickup only, no shipping, no meetup prefs", () => {
    expect(edit?.step2Seen).toBe(true);
    expect(edit?.location).toBe("San Diego");
    expect(edit?.delivery).toEqual({
      type: "Local pickup only",
      shipping: false,
      meetup: { public: false, doorPickup: false, doorDropoff: false },
    });
  });
});

describe("parseEditForm — Hot Wheels (empty condition blocks Step 2)", () => {
  const edit = parseEditForm(hotWheelsEditSnapshot, null);

  it("recovers Step 1 but flags the empty condition and blocked Step 2", () => {
    expect(edit).not.toBeNull();
    expect(edit?.category).toBe("Toys & Games");
    expect(edit?.price).toBe("$30");
    expect(edit?.description).toContain("Can be played bu two people");
    expect(edit?.condition).toBeNull();
    expect(edit?.conditionEmpty).toBe(true);
    expect(edit?.step2Seen).toBe(false);
    expect(edit?.step2Blocked).toBe(true);
    expect(edit?.delivery).toBeNull();
    expect(edit?.location).toBeNull();
  });

  it("returns null when the page held no form at all", () => {
    const bare: PageSnapshot = { url: "https://www.facebook.com/", text: "", images: [], videos: [] };
    expect(parseEditForm(bare, null)).toBeNull();
  });
});

describe("parseListingDetails", () => {
  it("reads the switches Details rows, normalizing condition and (Y/N) labels", () => {
    const details = parseListingDetails(switchesListingSnapshot);
    expect(details.condition).toBe("Used - Like New");
    expect(details.attributes).toEqual({
      Color: "Green",
      "Is Wireless": "Yes",
      "Has Bluetooth": "Yes",
    });
    expect(details.hasConditionPrompt).toBe(false);
    expect(details.locationLabel).toBe("San Diego, CA");
  });

  it("finds no condition for Hot Wheels — only Facebook's add-condition prompt", () => {
    const details = parseListingDetails(hotWheelsListingSnapshot);
    expect(details.condition).toBeNull();
    expect(details.hasConditionPrompt).toBe(true);
    expect(details.locationLabel).toBe("San Diego, CA");
  });
});

describe("buildCloneFields", () => {
  it("switches: every field recovered, edit form first", () => {
    const edit = parseEditForm(switchesEditStep1Snapshot, switchesEditStep2Snapshot);
    const fields = buildCloneFields(edit, parseListingDetails(switchesListingSnapshot));
    expect(fields.title.value).toContain("Mechanical Keyboard");
    expect(fields.price.value).toBe("$30");
    expect(fields.category).toEqual({ value: "Keyboards & Keypads", source: "edit_form", reason: null });
    expect(fields.condition).toEqual({ value: "Used - Like New", source: "edit_form", reason: null });
    expect(fields.delivery.value?.type).toBe("Local pickup only");
    expect(fields.delivery.value?.shipping).toBe(false);
    expect(fields.location.value).toBe("San Diego");
    expect(fields.step2Blocked).toBe(false);
  });

  it("hot wheels: condition + delivery missing with honest reasons, location falls back to the listing page", () => {
    const edit = parseEditForm(hotWheelsEditSnapshot, null);
    const fields = buildCloneFields(edit, parseListingDetails(hotWheelsListingSnapshot));
    expect(fields.category).toEqual({ value: "Toys & Games", source: "edit_form", reason: null });
    expect(fields.condition.value).toBeNull();
    expect(fields.condition.reason).toContain("Add info about your item's condition");
    expect(fields.delivery.value).toBeNull();
    expect(fields.delivery.reason).toContain("blocked Step 2");
    expect(fields.location).toEqual({ value: "San Diego, CA", source: "listing_details", reason: null });
    expect(fields.step2Blocked).toBe(true);
  });

  it("falls back to listing Details when the edit form has no condition selected", () => {
    const step1 = structuredClone(switchesEditStep1Snapshot) as PageSnapshot;
    step1.form = {
      ...step1.form!,
      selects: step1.form!.selects.filter((select) => select.label !== "Condition"),
    };
    const edit = parseEditForm(step1, switchesEditStep2Snapshot);
    expect(edit?.condition).toBeNull();
    const fields = buildCloneFields(edit, parseListingDetails(switchesListingSnapshot));
    expect(fields.condition).toEqual({ value: "Used - Like New", source: "listing_details", reason: null });
  });
});
