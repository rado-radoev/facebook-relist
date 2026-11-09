// Pure job logic: resolving a stored clone check into job data,
// duplicate fingerprints, and reading a listing page's availability.
//
// Everything here is a pure function — no store, no browser, no clock —
// so the safety-critical decisions (is this clone complete? does that
// selling-list card look like the copy we already created? is the new
// listing actually live?) are unit-testable without Facebook.

import path from "node:path";
import type { DeliveryInfo, StoredClone, SyncedListing } from "./cloneTypes.js";
import type { CloneJobData } from "./jobTypes.js";
import type { PageSnapshot } from "./snapshot.js";

// ---------------------------------------------------------------------------
// Clone check → job data

/** Parse the attributes editor's "Label: Value" lines (the same format
 *  the frontend editor round-trips) back into a record. */
export function parseAttributesText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const label = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (label && value) {
      result[label] = value;
    }
  }
  return result;
}

export interface ResolvedJobData {
  /** Present only when `missing` is empty. */
  data: CloneJobData | null;
  /** Names of fields still missing/unpicked — a job must not start
   *  while this is non-empty (requirements §3 step 3). */
  missing: string[];
  /** Fields whose final value came from a pick or an edit. */
  suppliedFields: string[];
}

/**
 * Resolve a stored clone check (recovery + the person's picks/edits)
 * into the exact data a recreate job would post. Picks fill fields
 * Facebook could not recover; edits replace recovered values. A field
 * that is still absent after both is reported missing — never guessed.
 */
export function resolveJobData(clone: StoredClone): ResolvedJobData {
  const recovery = clone.recovery;
  if (!recovery) {
    return { data: null, missing: ["clone_check"], suppliedFields: [] };
  }
  const picks = clone.picks;
  const edits = clone.edits;
  const supplied = new Set<string>();
  const missing: string[] = [];

  function resolveText(
    field: "title" | "price" | "description" | "category" | "condition" | "location",
    recoveredValue: string | null,
    pickValue: string | undefined,
  ): string | null {
    const edit = edits[field];
    if (edit !== undefined) {
      supplied.add(field);
      if (edit.trim().length > 0 || field === "description") {
        return edit;
      }
      missing.push(field);
      return null;
    }
    const result = (recovery as NonNullable<typeof recovery>)[field] as {
      state?: "recovered" | "missing" | "unknown" | "not_applicable";
    };
    if (result.state !== undefined && result.state !== "recovered") {
      if (pickValue && pickValue.trim().length > 0) {
        supplied.add(field);
        return pickValue;
      }
      missing.push(field);
      return null;
    }
    if (recoveredValue !== null && recoveredValue.trim().length > 0) {
      return recoveredValue;
    }
    if (pickValue && pickValue.trim().length > 0) {
      supplied.add(field);
      return pickValue;
    }
    missing.push(field);
    return null;
  }

  const title = resolveText("title", recovery.title.value, undefined);
  const price = resolveText("price", recovery.price.value, undefined);
  const description = resolveText("description", recovery.description.value, undefined);
  const category = resolveText("category", recovery.category.value, picks.category);
  const condition = resolveText("condition", recovery.condition.value, picks.condition);
  const location = resolveText("location", recovery.location.value, undefined);

  // Delivery flags are independent clone fields. A type pick cannot
  // silently stand in for unread shipping or meetup options.
  let delivery: DeliveryInfo | null = recovery.delivery.value;
  const structuredDeliveryEdits = clone.deliveryEdits ?? {};
  if (structuredDeliveryEdits.shipping !== undefined || structuredDeliveryEdits.meetup !== undefined) {
    supplied.add("delivery");
    delivery = {
      type: delivery?.type ?? null,
      shipping: structuredDeliveryEdits.shipping !== undefined
        ? structuredDeliveryEdits.shipping
        : delivery?.shipping ?? null,
      meetup: {
        public: structuredDeliveryEdits.meetup?.public !== undefined
          ? structuredDeliveryEdits.meetup.public
          : delivery?.meetup?.public ?? null,
        doorPickup: structuredDeliveryEdits.meetup?.doorPickup !== undefined
          ? structuredDeliveryEdits.meetup.doorPickup
          : delivery?.meetup?.doorPickup ?? null,
        doorDropoff: structuredDeliveryEdits.meetup?.doorDropoff !== undefined
          ? structuredDeliveryEdits.meetup.doorDropoff
          : delivery?.meetup?.doorDropoff ?? null,
      },
    };
  }
  const deliveryEdit = edits.delivery;
  const deliveryPick = picks.delivery;
  if (deliveryEdit && deliveryEdit.trim().length > 0) {
    supplied.add("delivery");
    delivery = {
      type: deliveryEdit,
      shipping: delivery?.shipping ?? null,
      meetup: delivery?.meetup ?? null,
    };
  } else if (!delivery?.type && deliveryPick && deliveryPick.trim().length > 0) {
    supplied.add("delivery");
    delivery = {
      type: deliveryPick,
      shipping: delivery?.shipping ?? null,
      meetup: delivery?.meetup ?? null,
    };
  }
  if (!delivery?.type) {
    missing.push("delivery.type");
  }
  if (typeof delivery?.shipping !== "boolean") {
    missing.push("delivery.shipping");
  }
  const meetup = delivery?.meetup;
  if (
    !meetup ||
    typeof meetup.public !== "boolean" ||
    typeof meetup.doorPickup !== "boolean" ||
    typeof meetup.doorDropoff !== "boolean"
  ) {
    missing.push("delivery.meetup");
  }

  // An absent attributes object is not proof that the listing had no
  // attributes. Empty recovered {} is accepted only as explicit evidence.
  let attributes = recovery.attributes.value;
  const attributesEdit = edits.attributes;
  if (attributesEdit !== undefined) {
    supplied.add("attributes");
    attributes = parseAttributesText(attributesEdit);
  }
  const attributeState = (recovery.attributes as typeof recovery.attributes & {
    state?: "recovered" | "missing" | "unknown" | "not_applicable";
  }).state;
  if (attributes === null || (attributeState !== undefined && attributeState !== "recovered" && attributesEdit === undefined)) {
    missing.push("attributes");
    attributes = {};
  }

  // A user photo selection is explicit consent to omit unselected slots;
  // without one every recovered slot must be present. Never resolve a
  // supplied filename by basename or silently shift a failed slot.
  const selection = clone.photoSelection;
  const photoEvidence = recovery.photos as typeof recovery.photos & {
    complete?: boolean;
    expectedCount?: number | null;
    identities?: string[];
    reasons?: Array<string | null>;
  };
  const failedPhotoSlot = recovery.photos.files.some((file) => file === null) ||
    (photoEvidence.reasons?.some((reason) => reason !== null) ?? false);
  if (
    !Array.isArray(recovery.photos.files) ||
    !Array.isArray(recovery.photos.urls) ||
    photoEvidence.complete !== true ||
    !Number.isInteger(photoEvidence.expectedCount) ||
    photoEvidence.expectedCount !== recovery.photos.files.length ||
    !Array.isArray(photoEvidence.identities) ||
    photoEvidence.identities.length !== recovery.photos.files.length ||
    new Set(photoEvidence.identities).size !== photoEvidence.identities.length ||
    (photoEvidence.reasons !== undefined && photoEvidence.reasons.length !== recovery.photos.files.length) ||
    failedPhotoSlot ||
    recovery.photos.files.length !== recovery.photos.urls.length ||
    !Number.isInteger(recovery.photos.downloaded) ||
    recovery.photos.downloaded !== recovery.photos.files.filter((file) => typeof file === "string" && file.length > 0).length
  ) {
    missing.push("photos");
  }
  const photoFiles: string[] = [];
  const photoUrls: string[] = [];
  const photosByFile = new Map<string, string>();
  for (const [index, fileName] of recovery.photos.files.entries()) {
    const url = recovery.photos.urls[index];
    if (fileName && url && path.basename(fileName) === fileName) {
      photosByFile.set(fileName, url);
      if (!selection) {
        photoFiles.push(fileName);
        photoUrls.push(url);
      }
    } else if (!selection) {
      missing.push("photos");
    }
  }
  if (selection) {
    supplied.add("photos");
    if (new Set(selection).size !== selection.length || selection.some((file) => !photosByFile.has(file))) {
      missing.push("photos");
    } else {
      for (const fileName of selection) {
        photoFiles.push(fileName);
        photoUrls.push(photosByFile.get(fileName) as string);
      }
    }
  }
  if (photoFiles.length === 0) {
    missing.push("photos");
  }

  if (typeof recovery.video.present !== "boolean") {
    missing.push("video");
  }
  if (recovery.video.present && recovery.video.state !== "recovered") {
    missing.push("video");
  }
  if (!recovery.video.present && recovery.video.state !== "none") {
    missing.push("video");
  }
  const videoFile = recovery.video.state === "recovered" ? recovery.video.file : null;
  if (recovery.video.state === "recovered" && !videoFile) {
    missing.push("video");
  }

  if (missing.length > 0) {
    return { data: null, missing, suppliedFields: [...supplied] };
  }
  return {
    data: {
      title: title as string,
      price: price as string,
      description: description as string,
      category: category as string,
      condition: condition as string,
      attributes,
      location: location as string,
      delivery: delivery as DeliveryInfo,
      photoFiles,
      photoUrls,
      videoFile,
    },
    missing: [],
    suppliedFields: [...supplied],
  };
}

// ---------------------------------------------------------------------------
// Duplicate guard fingerprint
//
// Before any create (and before any create RETRY after a crash), the job
// checks the person's own selling list for a copy it may already have
// made. A copy matches on normalised title + normalised price + the
// photo fingerprint of the first photo. This is best-effort by nature —
// Facebook serves re-uploaded photos from new CDN paths — so the photo
// signal is the CDN path's file name, and a title+price match on a card
// listed the same day also counts (documented in the README).

export interface ListingFingerprint {
  listingId: string;
  title: string;
  price: string;
  photoKey: string;
}

export function normalizeTitleKey(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

export function normalizePriceKey(price: string): string {
  return price.replace(/[^0-9.]/g, "");
}

export function photoKeyOf(url: string): string {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter((part) => part.length > 0);
    return parts.length > 0 ? parts[parts.length - 1] : "";
  } catch {
    return url;
  }
}

export function fingerprintOf(data: CloneJobData, listingId: string): ListingFingerprint {
  return {
    listingId,
    title: normalizeTitleKey(data.title),
    price: normalizePriceKey(data.price),
    photoKey: photoKeyOf(data.photoUrls[0] ?? ""),
  };
}

export function fingerprintString(fp: ListingFingerprint): string {
  return `${fp.title}|${fp.price}|${fp.photoKey}`;
}

/**
 * Does a selling-list card look like the copy this job is creating?
 * The job's OWN old listing never counts (same title/price/photo is
 * exactly what a clone looks like before the copy exists).
 */
export function matchesFingerprint(
  card: SyncedListing,
  fp: ListingFingerprint,
  _todayIsoDate: string,
): boolean {
  if (card.id === fp.listingId) {
    return false;
  }
  if (normalizeTitleKey(card.title) !== fp.title) {
    return false;
  }
  if (normalizePriceKey(card.price) !== fp.price) {
    return false;
  }
  return Boolean(fp.photoKey) && photoKeyOf(card.photoUrl) === fp.photoKey;
}

// ---------------------------------------------------------------------------
// Watch step: is the new listing live yet?

export type ListingAvailability = "available" | "in_review" | "gone" | "unknown";

const GONE_MARKERS = [
  "no longer available",
  "couldn't find this page",
  "could not find this page",
  "page isn't available",
  "content isn't available",
];

const REVIEW_MARKERS = [
  "in review",
  "being reviewed",
  "under review",
  "is being checked",
  "reviewing your listing",
];

/** Seller-view controls that only exist on a live listing's page. */
const SELLER_LIVE_BUTTONS = ["mark as sold", "mark as pending", "edit listing"];

/**
 * Interpret a listing-page snapshot as an availability state. Seller
 * controls (the owner viewing their own live listing) and the Details
 * section are the positive signals; Facebook's review banner means
 * still-in-review; a dead page means gone; anything else is honestly
 * "unknown" and the watch step keeps polling.
 */
export function interpretListingAvailability(
  snapshot: PageSnapshot,
  expectedListingId: string,
): ListingAvailability {
  let actual: URL;
  try {
    actual = new URL(snapshot.url);
  } catch {
    return "unknown";
  }
  if (
    actual.protocol !== "https:" ||
    !["facebook.com", "www.facebook.com"].includes(actual.hostname) ||
    actual.pathname !== `/marketplace/item/${expectedListingId}` ||
    actual.search !== "" ||
    actual.hash !== ""
  ) {
    return "unknown";
  }
  const text = snapshot.text.toLowerCase();
  for (const marker of GONE_MARKERS) {
    if (text.includes(marker)) {
      return "gone";
    }
  }
  for (const marker of REVIEW_MARKERS) {
    if (text.includes(marker)) {
      return "in_review";
    }
  }
  const buttons = (snapshot.form?.buttons ?? []).map((button) => button.label.toLowerCase());
  for (const live of SELLER_LIVE_BUTTONS) {
    if (buttons.some((label) => label === live || label.startsWith(live))) {
      return "available";
    }
  }
  return "unknown";
}
