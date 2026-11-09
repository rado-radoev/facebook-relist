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

export function applyClone(listing: Listing, clone: StoredClone): Listing {
  const recovery = clone.recovery;
  if (!recovery) {
    return listing;
  }
  const merged: Listing = { ...listing };
  merged.title = recovery.title.value ?? "";
  merged.price = recovery.price.value ?? "";
  merged.description = recovery.description.value ?? "";
  merged.category = recovery.category.value;
  merged.condition = recovery.condition.value ?? "";
  merged.conditionFlag = recovery.condition.value ? null : recovery.condition.reason ?? "Condition was not recovered";
  merged.location = recovery.location.value ?? "";
  merged.locationLabel = recovery.location.value ?? "";
  merged.deliveryInfo = recovery.delivery.value;
  merged.delivery = recovery.delivery.value?.type ?? null;
  const delivery = recovery.delivery.value;
  if (delivery) {
    if (delivery.shipping !== null) {
      merged.shipping = delivery.shipping ? "Offered" : "Not offered";
    }
    if (delivery.meetup) {
      merged.meetup = delivery.meetup;
    }
  }
  merged.attributes = recovery.attributes.value ?? undefined;
  merged.recoveryReasons = {
    title: recovery.title.reason ?? (!recovery.title.value?.trim() ? "Facebook returned an empty title; provide a title before continuing." : undefined),
    price: recovery.price.reason ?? (!recovery.price.value?.trim() ? "Facebook returned an empty price; provide a price before continuing." : undefined),
    description: recovery.description.reason ?? (!recovery.description.value?.trim() ? "Facebook returned an empty description; provide text before continuing." : undefined),
    category: recovery.category.reason ?? undefined,
    condition: recovery.condition.reason ?? undefined,
    location: recovery.location.reason ?? (!recovery.location.value?.trim() ? "Facebook returned no location text; enter a location before continuing." : undefined),
    delivery: recovery.delivery.reason ?? undefined,
    attributes: recovery.attributes.reason ?? undefined,
    photos: recovery.photos.files.some((file, index) => !file
      ? `Photo ${index + 1} has no downloaded archive file; the backend did not provide a per-photo failure reason.`
      : false) ? "One or more photo archive slots could not be downloaded; see each photo tile for its slot." : undefined,
    video: recovery.video.reason ?? undefined,
  };
  merged.fieldStates = {
    title: recovery.title.state ?? (recovery.title.value === null ? "missing" : "recovered"),
    price: recovery.price.state ?? (recovery.price.value === null ? "missing" : "recovered"),
    description: recovery.description.state ?? (recovery.description.value === null ? "missing" : "recovered"),
    category: recovery.category.state ?? (recovery.category.value === null ? "missing" : "recovered"),
    condition: recovery.condition.state ?? (recovery.condition.value === null ? "missing" : "recovered"),
    location: recovery.location.state ?? (recovery.location.value === null ? "missing" : "recovered"),
    delivery: recovery.delivery.state ?? (recovery.delivery.value?.type ? "recovered" : "missing"),
    attributes: recovery.attributes.state ?? (recovery.attributes.value === null ? "missing" : "recovered"),
    photos: recovery.photos.complete === false || recovery.photos.files.some((file) => !file)
      ? "missing"
      : recovery.photos.complete === true && recovery.photos.expectedCount === recovery.photos.files.length && recovery.photos.downloaded === recovery.photos.files.length
        ? "recovered"
        : "unknown",
    video: recovery.video.state === "unknown"
      ? "unknown"
      : recovery.video.state === "present_not_downloaded"
        ? "missing"
        : recovery.video.state === "none" && recovery.video.present === false
          ? "not_applicable"
          : recovery.video.state === "recovered" && recovery.video.present === true && recovery.video.file
            ? "recovered"
            : "unknown",
  };
  merged.videoReason = recovery.video.reason;
  merged.photoCount = recovery.photos.expectedCount ?? (recovery.photos.complete === true ? recovery.photos.urls.length : null);
  merged.photosDownloaded = recovery.photos.downloaded;
  merged.photoReasons = recovery.photos.reasons ?? recovery.photos.files.map((file) => file ? null : "The backend did not include a reason for this unreadable photo slot.");
  merged.photoCompleteness = recovery.photos.complete === true && recovery.photos.expectedCount === recovery.photos.files.length
    ? "complete"
    : recovery.photos.complete === false
      ? "incomplete"
      : "unknown";
  merged.photoExpectedCount = recovery.photos.expectedCount ?? null;
  merged.photoIdentities = recovery.photos.identities;
  merged.videoState = recovery.video.state;
  merged.videoPresence = recovery.video.present === true ? "present" : recovery.video.present === false ? "absent" : "unknown";
  merged.videoCount = recovery.video.present === true || recovery.video.state === "recovered" || recovery.video.state === "present_not_downloaded" ? 1 : 0;
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
