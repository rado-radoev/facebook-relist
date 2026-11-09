// Shared shapes for Sprint 2: synced listings and clone recovery.
//
// A recovered field is always a FieldResult: either a value plus where it
// came from, or `value: null` plus the reason it could not be recovered.
// Relist never invents a value — "missing" is a first-class, honest state
// that the clone preview turns into a picker for the person (requirements
// §3). These types are the API contract with the frontend.

/** Where a recovered value came from, in the verified recovery order. */
export type FieldSource = "edit_form" | "listing_details";

export interface FieldResult<T> {
  value: T | null;
  source: FieldSource | null;
  /** Set when value is null: why recovery could not get this field. */
  reason: string | null;
}

export function recovered<T>(value: T, source: FieldSource): FieldResult<T> {
  return { value, source, reason: null };
}

export function missing<T>(reason: string): FieldResult<T> {
  return { value: null, source: null, reason };
}

/** One listing as synced from the person's own selling list. */
export interface SyncedListing {
  id: string;
  title: string;
  /** Display price exactly as Facebook shows it, e.g. "$30". */
  price: string;
  /** Normalized to the app's status vocabulary where possible. */
  status: string;
  /** The status text Facebook showed, kept for honesty/debugging. */
  statusText: string;
  /** Primary photo URL (Facebook CDN). */
  photoUrl: string;
  url: string;
  /** ISO date the listing was created, when the page exposed one. */
  listedDate: string | null;
  syncedAt: string;
}

export interface MeetupPrefs {
  public: boolean;
  doorPickup: boolean;
  doorDropoff: boolean;
}

export interface DeliveryInfo {
  /** e.g. "Local pickup only" — the delivery type the edit form showed. */
  type: string | null;
  /** Whether shipping is set up for the listing. */
  shipping: boolean | null;
  meetup: MeetupPrefs | null;
}

export type VideoState = "none" | "recovered" | "present_not_downloaded";

export interface PhotoRecovery {
  /** Every photo URL the listing page exposed, in original order. */
  urls: string[];
  /** Archive file names (under the user's archive dir), parallel to urls;
   *  null where the download failed. */
  files: Array<string | null>;
  downloaded: number;
}

export interface VideoRecovery {
  present: boolean;
  state: VideoState;
  /** Archive file name when the video file itself was downloaded. */
  file: string | null;
  /** Set when the video is present but was not downloaded: why. */
  reason: string | null;
}

/** The full recovered clone for one listing. */
export interface CloneRecovery {
  listingId: string;
  recoveredAt: string;
  title: FieldResult<string>;
  price: FieldResult<string>;
  description: FieldResult<string>;
  category: FieldResult<string>;
  condition: FieldResult<string>;
  attributes: FieldResult<Record<string, string>>;
  location: FieldResult<string>;
  delivery: FieldResult<DeliveryInfo>;
  photos: PhotoRecovery;
  video: VideoRecovery;
  /**
   * True when Facebook's edit form blocked Step 2 (the known quirk: an
   * empty condition disables Next). Step-2 fields then come from the
   * listing page where possible and are "missing" otherwise.
   */
  step2Blocked: boolean;
}

/** Picks for fields Facebook could not recover — saved per listing. */
export type ClonePicks = Partial<Record<"condition" | "category" | "delivery", string>>;

/** Edits to recovered fields — saved per listing. Keys are field names;
 *  "attributes" is serialized as one "Label: Value" per line. */
export type CloneEdits = Partial<
  Record<
    "title" | "price" | "description" | "category" | "condition" | "delivery" | "location" | "attributes",
    string
  >
>;

/** What the backend persists for one listing's clone check. Recovery is
 *  null until the first clone check runs — picks/edits can be saved
 *  against a listing before that and survive the first recovery. */
export interface StoredClone {
  recovery: CloneRecovery | null;
  picks: ClonePicks;
  edits: CloneEdits;
  /** Photo file names the person kept for the clone, in order. Set only
   *  when they edited the photo selection; null = use all recovered. */
  photoSelection: string[] | null;
  updatedAt: string;
}
