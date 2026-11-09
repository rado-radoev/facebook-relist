import { useState } from "react";
import type { Listing } from "../types";
import { listings } from "../data/listings";
import { FILTERS, matchesFilter, type FilterId } from "../lib/status";
import ConnectionCard from "../components/ConnectionCard";
import ListingRow from "../components/ListingRow";

interface Props {
  onOpen: (listing: Listing) => void;
}

export default function ListingsScreen({ onOpen }: Props) {
  const [filter, setFilter] = useState<FilterId>("active");
  const visible = listings.filter((listing) => matchesFilter(listing.status, filter));

  return (
    <div className="screen">
      <ConnectionCard />

      <div className="chip-row" role="group" aria-label="Filter listings">
        {FILTERS.map((option) => {
          let className = "chip";
          if (option.id === filter) {
            className += " chip-active";
          }
          return (
            <button key={option.id} type="button" className={className} onClick={() => setFilter(option.id)}>
              {option.label}
            </button>
          );
        })}
      </div>

      <div className="listing-list">
        {visible.map((listing) => (
          <ListingRow key={listing.listing_id} listing={listing} onOpen={onOpen} />
        ))}
        {visible.length === 0 ? <p className="empty-note">No listings with this status.</p> : null}
      </div>

      <p className="screen-footnote">
        Preview: these are your real listings, loaded from seed data. The full app reads them live from your Facebook
        session.
      </p>
    </div>
  );
}
