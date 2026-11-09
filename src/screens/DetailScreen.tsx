import { useEffect, useState } from "react";
import type { Listing } from "../types";
import type { FieldPicks, PickableField } from "../lib/fieldOptions";
import StatusPill from "../components/StatusPill";
import CloneCheckList, {
  missingFields,
  type EditableField,
  type FieldOverrides,
} from "../components/CloneCheckList";

interface Props {
  listing: Listing;
  onBack: () => void;
  onRecreate: (listing: Listing) => void;
}

function storageKey(kind: "picks" | "edits", listingId: string): string {
  return `relist:${kind}:${listingId}`;
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable — values still apply for this session.
  }
}

/**
 * The listing the recreate will actually use: picks fill the fields
 * Facebook did not give back, edits replace recovered values.
 */
function effectiveListing(listing: Listing, picks: FieldPicks, overrides: FieldOverrides): Listing {
  const effective: Listing = { ...listing };
  if (picks.condition) {
    effective.condition = picks.condition;
    effective.conditionFlag = null;
  }
  if (picks.category) {
    effective.category = picks.category;
  }
  if (picks.delivery) {
    effective.delivery = picks.delivery;
  }
  if (overrides.title) {
    effective.title = overrides.title;
  }
  if (overrides.price) {
    effective.price = overrides.price;
  }
  if (overrides.description) {
    effective.description = overrides.description;
  }
  if (overrides.location) {
    effective.locationLabel = overrides.location;
    effective.location = overrides.location;
  }
  if (overrides.category) {
    effective.category = overrides.category;
  }
  if (overrides.condition) {
    effective.condition = overrides.condition;
  }
  if (overrides.delivery) {
    effective.delivery = overrides.delivery;
  }
  return effective;
}

export default function DetailScreen({ listing, onBack, onRecreate }: Props) {
  const title = listing.title.replace(/\s+/g, " ").trim();
  // Picks (fields Facebook did not give back) and edits (changes to
  // recovered fields) are both saved per listing, so recreating the same
  // item reuses them. In the full app the backend saves them; here
  // localStorage stands in.
  const [picks, setPicks] = useState<FieldPicks>(() =>
    loadJson<FieldPicks>(storageKey("picks", listing.listing_id), {}),
  );
  const [overrides, setOverrides] = useState<FieldOverrides>(() =>
    loadJson<FieldOverrides>(storageKey("edits", listing.listing_id), {}),
  );

  useEffect(() => {
    saveJson(storageKey("picks", listing.listing_id), picks);
  }, [picks, listing.listing_id]);

  useEffect(() => {
    saveJson(storageKey("edits", listing.listing_id), overrides);
  }, [overrides, listing.listing_id]);

  function handlePick(field: PickableField, value: string) {
    setPicks((current) => ({ ...current, [field]: value }));
  }

  function handleOverride(field: EditableField, value: string) {
    setOverrides((current) => ({ ...current, [field]: value }));
  }

  const unanswered = missingFields(listing).filter((field) => !picks[field]);
  const recreateBlocked = unanswered.length > 0;

  return (
    <div className="screen">
      <button type="button" className="back-button" onClick={onBack}>
        ‹ Listings
      </button>

      <img className="detail-photo" src={listing.photo} alt={title} />
      <h1 className="detail-title">{title}</h1>
      <div className="detail-meta">
        <span className="detail-price">{listing.price}</span>
        <StatusPill status={listing.status} />
        <span className="detail-location">{listing.location}</span>
      </div>

      <CloneCheckList
        listing={listing}
        picks={picks}
        onPick={handlePick}
        overrides={overrides}
        onOverride={handleOverride}
      />

      {recreateBlocked ? (
        <p className="blocked-note">
          Pick the highlighted {unanswered.length === 1 ? "field" : "fields"} in the clone check to
          continue — Relist never guesses a value, and your pick is saved for this listing.
        </p>
      ) : null}
      <button
        type="button"
        className="primary-button"
        disabled={recreateBlocked}
        onClick={() => onRecreate(effectiveListing(listing, picks, overrides))}
      >
        Recreate listing
      </button>
      <p className="screen-footnote">
        Recreating makes a brand-new copy first. The old listing stays up until the new one is live.
      </p>
      <a className="external-link" href={listing.product_url} target="_blank" rel="noreferrer">
        View on Facebook ↗
      </a>
    </div>
  );
}
