import { useEffect, useRef, useState } from "react";
import type { DeliveryEdits, Listing, MeetupPrefs, StoredClone } from "../types";
import type { FieldPicks, PickableField } from "../lib/fieldOptions";
import {
  ApiError,
  createJob,
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
  unresolvedApprovalRows,
  type EditableField,
  type FieldOverrides,
  type StructuredDeliveryChoice,
} from "../components/CloneCheckList";

interface Props {
  listing: Listing;
  facebookConnected: boolean;
  onBack: () => void;
  /** Sprint 3: synced listings start a real backend job — jobId is set.
   *  Seed listings keep the timer preview (no jobId). */
  onRecreate: (listing: Listing, jobId?: string) => void;
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
  deliveryEdits: DeliveryEdits = {},
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
  if (deliveryEdits.shipping !== undefined || deliveryEdits.meetup) {
    const delivery = effective.deliveryInfo;
    effective.deliveryInfo = {
      type: delivery?.type ?? null,
      shipping: deliveryEdits.shipping !== undefined ? deliveryEdits.shipping : delivery?.shipping ?? null,
      meetup: {
        public: deliveryEdits.meetup?.public !== undefined ? deliveryEdits.meetup.public : delivery?.meetup?.public ?? null,
        doorPickup: deliveryEdits.meetup?.doorPickup !== undefined ? deliveryEdits.meetup.doorPickup : delivery?.meetup?.doorPickup ?? null,
        doorDropoff: deliveryEdits.meetup?.doorDropoff !== undefined ? deliveryEdits.meetup.doorDropoff : delivery?.meetup?.doorDropoff ?? null,
      },
    };
  }
  effective.photoCount = photoTiles.length;
  const firstPhoto = photoTiles.find((tile) => tile.src);
  if (firstPhoto?.src) {
    effective.photo = firstPhoto.src;
  }
  return effective;
}

/** Photo tiles for a recovered clone, from the backend archive. */
async function buildServerTiles(clone: StoredClone): Promise<PhotoTile[]> {
  const recovery = clone.recovery;
  if (!recovery) {
    return [];
  }
  const selection = clone.photoSelection;
  const orderedFiles = selection
    ? selection.map((fileName) => ({ fileName, index: recovery.photos.files.indexOf(fileName) }))
        .filter(({ index }) => index >= 0)
    : recovery.photos.files.map((fileName, index) => ({ fileName, index }));
  const tiles: PhotoTile[] = [];
  for (const { fileName, index } of orderedFiles) {
    if (!fileName) {
      const reason = recovery.photos.reasons?.[index] ?? "The backend did not include a per-photo download reason.";
      tiles.push({
        id: `missing-${index}`,
        src: null,
        label: `Photo ${index + 1} — ${reason}`,
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
    const reason = recovery.photos.reasons?.[index] ?? "The backend did not include an archive read reason.";
    tiles.push({
      id: fileName,
      src,
      label: src
        ? `Photo ${index + 1}`
        : `Photo ${index + 1} — ${reason}`,
      origin: "original",
    });
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
  const [startingJob, setStartingJob] = useState(false);
  const [jobError, setJobError] = useState<string | null>(null);
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
  const [deliveryEdits, setDeliveryEdits] = useState<DeliveryEdits>({});
  const [photoTiles, setPhotoTiles] = useState<PhotoTile[] | null>(null);
  const [persistReady, setPersistReady] = useState(!synced);
  const [savingState, setSavingState] = useState<"loading" | "idle" | "pending" | "saved" | "error">("loading");
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const saveVersion = useRef(0);
  const stateRef = useRef<{
    picks: FieldPicks;
    overrides: FieldOverrides;
    deliveryEdits: DeliveryEdits;
    photoTiles: PhotoTile[] | null;
    clone: StoredClone | null;
  }>({ picks, overrides, deliveryEdits, photoTiles, clone });
  stateRef.current = { picks, overrides, deliveryEdits, photoTiles, clone };

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
          setDeliveryEdits(stored.deliveryEdits ?? {});
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
          setPersistReady(true);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [synced, listing.listing_id]);

  function queueSave() {
    if (!synced || !persistReady) return;
    const snapshot = stateRef.current;
    const version = ++saveVersion.current;
    const selection = snapshot.photoTiles
      ? snapshot.photoTiles.filter((tile) => tile.origin === "original").map((tile) => tile.id)
      : (snapshot.clone?.photoSelection ?? null);
    setSavingState("pending");
    setSaveError(null);
    const write = saveQueue.current
      .catch(() => undefined)
      .then(() => saveClonePicks(listing.listing_id, {
        picks: snapshot.picks,
        edits: snapshot.overrides,
        deliveryEdits: snapshot.deliveryEdits,
        photoSelection: selection,
        revision: stateRef.current.clone?.revision ?? 0,
      }))
      .then((saved) => {
        stateRef.current = { ...stateRef.current, clone: saved };
        if (version === saveVersion.current) {
          setClone(saved);
          setSavingState("saved");
        }
      })
      .catch((error: unknown) => {
        if (version === saveVersion.current) {
          setSaveError(error instanceof Error ? error.message : "Could not save your clone check.");
          setSavingState("error");
        }
      });
    saveQueue.current = write;
  }

  // Persist only after initial values and archived media have loaded. The
  // serialized queue prevents slower writes from replacing newer picks.
  useEffect(() => {
    if (synced && persistReady) queueSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synced, persistReady, picks, overrides, deliveryEdits, photoTiles]);

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
    setPersistReady(false);
    setRecoverError(null);
    try {
      const stored = await recoverClone(listing.listing_id);
      setClone(stored);
      setDeliveryEdits(stored.deliveryEdits ?? {});
      if (stored.recovery) {
        const tiles = await buildServerTiles(stored);
        setServerTiles(tiles);
        setPhotoTiles(null);
      }
    } catch (error) {
      setRecoverError(error instanceof Error ? error.message : "Clone check failed");
    } finally {
      serverInitDone.current = true;
      setCloneLoaded(true);
      setPersistReady(true);
      setRecovering(false);
    }
  }

  /**
   * Start the recreate. For a synced listing this creates the real
   * backend job from the saved clone check (the server re-checks
   * completeness and the one-job-per-account lock); the progress screen
   * then follows that job. If a job is already running for the account,
   * open it instead of failing. Seed listings keep the timer preview.
   */
  async function handleRecreate() {
    const effective = effectiveListing(displayListing, picks, overrides, activeTiles, deliveryEdits);
    if (!synced) {
      onRecreate(effective);
      return;
    }
    setStartingJob(true);
    setJobError(null);
    try {
      const job = await createJob(listing.listing_id, stateRef.current.clone?.revision ?? 0);
      onRecreate(effective, job.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const activeJobId = error.details.jobId;
        if (typeof activeJobId === "string") {
          onRecreate(effective, activeJobId);
          return;
        }
      }
      setJobError(error instanceof Error ? error.message : "Could not start the recreate");
    } finally {
      setStartingJob(false);
    }
  }

  function handlePick(field: PickableField, value: string) {
    const next = { ...stateRef.current.picks, [field]: value };
    stateRef.current = { ...stateRef.current, picks: next };
    setPicks(next);
  }

  function handleOverride(field: EditableField, value: string) {
    const next = { ...stateRef.current.overrides, [field]: value };
    stateRef.current = { ...stateRef.current, overrides: next };
    setOverrides(next);
  }

  function handleDeliveryChoice(field: StructuredDeliveryChoice, value: boolean | null) {
    const current = stateRef.current.deliveryEdits;
    const next: DeliveryEdits = field === "shipping"
      ? { ...current, shipping: value }
      : { ...current, meetup: { ...current.meetup, [field]: value } as Partial<MeetupPrefs> };
    stateRef.current = { ...stateRef.current, deliveryEdits: next };
    setDeliveryEdits(next);
  }

  const hasRecovery = !synced || Boolean(clone?.recovery);
  const unanswered = hasRecovery
    ? missingFields(displayListing).filter((field) => !picks[field])
    : [];
  const noPhotos = hasRecovery && activeTiles.length === 0;
  const approvalListing = effectiveListing(displayListing, picks, overrides, activeTiles, deliveryEdits);
  const unresolvedApproval = synced
    ? unresolvedApprovalRows(approvalListing, picks, overrides)
    : [];
  const videoUnavailable = Boolean(displayListing.videoCount > 0 && displayListing.videoState !== "recovered");
  const unreadablePhotos = activeTiles.some((tile) => tile.src === null);
  const saveReady = !synced || savingState === "saved";
  const recreateBlocked = !hasRecovery || !cloneLoaded || unanswered.length > 0 || noPhotos || unreadablePhotos || unresolvedApproval.length > 0 || videoUnavailable || !saveReady;

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
          listing={approvalListing}
          picks={picks}
          onPick={handlePick}
          overrides={overrides}
          onOverride={handleOverride}
          onDeliveryChoice={handleDeliveryChoice}
          photoTiles={activeTiles}
          photosEdited={photosEdited}
          onPhotoTilesChange={setPhotoTiles}
          canEditPhotos={synced && Boolean(clone?.recovery)}
          canAddReplacePhotos={false}
          saveState={savingState}
        />
      )}

      {unanswered.length > 0 ? (
        <p className="blocked-note">
          Pick the highlighted {unanswered.length === 1 ? "field" : "fields"} in the clone check to
          continue — Relist never guesses a value, and your pick is saved for this listing.
        </p>
      ) : null}
      {noPhotos ? (
        <p className="blocked-note">
          {synced
            ? "The server archive has no selected readable photos. Run the clone check again; photo upload is not supported by this backend."
            : "Add at least one photo to continue — a listing cannot be created without photos."}
        </p>
      ) : null}
      {unreadablePhotos ? (
        <p className="blocked-note">At least one archived photo is missing or unreadable. Retry the clone check before recreating; unreadable media cannot be approved.</p>
      ) : null}

      {synced && savingState === "pending" ? (
        <p role="status" className="blocked-note">Saving your picks and edits… Recreate is unavailable until the server confirms.</p>
      ) : null}
      {synced && savingState === "saved" ? (
        <p role="status" className="screen-footnote">Your picks and edits were confirmed saved for this listing.</p>
      ) : null}
      {synced && savingState === "error" ? (
        <p role="alert" className="alert-note">Could not save your clone check: {saveError}</p>
      ) : null}
      {synced && savingState === "error" ? (
        <button type="button" className="edit-button" onClick={queueSave}>Retry save</button>
      ) : null}
      {jobError ? <p className="alert-note">⚠️ {jobError}</p> : null}
      <button
        type="button"
        className="primary-button"
        disabled={recreateBlocked || startingJob}
        onClick={() => void handleRecreate()}
      >
        {startingJob ? "Starting recreate…" : "Recreate listing"}
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
