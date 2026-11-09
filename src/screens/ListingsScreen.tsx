import { useState } from "react";
import type { CurrentUser, Listing } from "../types";
import { listings } from "../data/listings";
import { FILTERS, matchesFilter, type FilterId } from "../lib/status";
import { firstName } from "../lib/user";
import ConnectionCard from "../components/ConnectionCard";
import ListingRow from "../components/ListingRow";

interface Props {
  user: CurrentUser;
  onConnect: () => void;
  onDisconnect: () => void;
  onOpen: (listing: Listing) => void;
}

export default function ListingsScreen({ user, onConnect, onDisconnect, onOpen }: Props) {
  const [filter, setFilter] = useState<FilterId>("active");
  // Sprint 1 stand-in: the seed listings stand in for the signed-in
  // person's own listings. From Sprint 2 the backend serves only the
  // session's own listings, so nothing client-side filters by account.
  const visible = listings.filter((listing) => matchesFilter(listing.status, filter));
  const isConnected = user.facebookStatus === "connected";

  return (
    <div className="screen">
      <ConnectionCard user={user} onConnect={onConnect} onDisconnect={onDisconnect} />

      {isConnected ? (
        <>
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
            These are {firstName(user.displayName)}'s real listings, still loaded from seed data — live
            listings sync from your own Facebook session arrives in Sprint 2.
          </p>
        </>
      ) : (
        <section className="card empty-account">
          <h2 className="card-title">No listings yet</h2>
          <p className="setting-text">
            Connect your Facebook account and your listings will show here — only yours.
          </p>
          <button type="button" className="primary-button" onClick={onConnect}>
            Connect Facebook
          </button>
        </section>
      )}
    </div>
  );
}
