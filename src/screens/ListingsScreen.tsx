import { useCallback, useEffect, useState } from "react";
import type { CurrentUser, Listing } from "../types";
import { fetchListings, syncListings } from "../lib/api";
import { syncedToListing } from "../lib/cloneMapping";
import { FILTERS, matchesFilter, type FilterId } from "../lib/status";
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
  | { kind: "unavailable" };

export default function ListingsScreen({ user, onConnect, onDisconnect, onOpen }: Props) {
  const [filter, setFilter] = useState<FilterId>("active");
  const [source, setSource] = useState<ListSource>({ kind: "loading" });
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const isConnected = user.facebookStatus === "connected";

  const loadSynced = useCallback(async () => {
    try {
      const data = await fetchListings();
      setSource({
        kind: "synced",
        listings: data.listings.map((synced) => syncedToListing(synced, user.id)),
        syncedAt: data.syncedAt,
      });
    } catch {
      // Never substitute another user's or demo data for this account.
      setSource({ kind: "unavailable" });
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

  const shownListings: Listing[] = source.kind === "synced" ? source.listings : [];
  const visible = shownListings.filter((listing) => matchesFilter(listing.status, filter));

  let syncLabel = "Sync my listings";
  if (syncing) {
    syncLabel = "Syncing…";
  } else if (source.kind === "synced") {
    syncLabel = "Re-sync listings";
  }

  let footnote = "";
  if (source.kind === "synced") {
    const when = source.syncedAt ? new Date(source.syncedAt).toLocaleString() : "";
    footnote = `Your real listings, synced from your own Facebook selling list${when ? ` · ${when}` : ""}. Tap one to run its clone check.`;
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
              <span className="sync-note">
                {source.kind === "unavailable" ? "No listing data available" : "Loading your account's listings"}
              </span>
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
            {source.kind === "loading" ? <p className="empty-note">Loading your listings…</p> : null}
            {source.kind === "unavailable" ? (
              <p className="blocked-note">Couldn't load your listings. Retry sync to check the backend connection.</p>
            ) : null}
            {visible.map((listing) => (
              <ListingRow key={listing.listing_id} listing={listing} onOpen={onOpen} />
            ))}
            {source.kind === "synced" && visible.length === 0 ? (
              <p className="empty-note">No listings with this status.</p>
            ) : null}
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
