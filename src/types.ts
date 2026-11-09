export interface MeetupPrefs {
  public: boolean;
  doorPickup: boolean;
  doorDropoff: boolean;
}

export type SessionStatus = "connected" | "expired" | "none";

export interface Account {
  id: string;
  displayName: string;
  initials: string;
  sessionStatus: SessionStatus;
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

export type TabId = "listings" | "history" | "settings";

export type View =
  | { kind: "tabs" }
  | { kind: "detail"; listing: Listing }
  | { kind: "progress"; listing: Listing }
  | { kind: "connect" };
