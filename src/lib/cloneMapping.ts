// Mapping between the backend's Sprint 2 DTOs and the frontend Listing
// shape the screens already render.
//
// A synced listing starts as just what the selling list showed (title,
// price, status, primary photo). After a clone recovery runs, applyClone
// folds the recovered fields in — a field Facebook could not give back
// stays empty/missing here exactly as the backend reported it, so the
// clone check offers its picker. Nothing is filled in by guessing.

import type { CloneRecovery, Listing, StoredClone, SyncedListing } from "../types";

export function syncedToListing(synced: SyncedListing, accountId: string): Listing {
  return {
    listing_id: synced.id,
    accountId,
    title: synced.title,
    price: synced.price,
    condition: "",
    description: "",
    location: "",
    status: synced.status,
    creation_date: synced.listedDate ?? "",
    product_url: synced.url,
    photo: synced.photoUrl,
    photoCount: null,
    videoCount: 0,
    category: null,
    conditionFlag: null,
    delivery: null,
    locationLabel: "",
    source: "synced",
  };
}

function deliveryLabel(recovery: CloneRecovery): string | null {
  const delivery = recovery.delivery.value;
  if (!delivery) {
    return recovery.step2Blocked ? "Not readable for this listing (edit form blocked)" : null;
  }
  return delivery.type;
}

export function applyClone(listing: Listing, clone: StoredClone): Listing {
  const recovery = clone.recovery;
  if (!recovery) {
    return listing;
  }
  const merged: Listing = { ...listing };
  if (recovery.title.value) {
    merged.title = recovery.title.value;
  }
  if (recovery.price.value) {
    merged.price = recovery.price.value;
  }
  if (recovery.description.value) {
    merged.description = recovery.description.value;
  }
  merged.category = recovery.category.value;
  if (recovery.condition.value) {
    merged.condition = recovery.condition.value;
    merged.conditionFlag = null;
  } else {
    merged.condition = "";
    merged.conditionFlag = recovery.condition.reason ?? "Condition could not be recovered";
  }
  if (recovery.location.value) {
    merged.location = recovery.location.value;
    merged.locationLabel = recovery.location.value;
  }
  merged.delivery = deliveryLabel(recovery);
  const delivery = recovery.delivery.value;
  if (delivery) {
    if (delivery.shipping !== null) {
      merged.shipping = delivery.shipping ? "Offered" : "Not offered";
    }
    if (delivery.meetup) {
      merged.meetup = delivery.meetup;
    }
  }
  if (recovery.attributes.value) {
    merged.attributes = recovery.attributes.value;
  }
  merged.photoCount = recovery.photos.urls.length;
  merged.photosDownloaded = recovery.photos.downloaded;
  merged.videoCount = recovery.video.present ? 1 : 0;
  merged.videoState = recovery.video.state;
  const firstUrl = recovery.photos.urls[0];
  if (firstUrl) {
    // The selling-list CDN url stays as the display photo; the archived
    // copies are what the clone preview's photo editor works with.
    merged.photo = listing.photo || firstUrl;
  }
  return merged;
}

/** Serialize attributes the way the clone check's editor shows them. */
export function attributesToText(attributes: Record<string, string>): string {
  return Object.entries(attributes)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
}

/** Parse the attributes editor's "Label: Value" lines back to a record. */
export function textToAttributes(text: string): Record<string, string> {
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
