export interface MeetupPrefs {
  public: boolean | null;
  doorPickup: boolean | null;
  doorDropoff: boolean | null;
}

export type SessionStatus =
  | "not_connected"
  | "login_in_progress"
  | "connected"
  | "needs_check"
  | "expired";

/**
 * The one person signed in to Relist on this device. There is deliberately
 * no list of switchable accounts: the backend scopes data by account id,
 * but a device only ever shows its own signed-in person's data.
 */
export interface CurrentUser {
  id: string;
  displayName: string;
  initials: string;
  facebookStatus: SessionStatus;
}

export interface Listing {
  listing_id: string;
  accountId: string;
  title: string;
  price: string;
  condition: string;
  description: string;
  location: string;
  status: string;
  creation_date: string;
  product_url: string;
  photo: string;
  photoCount: number | null;
  videoCount: number;
  category: string | null;
  conditionFlag?: string | null;
  delivery: string | null;
  deliveryInfo?: DeliveryInfo | null;
  shipping?: string;
  meetup?: MeetupPrefs;
  attributes?: Record<string, string>;
  locationLabel: string;
  /** Sprint 2: where this listing came from. "synced" = the backend read
   *  it from the person's own Facebook selling list; seed otherwise. */
  source?: "seed" | "synced";
  /** Sprint 2: how many of the recovered photos actually downloaded. */
  photosDownloaded?: number;
  /** Sprint 2: state of the listing's video in the backend archive. */
  videoState?: "none" | "recovered" | "present_not_downloaded" | "unknown";
  videoPresence?: "present" | "absent" | "unknown";
  /** Per-field recovery explanation, preserved from the backend clone DTO. */
  recoveryReasons?: Partial<
    Record<"title" | "price" | "description" | "category" | "condition" | "location" | "delivery" | "attributes" | "photos" | "video", string>
  >;
  fieldStates?: Partial<Record<"title" | "price" | "description" | "category" | "condition" | "location" | "delivery" | "attributes" | "photos" | "video", "recovered" | "missing" | "unknown" | "not_applicable">>;
  photoReasons?: Array<string | null>;
  photoCompleteness?: "complete" | "incomplete" | "unknown";
  photoExpectedCount?: number | null;
  photoIdentities?: string[];
  videoReason?: string | null;
}

// ---------------------------------------------------------------------------
// Sprint 2 backend DTOs (mirror server/src/cloneTypes.ts)

export interface SyncedListing {
  id: string;
  title: string;
  price: string;
  status: string;
  statusText: string;
  photoUrl: string;
  url: string;
  listedDate: string | null;
  syncedAt: string;
}

export type FieldSource = "edit_form" | "listing_details";

export interface FieldResult<T> {
  value: T | null;
  source: FieldSource | null;
  /** Additive status from newer recoveries; absent on older stored records. */
  state?: "recovered" | "missing" | "unknown" | "not_applicable";
  reason: string | null;
}

export interface DeliveryInfo {
  type: string | null;
  shipping: boolean | null;
  meetup: { public: boolean | null; doorPickup: boolean | null; doorDropoff: boolean | null } | null;
}

export interface PhotoRecovery {
  urls: string[];
  files: Array<string | null>;
  downloaded: number;
  expectedCount?: number | null;
  complete?: boolean;
  identities?: string[];
  reasons?: Array<string | null>;
}

export interface VideoRecovery {
  present: boolean | null;
  state: "none" | "recovered" | "present_not_downloaded" | "unknown";
  file: string | null;
  reason: string | null;
}

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
  step2Blocked: boolean;
}

export type ClonePicks = Partial<Record<"condition" | "category" | "delivery", string>>;

export type CloneEdits = Partial<
  Record<
    "title" | "price" | "description" | "category" | "condition" | "delivery" | "location" | "attributes",
    string
  >
>;

export interface StoredClone {
  recovery: CloneRecovery | null;
  picks: ClonePicks;
  edits: CloneEdits;
  photoSelection: string[] | null;
  updatedAt: string;
}

export type TabId = "listings" | "history";

export type View =
  | { kind: "tabs" }
  | { kind: "detail"; listing: Listing }
  | { kind: "progress"; listing: Listing; jobId?: string }
  | { kind: "connect" };

// ---------------------------------------------------------------------------
// Sprint 3 backend DTOs (mirror server/src/jobTypes.ts)

export type JobStatus =
  | "queued"
  | "creating"
  | "in_review"
  | "available"
  | "deleting"
  | "done"
  | "stuck"
  | "failed";

export interface JobAuditEvent {
  at: string;
  action: string;
  detail: string;
}

export interface RecreateJob {
  id: string;
  listingId: string;
  listingTitle: string;
  oldListingUrl: string;
  status: JobStatus;
  dryRun: boolean;
  suppliedFields: string[];
  newListingId: string | null;
  newListingUrl: string | null;
  createdAt: string;
  updatedAt: string;
  inReviewSince: string | null;
  nextPollAt: string | null;
  lastPolledAt: string | null;
  pollCount: number;
  availableAt: string | null;
  completedAt: string | null;
  error: string | null;
  alert: string | null;
  audit: JobAuditEvent[];
}

export interface JobHistoryEntry {
  id: string;
  jobId: string;
  title: string;
  oldListingId: string;
  oldListingUrl: string;
  newListingId: string;
  newListingUrl: string;
  completedAt: string;
  suppliedFields: string[];
}
