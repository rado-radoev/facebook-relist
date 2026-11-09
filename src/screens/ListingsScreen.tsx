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
  onOpen: (listing: Listing) => void;
}

export default function ListingsScreen({ user, onConnect, onOpen }: Props) {
  const [filter, setFilter] = useState<FilterId>("active");
  // Only the signed-in person's listings exist in this app — the backend
  // derives the account from the signed-in session, never from the client.
  const ownListings = listings.filter((listing) => listing.accountId === user.id);
  const visible = ownListings.filter((listing) => matchesFilter(listing.status, filter));
  const isConnected = user.facebookStatus === "connected";

  return (
    <div className="screen">
      <ConnectionCard user={user} onConnect={onConnect} />

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
            Preview: these are {firstName(user.displayName)}'s real listings, loaded from seed data. The full app
            reads them live from your own Facebook session.
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
