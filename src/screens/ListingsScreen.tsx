import { useCallback, useEffect, useState } from "react";
import type { CurrentUser, Listing } from "../types";
import { listings as seedListings } from "../data/listings";
import { fetchListings, syncListings } from "../lib/api";
import { syncedToListing } from "../lib/cloneMapping";
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

type ListSource =
  | { kind: "loading" }
  | { kind: "synced"; listings: Listing[]; syncedAt: string | null }
  | { kind: "seed" };

export default function ListingsScreen({ user, onConnect, onDisconnect, onOpen }: Props) {
  const [filter, setFilter] = useState<FilterId>("active");
  const [source, setSource] = useState<ListSource>({ kind: "loading" });
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const isConnected = user.facebookStatus === "connected";

  const loadSynced = useCallback(async () => {
    try {
      const data = await fetchListings();
      if (data.listings.length > 0) {
        setSource({
          kind: "synced",
          listings: data.listings.map((synced) => syncedToListing(synced, user.id)),
          syncedAt: data.syncedAt,
        });
      } else {
        setSource({ kind: "seed" });
      }
    } catch {
      // Backend unreachable — fall back to the labelled seed set.
      setSource({ kind: "seed" });
    }
  }, [user.id]);

  useEffect(() => {
    if (isConnected) {
      void loadSynced();
    }
  }, [isConnected, loadSynced]);

  async function handleSync() {
    setSyncing(true);
    setSyncError(null);
    try {
      const data = await syncListings();
      setSource({
        kind: "synced",
        listings: data.listings.map((synced) => syncedToListing(synced, user.id)),
        syncedAt: data.syncedAt,
      });
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  const shownListings: Listing[] =
    source.kind === "synced" ? source.listings : seedListings;
  const visible = shownListings.filter((listing) => matchesFilter(listing.status, filter));

  let syncLabel = "Sync my listings";
  if (syncing) {
    syncLabel = "Syncing…";
  } else if (source.kind === "synced") {
    syncLabel = "Re-sync listings";
  }

  let footnote: string;
  if (source.kind === "synced") {
    const when = source.syncedAt ? new Date(source.syncedAt).toLocaleString() : "";
    footnote = `Your real listings, synced from your own Facebook selling list${when ? ` · ${when}` : ""}. Tap one to run its clone check.`;
  } else {
    footnote = `These are sample listings standing in for ${firstName(user.displayName)}'s real ones — sync to replace them with the listings from your own Facebook session.`;
  }

  return (
    <div className="screen">
      <ConnectionCard user={user} onConnect={onConnect} onDisconnect={onDisconnect} />

      {isConnected ? (
        <>
          <div className="sync-bar">
            <button
              type="button"
              className="secondary-button"
              onClick={() => void handleSync()}
              disabled={syncing}
            >
              {syncLabel}
            </button>
            {source.kind === "synced" ? (
              <span className="sync-note">From your Facebook selling list</span>
            ) : (
              <span className="sync-note">Showing sample listings until you sync</span>
            )}
          </div>
          {syncError ? <p className="blocked-note">Sync failed: {syncError}</p> : null}

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

          <p className="screen-footnote">{footnote}</p>
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
