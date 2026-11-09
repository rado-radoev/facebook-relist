import { useEffect, useRef, useState } from "react";
import type { Listing, StoredClone } from "../types";
import type { FieldPicks, PickableField } from "../lib/fieldOptions";
import {
  fetchArchivedPhotoUrl,
  fetchClone,
  recoverClone,
  saveClonePicks,
} from "../lib/api";
import { applyClone, textToAttributes } from "../lib/cloneMapping";
import { initialPhotoTiles, tilesDiffer, type PhotoTile } from "../lib/photos";
import StatusPill from "../components/StatusPill";
import CloneCheckList, {
  missingFields,
  type EditableField,
  type FieldOverrides,
} from "../components/CloneCheckList";

interface Props {
  listing: Listing;
  facebookConnected: boolean;
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
 * Facebook did not give back, edits replace recovered values, and the
 * photo selection replaces the recovered set. Originals never change.
 */
function effectiveListing(
  listing: Listing,
  picks: FieldPicks,
  overrides: FieldOverrides,
  photoTiles: PhotoTile[],
): Listing {
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
  if (overrides.attributes) {
    effective.attributes = textToAttributes(overrides.attributes);
  }
  effective.photoCount = photoTiles.length;
  const firstPhoto = photoTiles.find((tile) => tile.src);
  if (firstPhoto?.src) {
    effective.photo = firstPhoto.src;
  }
  return effective;
}

/** Photo tiles for a recovered clone, from the backend archive. Tiles
 *  whose download failed stay visible as failed slots — never dropped. */
async function buildServerTiles(clone: StoredClone): Promise<PhotoTile[]> {
  const recovery = clone.recovery;
  if (!recovery) {
    return [];
  }
  const selection = clone.photoSelection ? new Set(clone.photoSelection) : null;
  const tiles: PhotoTile[] = [];
  for (const [index, fileName] of recovery.photos.files.entries()) {
    if (selection && (!fileName || !selection.has(fileName))) {
      continue;
    }
    if (!fileName) {
      tiles.push({
        id: `missing-${index}`,
        src: null,
        label: `Photo ${index + 1} — download failed`,
        origin: "original",
      });
      continue;
    }
    let src: string | null = null;
    try {
      src = await fetchArchivedPhotoUrl(recovery.listingId, index);
    } catch {
      src = null;
    }
    tiles.push({ id: fileName, src, label: `Photo ${index + 1}`, origin: "original" });
  }
  return tiles;
}

export default function DetailScreen({ listing, facebookConnected, onBack, onRecreate }: Props) {
  const synced = listing.source === "synced";
  const title = listing.title.replace(/\s+/g, " ").trim();

  // -- Server clone state (synced listings only) ---------------------------
  const [clone, setClone] = useState<StoredClone | null>(null);
  const [cloneLoaded, setCloneLoaded] = useState(!synced);
  const [recovering, setRecovering] = useState(false);
  const [recoverError, setRecoverError] = useState<string | null>(null);
  const [serverTiles, setServerTiles] = useState<PhotoTile[] | null>(null);
  const serverInitDone = useRef(false);

  // Picks (fields Facebook did not give back) and edits (changes to
  // recovered fields) are both saved per listing: in the backend store
  // for synced listings, in localStorage for the seed stand-ins.
  const [picks, setPicks] = useState<FieldPicks>(() =>
    synced ? {} : loadJson<FieldPicks>(storageKey("picks", listing.listing_id), {}),
  );
  const [overrides, setOverrides] = useState<FieldOverrides>(() =>
    synced ? {} : loadJson<FieldOverrides>(storageKey("edits", listing.listing_id), {}),
  );
  const [photoTiles, setPhotoTiles] = useState<PhotoTile[] | null>(null);

  const displayListing = clone?.recovery ? applyClone(listing, clone) : listing;
  const originalTiles = serverTiles ?? initialPhotoTiles(displayListing);
  const activeTiles = photoTiles ?? originalTiles;
  const photosEdited = photoTiles !== null && tilesDiffer(photoTiles, originalTiles);

  useEffect(() => {
    if (!synced) {
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const stored = await fetchClone(listing.listing_id);
        if (cancelled) {
          return;
        }
        if (stored) {
          setClone(stored);
          setPicks(stored.picks as FieldPicks);
          setOverrides(stored.edits as FieldOverrides);
          if (stored.recovery) {
            const tiles = await buildServerTiles(stored);
            if (!cancelled) {
              setServerTiles(tiles);
            }
          }
        }
      } catch {
        // Backend unreachable — the run-check card below explains.
      } finally {
        if (!cancelled) {
          serverInitDone.current = true;
          setCloneLoaded(true);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [synced, listing.listing_id]);

  // Persist picks/edits for synced listings (seed listings use the
  // localStorage effects below instead).
  useEffect(() => {
    if (!synced || !serverInitDone.current) {
      return;
    }
    const selection = photosEdited
      ? activeTiles.filter((tile) => tile.origin === "original").map((tile) => tile.id)
      : (clone?.photoSelection ?? null);
    void saveClonePicks(listing.listing_id, {
      picks,
      edits: overrides,
      photoSelection: selection,
    }).catch(() => {
      // Saving is best-effort in the UI; values still apply this session.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synced, picks, overrides, photoTiles]);

  useEffect(() => {
    if (!synced) {
      saveJson(storageKey("picks", listing.listing_id), picks);
    }
  }, [synced, picks, listing.listing_id]);

  useEffect(() => {
    if (!synced) {
      saveJson(storageKey("edits", listing.listing_id), overrides);
    }
  }, [synced, overrides, listing.listing_id]);

  async function handleRecover() {
    setRecovering(true);
    setRecoverError(null);
    try {
      const stored = await recoverClone(listing.listing_id);
      setClone(stored);
      if (stored.recovery) {
        const tiles = await buildServerTiles(stored);
        setServerTiles(tiles);
        setPhotoTiles(null);
      }
    } catch (error) {
      setRecoverError(error instanceof Error ? error.message : "Clone check failed");
    } finally {
      setRecovering(false);
    }
  }

  function handlePick(field: PickableField, value: string) {
    setPicks((current) => ({ ...current, [field]: value }));
  }

  function handleOverride(field: EditableField, value: string) {
    setOverrides((current) => ({ ...current, [field]: value }));
  }

  const hasRecovery = !synced || Boolean(clone?.recovery);
  const unanswered = hasRecovery
    ? missingFields(displayListing).filter((field) => !picks[field])
    : [];
  const noPhotos = hasRecovery && activeTiles.length === 0;
  const recreateBlocked = !hasRecovery || unanswered.length > 0 || noPhotos;

  return (
    <div className="screen">
      <button type="button" className="back-button" onClick={onBack}>
        ‹ Listings
      </button>

      <img className="detail-photo" src={displayListing.photo} alt={title} />
      <h1 className="detail-title">{title}</h1>
      <div className="detail-meta">
        <span className="detail-price">{displayListing.price}</span>
        <StatusPill status={displayListing.status} />
        <span className="detail-location">{displayListing.location}</span>
      </div>

      {synced && !hasRecovery ? (
        <section className="card">
          <h2 className="card-title">Clone check</h2>
          <p className="card-sub">
            {cloneLoaded
              ? "Not checked yet — Relist reads this listing's edit form and listing page in your own Facebook session and downloads all its photos. Nothing is changed on Facebook."
              : "Loading the saved clone check…"}
          </p>
          {recoverError ? <p className="blocked-note">Clone check failed: {recoverError}</p> : null}
          <button
            type="button"
            className="primary-button"
            disabled={!facebookConnected || recovering || !cloneLoaded}
            onClick={() => void handleRecover()}
          >
            {recovering ? "Reading your listing…" : "Run clone check"}
          </button>
          {!facebookConnected ? (
            <p className="blocked-note">Connect Facebook to run the clone check.</p>
          ) : null}
        </section>
      ) : (
        <CloneCheckList
          listing={displayListing}
          picks={picks}
          onPick={handlePick}
          overrides={overrides}
          onOverride={handleOverride}
          photoTiles={activeTiles}
          photosEdited={photosEdited}
          onPhotoTilesChange={setPhotoTiles}
        />
      )}

      {unanswered.length > 0 ? (
        <p className="blocked-note">
          Pick the highlighted {unanswered.length === 1 ? "field" : "fields"} in the clone check to
          continue — Relist never guesses a value, and your pick is saved for this listing.
        </p>
      ) : null}
      {noPhotos ? (
        <p className="blocked-note">Add at least one photo to continue — a listing cannot be created without photos.</p>
      ) : null}
      <button
        type="button"
        className="primary-button"
        disabled={recreateBlocked}
        onClick={() => onRecreate(effectiveListing(displayListing, picks, overrides, activeTiles))}
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
