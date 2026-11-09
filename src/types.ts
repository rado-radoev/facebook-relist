export interface MeetupPrefs {
  public: boolean;
  doorPickup: boolean;
  doorDropoff: boolean;
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
  shipping?: string;
  meetup?: MeetupPrefs;
  attributes?: Record<string, string>;
  locationLabel: string;
}

export type TabId = "listings" | "history";

export type View =
  | { kind: "tabs" }
  | { kind: "detail"; listing: Listing }
  | { kind: "progress"; listing: Listing }
  | { kind: "connect" };
