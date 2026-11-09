import type { Listing } from "../types";

export type CheckState = "ok" | "warn" | "unknown";

export interface CheckRow {
  label: string;
  value: string;
  state: CheckState;
}

function categoryRow(listing: Listing): CheckRow {
  if (listing.category) {
    return { label: "Category", value: `${listing.category} (stored value)`, state: "ok" };
  }
  return { label: "Category", value: "Not checked yet — the backend reads the stored value", state: "unknown" };
}

function conditionRow(listing: Listing): CheckRow {
  if (listing.conditionFlag) {
    // Flagged means: recovered data conflicts, so we warn instead of guessing.
    return { label: "Condition", value: listing.conditionFlag, state: "warn" };
  }
  return { label: "Condition", value: listing.condition, state: "ok" };
}

function photosRow(listing: Listing): CheckRow {
  if (listing.photoCount !== null) {
    let value = `${listing.photoCount} of ${listing.photoCount} downloaded`;
    if (listing.videoCount > 0) {
      value += ` · ${listing.videoCount} video to carry over (untested)`;
    }
    return { label: "Photos", value, state: "ok" };
  }
  return { label: "Photos", value: "Not counted yet — the backend downloads all of them", state: "unknown" };
}

function deliveryRow(listing: Listing): CheckRow {
  if (!listing.delivery) {
    return { label: "Delivery", value: "Not checked yet — read from the listing's delivery step", state: "unknown" };
  }
  if (listing.delivery.startsWith("Not readable")) {
    return { label: "Delivery", value: listing.delivery, state: "warn" };
  }
  let value = listing.delivery;
  if (listing.shipping) {
    value += ` · Shipping: ${listing.shipping}`;
  }
  return { label: "Delivery", value, state: "ok" };
}

export function buildCloneCheck(listing: Listing): CheckRow[] {
  return [
    { label: "Title", value: listing.title.replace(/\s+/g, " ").trim(), state: "ok" },
    { label: "Price", value: listing.price, state: "ok" },
    { label: "Description", value: listing.description.trim(), state: "ok" },
    categoryRow(listing),
    conditionRow(listing),
    photosRow(listing),
    { label: "Location", value: listing.locationLabel, state: "ok" },
    deliveryRow(listing),
  ];
}

const STATE_ICON: Record<CheckState, string> = {
  ok: "✅",
  warn: "⚠️",
  unknown: "•",
};

interface Props {
  listing: Listing;
}

export default function CloneCheckList({ listing }: Props) {
  const rows = buildCloneCheck(listing);

  return (
    <section className="card">
      <h2 className="card-title">Clone check</h2>
      <p className="card-sub">Everything the app recovered from your listing, before anything is created.</p>
      <ul className="check-list">
        {rows.map((row) => (
          <li key={row.label} className={`check-row check-${row.state}`}>
            <span className="check-icon" aria-hidden="true">
              {STATE_ICON[row.state]}
            </span>
            <span className="check-body">
              <span className="check-label">{row.label}</span>
              <span className="check-value">{row.value}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
