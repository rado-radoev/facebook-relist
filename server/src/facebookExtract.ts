// Pure extraction: PageSnapshot → Relist data.
//
// Everything here is a pure function over the snapshot shape (see
// snapshot.ts), so the whole mapping is unit-testable against the saved
// fixture snapshots in src/fixtures/. No Playwright, no network, no
// store. The recovery order is the verified one (requirements §4-C and
// the 2026-11-09 listing-page check):
//
//   1. the owner's Edit form (Step 1 fields, then Step 2 when reachable)
//   2. the listing page's Details section / page text as fallback
//   3. missing — with the reason, never an invented value

import {
  missing,
  recovered,
  unknown,
  type DeliveryInfo,
  type FieldResult,
  type MeetupPrefs,
  type SyncedListing,
} from "./cloneTypes.js";
import type { FormSnapshot, PageSnapshot, SellingCard } from "./snapshot.js";

// ---------------------------------------------------------------------------
// Selling list

const ITEM_ID_PATTERN = /\/marketplace\/item\/(\d+)/;
const LISTED_ON_PATTERN = /Listed on (\d{1,2})\/(\d{1,2})/;

export function listingIdFromHref(href: string): string | null {
  const match = ITEM_ID_PATTERN.exec(href);
  return match ? match[1] : null;
}

/**
 * The selling list shows one undifferentiated "Active" state; the app's
 * "Available" is its active-listing vocabulary (requirements §6). A card
 * whose text names a specific state (Sold / Out of stock / In stock)
 * keeps that state.
 */
export function normalizeSellingStatus(statusText: string): string {
  const tokens = statusText
    .split(/[\n·•|]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const blockedStates = new Set(["draft", "rejected", "in review", "review", "pending", "unavailable"]);
  if (tokens.some((token) => blockedStates.has(token) || token.startsWith("mark as ") || ["renew", "delete", "edit", "boost"].some((action) => token.startsWith(`${action} `)))) {
    return "Unknown";
  }
  const recognized = new Set<string>();
  for (const token of tokens) {
    if (token === "out of stock") {
      recognized.add("Out of stock");
    } else if (token === "in stock") {
      recognized.add("In stock");
    } else if (token === "sold") {
      recognized.add("Sold");
    } else if (token === "active") {
      recognized.add("Available");
    }
  }
  return recognized.size === 1 ? [...recognized][0] : "Unknown";
}

/** "Listed on 10/11" → ISO date, inferring the most recent matching year. */
export function parseListedDate(statusText: string, now: Date): string | null {
  const match = LISTED_ON_PATTERN.exec(statusText);
  if (!match) {
    return null;
  }
  const month = Number(match[1]);
  const day = Number(match[2]);
  let year = now.getFullYear();
  const candidate = new Date(Date.UTC(year, month - 1, day));
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (candidate.getTime() > now.getTime() + oneDayMs) {
    year -= 1;
  }
  const iso = new Date(Date.UTC(year, month - 1, day)).toISOString();
  return iso.slice(0, 10);
}

export function parseSellingCards(cards: SellingCard[], now: Date): SyncedListing[] {
  const syncedAt = now.toISOString();
  const listings: SyncedListing[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    const id = listingIdFromHref(card.href);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    listings.push({
      id,
      title: card.title.replace(/\s+/g, " ").trim(),
      price: card.priceText.trim(),
      status: normalizeSellingStatus(card.statusText),
      statusText: card.statusText,
      photoUrl: card.imageUrl,
      url: `https://www.facebook.com/marketplace/item/${id}`,
      listedDate: parseListedDate(card.statusText, now),
      syncedAt,
    });
  }
  return listings;
}

// ---------------------------------------------------------------------------
// Condition vocabulary

const CONDITION_CANONICAL: Array<{ match: string; canonical: string }> = [
  { match: "used - like new", canonical: "Used - Like New" },
  { match: "used – like new", canonical: "Used - Like New" },
  { match: "used - good", canonical: "Used - Good" },
  { match: "used – good", canonical: "Used - Good" },
  { match: "used - fair", canonical: "Used - Fair" },
  { match: "used – fair", canonical: "Used - Fair" },
  { match: "new", canonical: "New" },
];

/** Facebook writes the same condition with different casing/dashes on
 *  different surfaces ("Used - like new" in Details vs "Used - Like New"
 *  in the edit form). Canonicalize to the app's vocabulary. */
export function normalizeCondition(raw: string): string {
  const lower = raw.trim().toLowerCase();
  for (const entry of CONDITION_CANONICAL) {
    if (lower === entry.match) {
      return entry.canonical;
    }
  }
  return raw.trim();
}

// ---------------------------------------------------------------------------
// Edit form

export interface EditFormData {
  title: string | null;
  price: string | null;
  description: string | null;
  category: string | null;
  condition: string | null;
  attributes: Record<string, string>;
  attributesObserved: boolean;
  location: string | null;
  delivery: DeliveryInfo | null;
  /** True when a Step 2 snapshot was read (reachable or not). */
  step2Seen: boolean;
  /** The known quirk: an empty required field disables Next on Step 1,
   *  which blocks reading Step 2 at all. */
  step2Blocked: boolean;
  conditionEmpty: boolean;
}

function findInput(form: FormSnapshot, labelPart: string): string | null {
  const found = form.inputs.find((field) => field.label.toLowerCase().includes(labelPart));
  if (!found) {
    return null;
  }
  const value = found.value.trim();
  return value.length > 0 ? found.value : null;
}

function findSelect(form: FormSnapshot, labelPart: string): string | null {
  const found = form.selects.find((field) => field.label.toLowerCase().includes(labelPart));
  if (!found) {
    return null;
  }
  const value = found.value.trim();
  return value.length > 0 ? value : null;
}

function formatPrice(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("$")) {
    return trimmed;
  }
  return `$${trimmed}`;
}

function parseMeetup(checkboxes: FormSnapshot["checkboxes"]): MeetupPrefs | null {
  const byLabel = (part: string) =>
    checkboxes.find((box) => box.label.toLowerCase().includes(part));
  const publicBox = byLabel("public meetup");
  const pickupBox = byLabel("door pickup");
  const dropoffBox = byLabel("door dropoff");
  if (!publicBox && !pickupBox && !dropoffBox) {
    return null;
  }
  return {
    public: publicBox?.checked ?? null,
    doorPickup: pickupBox?.checked ?? null,
    doorDropoff: dropoffBox?.checked ?? null,
  };
}

function parseDelivery(step2: FormSnapshot): DeliveryInfo {
  let type = findSelect(step2, "delivery");
  if (!type) {
    // Some layouts expose the chosen delivery as a selected option whose
    // label is the value itself; the selects list carries it either way.
    const known = step2.selects.find((field) =>
      ["local pickup", "meetup", "shipping", "door pickup", "door dropoff"].some((part) =>
        field.value.toLowerCase().includes(part),
      ),
    );
    type = known ? known.value.trim() : null;
  }
  const shippingSwitch = step2.switches.find((entry) =>
    entry.label.toLowerCase().includes("shipping"),
  );
  const shippingBox = step2.checkboxes.find((entry) =>
    entry.label.toLowerCase().includes("shipping"),
  );
  let shipping: boolean | null = null;
  if (shippingSwitch) {
    shipping = shippingSwitch.checked;
  }
  if (shippingBox) {
    shipping = shippingBox.checked;
  }
  return { type, shipping, meetup: parseMeetup(step2.checkboxes) };
}

/**
 * Parse the edit form from its Step 1 snapshot and, when the flow could
 * advance, its Step 2 snapshot. Returns null when the page held no form
 * at all (edit route unavailable / layout changed).
 */
export function parseEditForm(
  step1: PageSnapshot,
  step2: PageSnapshot | null,
): EditFormData | null {
  const form = step1.form;
  if (!form) {
    return null;
  }
  const hasAnyField = form.inputs.length > 0 || form.selects.length > 0;
  if (!hasAnyField) {
    return null;
  }

  const attributes: Record<string, string> = {};
  let condition: string | null = null;
  for (const select of form.selects) {
    const label = select.label.trim();
    const lower = label.toLowerCase();
    if (!label || lower.includes("category") || lower.includes("condition")) {
      continue;
    }
    const value = select.value.trim();
    if (value) {
      attributes[label] = value;
    }
  }

  const conditionRaw = findSelect(form, "condition");
  const nextButton = form.buttons.find((button) => button.label.toLowerCase() === "next");
  const nextDisabled = nextButton ? nextButton.disabled : false;

  let location: string | null = null;
  let delivery: DeliveryInfo | null = null;
  let step2Seen = false;
  if (step2 && step2.form) {
    step2Seen = true;
    location = findInput(step2.form, "location");
    delivery = parseDelivery(step2.form);
  }

  const attributesObserved = form.attributesObserved === true;
  return {
    title: findInput(form, "title"),
    price: formatPrice(findInput(form, "price")),
    description: findInput(form, "description"),
    category: findSelect(form, "category"),
    condition: conditionRaw ? normalizeCondition(conditionRaw) : null,
    attributes,
    attributesObserved,
    location,
    delivery,
    step2Seen,
    step2Blocked: nextDisabled && !step2Seen,
    conditionEmpty: conditionRaw === null,
  };
}

// ---------------------------------------------------------------------------
// Listing page (Details fallback)

export interface ListingDetailsData {
  condition: string | null;
  attributes: Record<string, string>;
  attributesObserved: boolean;
  /** The page itself carries Facebook's "add a condition" prompt — proof
   *  the listing has no condition stored anywhere on Facebook. */
  hasConditionPrompt: boolean;
  locationLabel: string | null;
}

const LISTED_LOCATION_PATTERN = /Listed[^\n]*? in ([A-Za-z][A-Za-z .]*, [A-Z]{2})\b/;

export function parseListingDetails(snapshot: PageSnapshot): ListingDetailsData {
  const attributes: Record<string, string> = {};
  let condition: string | null = null;
  for (const row of snapshot.detailRows ?? []) {
    const label = row.label.trim();
    const value = row.value.trim();
    if (!label || !value) {
      continue;
    }
    if (label.toLowerCase() === "condition") {
      condition = normalizeCondition(value);
      continue;
    }
    attributes[label.replace(/ \(Y\/N\)$/, "")] = value;
  }
  const locationMatch = LISTED_LOCATION_PATTERN.exec(snapshot.text);
  return {
    condition,
    attributes,
    attributesObserved: (snapshot.detailRows ?? []).some((row) =>
      row.label.trim().length > 0 && row.value.trim().length > 0 && row.label.trim().toLowerCase() !== "condition",
    ),
    hasConditionPrompt: snapshot.text.includes("Add info about your item's condition"),
    locationLabel: locationMatch ? locationMatch[1] : null,
  };
}

/** Gallery photo URLs in original order (duplicates removed). */
export function parseGallery(snapshot: PageSnapshot): string[] {
  if (snapshot.gallery?.slots) {
    return snapshot.gallery.slots.map((slot) => slot.url);
  }
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const url of snapshot.images) {
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Merge: edit form first, listing page fallback, missing with a reason.

export interface CloneFields {
  title: FieldResult<string>;
  price: FieldResult<string>;
  description: FieldResult<string>;
  category: FieldResult<string>;
  condition: FieldResult<string>;
  attributes: FieldResult<Record<string, string>>;
  location: FieldResult<string>;
  delivery: FieldResult<DeliveryInfo>;
  step2Blocked: boolean;
}

const EDIT_FORM_UNREADABLE =
  "The edit form could not be read — Facebook may have changed its layout, or the session needs attention.";

export function buildCloneFields(
  edit: EditFormData | null,
  details: ListingDetailsData,
): CloneFields {
  const step2Blocked = edit ? edit.step2Blocked : false;

  let title: FieldResult<string>;
  let price: FieldResult<string>;
  let description: FieldResult<string>;
  let category: FieldResult<string>;
  if (edit && edit.title) {
    title = recovered(edit.title, "edit_form");
  } else {
    title = missing(edit ? "The edit form showed no title." : EDIT_FORM_UNREADABLE);
  }
  if (edit && edit.price) {
    price = recovered(edit.price, "edit_form");
  } else {
    price = missing(edit ? "The edit form showed no price." : EDIT_FORM_UNREADABLE);
  }
  if (edit && edit.description) {
    description = recovered(edit.description, "edit_form");
  } else {
    description = missing(edit ? "The edit form showed no description." : EDIT_FORM_UNREADABLE);
  }
  if (edit && edit.category) {
    category = recovered(edit.category, "edit_form");
  } else {
    category = missing(
      edit
        ? "The edit form showed no category, and the listing page does not expose one."
        : EDIT_FORM_UNREADABLE,
    );
  }

  let condition: FieldResult<string>;
  if (edit && edit.condition) {
    condition = recovered(edit.condition, "edit_form");
  } else if (details.condition) {
    condition = recovered(details.condition, "listing_details");
  } else if (details.hasConditionPrompt) {
    condition = missing(
      "Facebook shows this listing's condition nowhere — the edit form is empty and the listing page itself carries Facebook's 'Add info about your item's condition' prompt.",
    );
  } else {
    condition = missing("Not present in the edit form or the listing page Details.");
  }

  const mergedAttributes: Record<string, string> = { ...details.attributes };
  if (edit) {
    for (const [label, value] of Object.entries(edit.attributes)) {
      mergedAttributes[label] = value;
    }
  }
  const attributesObserved = Boolean(edit?.attributesObserved || details.attributesObserved);
  const attributes: FieldResult<Record<string, string>> = attributesObserved
    ? recovered(mergedAttributes, edit?.attributesObserved ? "edit_form" : "listing_details")
    : unknown("Facebook attributes were not positively observed on the edit or listing surface.");

  let location: FieldResult<string>;
  if (edit && edit.location) {
    location = recovered(edit.location, "edit_form");
  } else if (details.locationLabel) {
    location = recovered(details.locationLabel, "listing_details");
  } else if (step2Blocked) {
    location = missing(
      "Not readable — Facebook's edit form blocked Step 2 (an empty required field disables Next), and the listing page shows no location label.",
    );
  } else {
    location = missing("Not present in the edit form or the listing page.");
  }

  let delivery: FieldResult<DeliveryInfo>;
  if (edit && edit.delivery && edit.delivery.type) {
    delivery = recovered(edit.delivery, "edit_form");
  } else if (step2Blocked) {
    delivery = missing(
      "Not readable — Facebook's edit form blocked Step 2 (an empty required field disables Next), and the listing page does not expose delivery.",
    );
  } else if (edit && edit.step2Seen) {
    delivery = missing("The edit form's Step 2 did not expose the delivery settings.");
  } else {
    delivery = missing(EDIT_FORM_UNREADABLE);
  }

  return {
    title,
    price,
    description,
    category,
    condition,
    attributes,
    location,
    delivery,
    step2Blocked,
  };
}
