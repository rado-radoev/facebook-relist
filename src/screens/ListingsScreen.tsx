import { useState } from "react";
import type { Account, Listing } from "../types";
import { accounts } from "../data/accounts";
import { listings } from "../data/listings";
import { FILTERS, matchesFilter, type FilterId } from "../lib/status";
import { firstName } from "../lib/accounts";
import AccountSwitcher from "../components/AccountSwitcher";
import ConnectionCard from "../components/ConnectionCard";
import ListingRow from "../components/ListingRow";

interface Props {
  account: Account;
  onSelectAccount: (account: Account) => void;
  onAddPerson: () => void;
  onOpen: (listing: Listing) => void;
}

export default function ListingsScreen({ account, onSelectAccount, onAddPerson, onOpen }: Props) {
  const [filter, setFilter] = useState<FilterId>("active");
  const ownListings = listings.filter((listing) => listing.accountId === account.id);
  const visible = ownListings.filter((listing) => matchesFilter(listing.status, filter));
  const isConnected = account.sessionStatus === "connected";

  return (
    <div className="screen">
      <AccountSwitcher accounts={accounts} activeId={account.id} onSelect={onSelectAccount} onAdd={onAddPerson} />
      <ConnectionCard account={account} onConnect={onAddPerson} />

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
            Preview: these are {firstName(account.displayName)}'s real listings, loaded from seed data. The full app
            reads them live from that person's own Facebook session.
          </p>
        </>
      ) : (
        <section className="card empty-account">
          <h2 className="card-title">No listings for {firstName(account.displayName)} yet</h2>
          <p className="setting-text">
            {firstName(account.displayName)} has not connected Facebook, so this account has no listings. Once they
            connect, only their own listings will show here.
          </p>
          <button type="button" className="primary-button" onClick={onAddPerson}>
            Connect Facebook
          </button>
        </section>
      )}
    </div>
  );
}
