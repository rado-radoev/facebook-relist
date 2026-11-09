import { useState } from "react";
import type { Listing } from "../types";
import { FIELD_OPTIONS, type FieldPicks, type PickableField } from "../lib/fieldOptions";
import { attributesToText } from "../lib/cloneMapping";
import type { PhotoTile } from "../lib/photos";
import PhotoEditor from "./PhotoEditor";

export type CheckState = "ok" | "warn" | "unknown" | "missing" | "not_applicable";

/** Fields the person can edit in the clone preview — all of them. */
export type EditableField =
  | PickableField
  | "title"
  | "price"
  | "description"
  | "location"
  | "photos"
  | "attributes";

export type FieldOverrides = Partial<Record<EditableField, string>>;
export type StructuredDeliveryChoice = "shipping" | "public" | "doorPickup" | "doorDropoff";

export interface CheckRow {
  label: string;
  value: string;
  state: CheckState;
  /** Set when the field was not recovered and the person must pick. */
  field?: PickableField;
  /** Set when the field has a value the person may edit. */
  editField?: EditableField;
  /** How the editor for a set field works. */
  editor?: "options" | "text" | "textarea" | "photos";
  deliveryChoice?: StructuredDeliveryChoice;
}

function missingReason(listing: Listing, field: keyof NonNullable<Listing["recoveryReasons"]>): string {
  return listing.recoveryReasons?.[field] ?? "The backend did not return this field; review and supply a value.";
}

function fieldState(listing: Listing, field: keyof NonNullable<Listing["fieldStates"]>, value: string): CheckState {
  const state = listing.fieldStates?.[field];
  if (state === "not_applicable") return "not_applicable";
  if (state === "unknown") return "unknown";
  if (state === "missing" || !value.trim()) return "missing";
  return "ok";
}

function categoryRow(listing: Listing): CheckRow {
  const state = fieldState(listing, "category", listing.category ?? "");
  if (state === "ok") {
    return {
      label: "Category",
      value: `${listing.category} (stored value)`,
      state: "ok",
      editField: "category",
      editor: "options",
    };
  }
  return {
    label: "Category",
    value: state === "not_applicable"
      ? "Category is not applicable for this listing."
      : listing.recoveryReasons?.category ?? "Category was not recovered — choose the value:",
    state,
    field: state === "not_applicable" ? undefined : "category",
  };
}

function conditionRow(listing: Listing): CheckRow {
  const state = listing.conditionFlag ? "missing" : fieldState(listing, "condition", listing.condition);
  if (state !== "ok") {
    return {
      label: "Condition",
      value: listing.conditionFlag ?? listing.recoveryReasons?.condition ?? "Condition was not recovered — choose the value:",
      state,
      field: state === "not_applicable" ? undefined : "condition",
    };
  }
  return { label: "Condition", value: listing.condition, state: "ok", editField: "condition", editor: "options" };
}

function videoSuffix(listing: Listing): string {
  if (listing.videoCount === 0) {
    return "";
  }
  if (listing.videoState === "recovered") {
    return ` · ${listing.videoCount} video downloaded to the archive`;
  }
  if (listing.videoState === "present_not_downloaded") {
    return ` · ${listing.videoCount} video present — could not be downloaded`;
  }
  return ` · ${listing.videoCount} video to carry over (untested)`;
}

function photosRow(listing: Listing): CheckRow {
  if (listing.photoCount !== null) {
    const downloaded = listing.photosDownloaded ?? (listing.source === "synced" ? 0 : listing.photoCount);
    const completeEvidence = listing.source !== "synced"
      ? true
      : listing.photoCompleteness === "complete" && listing.photoExpectedCount === listing.photoCount;
    const allDownloaded = completeEvidence && downloaded === listing.photoCount && listing.fieldStates?.photos !== "missing";
    let value = `${downloaded} of ${listing.photoCount} downloaded`;
    if (!allDownloaded) {
      const slotReasons = listing.photoReasons?.flatMap((reason, index) => reason ? [`Photo ${index + 1}: ${reason}`] : []) ?? [];
      value += ` — ${slotReasons.join(" ") || missingReason(listing, "photos")}`;
    }
    value += videoSuffix(listing);
    return {
      label: "Photos",
      value,
      state: allDownloaded
        ? "ok"
        : downloaded < listing.photoCount
          ? "missing"
          : listing.photoCompleteness === "unknown" || listing.photoCompleteness === undefined
            ? "unknown"
            : "missing",
      editField: "photos",
      editor: "photos",
    };
  }
  return {
    label: "Photos",
    value: missingReason(listing, "photos"),
    state: "unknown",
    editField: "photos",
    editor: "photos",
  };
}

function deliveryRows(listing: Listing): CheckRow[] {
  const details = listing.deliveryInfo;
  const typeKnown = Boolean(details?.type);
  const shippingKnown = details?.shipping !== null && details?.shipping !== undefined;
  const rows: CheckRow[] = [
    {
      label: "Delivery type",
      value: typeKnown ? details?.type as string : listing.recoveryReasons?.delivery ?? "Delivery type was not recovered; choose an available delivery option:",
      state: typeKnown ? "ok" : listing.fieldStates?.delivery === "unknown" ? "unknown" : "missing",
      field: typeKnown ? undefined : "delivery",
      editField: typeKnown ? "delivery" : undefined,
      editor: typeKnown ? "text" : undefined,
    },
    {
      label: "Shipping",
      value: shippingKnown ? (details?.shipping ? "Offered" : "Not offered") : listing.recoveryReasons?.delivery ?? "Shipping status was not returned by the backend.",
      state: shippingKnown ? "ok" : "unknown",
      deliveryChoice: "shipping",
    },
  ];
  const meetupOptions = [
    ["Public meetup", details?.meetup?.public],
    ["Door pickup", details?.meetup?.doorPickup],
    ["Door dropoff", details?.meetup?.doorDropoff],
  ] as const;
  for (const [label, value] of meetupOptions) {
    rows.push({
      label,
      value: value === null || value === undefined
        ? `Unknown — ${listing.recoveryReasons?.delivery ?? "this meetup option was not observed by the backend."}`
        : value ? "Selected" : "Not selected",
      state: value === null || value === undefined ? "unknown" : "ok",
      deliveryChoice: label === "Public meetup" ? "public" : label === "Door pickup" ? "doorPickup" : "doorDropoff",
    });
  }
  if (!shippingKnown || meetupOptions.some(([, value]) => value === null || value === undefined)) {
    rows.push({
      label: "Delivery editing",
      value: "Some shipping or meetup options are still unknown. Pick Yes or No for each one above; recreating is blocked until each one is set.",
      state: "missing",
    });
  }
  return rows;
}

function attributesRow(listing: Listing): CheckRow | null {
  const state = listing.fieldStates?.attributes;
  if (state === "not_applicable") {
    return {
      label: "Attributes",
      value: "No category-specific attributes apply to this listing.",
      state: "not_applicable",
      editField: "attributes",
      editor: "textarea",
    };
  }
  if (state === "recovered" && listing.attributes && Object.keys(listing.attributes).length === 0) {
    return {
      label: "Attributes",
      value: "No attributes were present in the completed recovery.",
      state: "ok",
      editField: "attributes",
      editor: "textarea",
    };
  }
  if (listing.attributes && Object.keys(listing.attributes).length > 0) {
    return {
      label: "Attributes",
      value: attributesToText(listing.attributes),
      state: state === "missing" ? "missing" : state === "unknown" ? "unknown" : "ok",
      editField: "attributes",
      editor: "textarea",
    };
  }
  if (state === "unknown" || state === "missing" || listing.recoveryReasons?.attributes) {
    return {
      label: "Attributes",
      value: listing.recoveryReasons?.attributes ?? "Category attributes were not recovered; review and enter them.",
      state: state === "unknown" ? "unknown" : "missing",
      editField: "attributes",
      editor: "textarea",
    };
  }
  return null;
}

export function buildCloneCheck(listing: Listing): CheckRow[] {
  const titleState = fieldState(listing, "title", listing.title);
  const priceState = fieldState(listing, "price", listing.price);
  const descriptionState = fieldState(listing, "description", listing.description);
  const locationState = fieldState(listing, "location", listing.locationLabel);
  const rows: CheckRow[] = [
    {
      label: "Title",
      value: titleState === "ok" ? listing.title.replace(/\s+/g, " ").trim() : listing.recoveryReasons?.title ?? "Title was not recovered; provide a title.",
      state: titleState,
      editField: "title",
      editor: "text",
    },
    {
      label: "Price",
      value: priceState === "ok" ? listing.price : listing.recoveryReasons?.price ?? "Price was not recovered; provide a price.",
      state: priceState,
      editField: "price",
      editor: "text",
    },
    {
      label: "Description",
      value: descriptionState === "ok" ? listing.description.trim() : listing.recoveryReasons?.description ?? "Description was not recovered; review and supply text.",
      state: descriptionState,
      editField: "description",
      editor: "textarea",
    },
    categoryRow(listing),
    conditionRow(listing),
    photosRow(listing),
    {
      label: "Location",
      value: locationState === "ok" ? listing.locationLabel : listing.recoveryReasons?.location ?? "Location was not recovered; enter a location.",
      state: locationState,
      editField: "location",
      editor: "text",
    },
    ...deliveryRows(listing),
  ];
  const attributes = attributesRow(listing);
  if (attributes) {
    rows.push(attributes);
  } else if (listing.fieldStates?.attributes === "missing") {
    rows.push({
      label: "Attributes",
      value: missingReason(listing, "attributes"),
      state: "missing",
      editField: "attributes",
      editor: "textarea",
    });
  }
  if (listing.videoPresence === "unknown" || listing.videoState === "unknown" || listing.fieldStates?.video === "unknown") {
    rows.push({
      label: "Video",
      value: listing.videoReason ?? missingReason(listing, "video"),
      state: "unknown",
    });
  } else if (listing.videoPresence === "present" || listing.videoCount > 0) {
    const videoRecovered = listing.fieldStates?.video !== "missing" && listing.videoState === "recovered";
    rows.push({
      label: "Video",
      value: videoRecovered
        ? `${listing.videoCount || 1} video downloaded to the archive`
        : listing.videoReason ?? missingReason(listing, "video"),
      state: videoRecovered ? "ok" : "missing",
    });
  }
  return rows;
}

export function unresolvedApprovalRows(
  listing: Listing,
  picks: FieldPicks,
  overrides: FieldOverrides = {},
): CheckRow[] {
  return buildCloneCheck(listing).filter((row) => {
    if (row.state === "ok" || row.state === "not_applicable" || (row.field && picks[row.field])) {
      return false;
    }
    if (row.editField && overrides[row.editField]?.trim()) {
      return false;
    }
    return true;
  });
}

/** Fields the person still has to supply before this listing can recreate. */
export function missingFields(listing: Listing): PickableField[] {
  const fields: PickableField[] = [];
  for (const row of buildCloneCheck(listing)) {
    if (row.state === "missing" && row.field) {
      fields.push(row.field);
    }
  }
  return fields;
}

const STATE_ICON: Record<CheckState, string> = {
  ok: "✅",
  warn: "⚠️",
  unknown: "•",
  missing: "⚠️",
  not_applicable: "—",
};

interface Props {
  listing: Listing;
  picks: FieldPicks;
  onPick: (field: PickableField, value: string) => void;
  overrides: FieldOverrides;
  onOverride: (field: EditableField, value: string) => void;
  onDeliveryChoice: (field: StructuredDeliveryChoice, value: boolean) => void;
  photoTiles: PhotoTile[];
  photosEdited: boolean;
  onPhotoTilesChange: (tiles: PhotoTile[]) => void;
  canEditPhotos: boolean;
  canAddReplacePhotos: boolean;
  saveState: "loading" | "idle" | "pending" | "saved" | "error";
}

export default function CloneCheckList({
  listing,
  picks,
  onPick,
  overrides,
  onOverride,
  onDeliveryChoice,
  photoTiles,
  photosEdited,
  onPhotoTilesChange,
  canEditPhotos,
  canAddReplacePhotos,
  saveState,
}: Props) {
  const rows = buildCloneCheck(listing);
  const [editing, setEditing] = useState<EditableField | null>(null);
  const [draft, setDraft] = useState("");
  const [editingDelivery, setEditingDelivery] = useState<StructuredDeliveryChoice | null>(null);

  function startEdit(row: CheckRow) {
    if (!row.editField) {
      return;
    }
    setDraft(overrides[row.editField] ?? row.value.replace(" (stored value)", ""));
    setEditing(row.editField);
  }

  function saveTextEdit() {
    if (editing && draft.trim().length > 0) {
      onOverride(editing, draft.trim());
    }
    setEditing(null);
  }

  function renderMissingRow(row: CheckRow) {
    const field = row.field as PickableField;
    return (
      <li key={row.label} className={`check-row check-${row.state}`}>
        <span className="check-icon" aria-hidden="true">
          {STATE_ICON[row.state]}
        </span>
        <span className="check-body">
          <span className="check-label">{row.label}</span>
          <span className="check-value">{row.value}</span>
          <span className="check-picker" role="group" aria-label={`Pick the ${row.label.toLowerCase()}`}>
            {FIELD_OPTIONS[field].map((option) => (
              <button key={option} type="button" className="check-chip" onClick={() => onPick(field, option)}>
                {option}
              </button>
            ))}
          </span>
        </span>
      </li>
    );
  }

  function renderPickedRow(row: CheckRow, pick: string) {
    const field = row.field as PickableField;
    const isEditing = editing === field;
    return (
      <li key={row.label} className={`check-row ${saveState === "saved" ? "check-ok" : "check-warn"}`}>
        <span className="check-icon" aria-hidden="true">{STATE_ICON[saveState === "saved" ? "ok" : "warn"]}</span>
        <span className="check-body">
          <span className="check-label">{row.label}</span>
          <span className="check-value">{pick}{saveState === "saved" ? " (saved for this listing)" : " (your pick)"}</span>
          {isEditing ? (
            <span className="check-picker" role="group" aria-label={`Change the ${row.label.toLowerCase()}`}>
              {FIELD_OPTIONS[field].map((option) => (
                <button key={option} type="button" className="check-chip" onClick={() => {
                  onPick(field, option);
                  setEditing(null);
                }}>{option}</button>
              ))}
              <button type="button" className="check-chip check-chip-cancel" onClick={() => setEditing(null)}>Cancel</button>
            </span>
          ) : (
            <button type="button" className="edit-button" onClick={() => setEditing(field)}>Edit pick</button>
          )}
        </span>
      </li>
    );
  }

  function renderPhotosRow(row: CheckRow) {
    const isEditing = editing === "photos";
    const unreadableTiles = photoTiles.filter((tile) => tile.origin === "original" && !tile.src);
    const state = unreadableTiles.length > 0 ? "missing" : row.state;
    let value = row.value;
    if (unreadableTiles.length > 0) {
      value += ` — ${unreadableTiles.map((tile) => tile.label).join("; ")}`;
    }
    if (photosEdited) {
      value = `${photoTiles.length} photo${photoTiles.length === 1 ? "" : "s"} selected for the clone`;
      value += videoSuffix(listing);
    }
    return (
      <li key={row.label} className={`check-row check-${state}`}>
        <span className="check-icon" aria-hidden="true">
          {STATE_ICON[state]}
        </span>
        <span className="check-body">
          <span className="check-label">
            {row.label}
            {photosEdited ? <span className="edited-tag">Edited</span> : null}
          </span>
          <span className="check-value">{value}</span>
          {canEditPhotos && isEditing ? (
            <PhotoEditor tiles={photoTiles} onChange={onPhotoTilesChange} canAddReplace={canAddReplacePhotos} />
          ) : null}
          {!canAddReplacePhotos ? (
            <span className="check-value">Adding or replacing photos is unavailable because this backend only stores recovered archive files. Recovered photos can be reordered or removed.</span>
          ) : null}
          {!isEditing && canEditPhotos ? (
            <button type="button" className="edit-button" onClick={() => setEditing("photos")}>
              Edit
            </button>
          ) : null}
          {isEditing && canEditPhotos ? (
            <button type="button" className="edit-button" onClick={() => setEditing(null)}>
              Done
            </button>
          ) : null}
        </span>
      </li>
    );
  }

  function renderDeliveryRow(row: CheckRow) {
    const field = row.deliveryChoice as StructuredDeliveryChoice;
    const isEditing = editingDelivery === field;
    return (
      <li key={row.label} className={`check-row check-${row.state}`}>
        <span className="check-icon" aria-hidden="true">{STATE_ICON[row.state]}</span>
        <span className="check-body">
          <span className="check-label">{row.label}</span>
          <span className="check-value">{row.value}</span>
          {isEditing ? (
            <span className="check-picker" role="group" aria-label={`Edit ${row.label}`}>
              <button type="button" className="check-chip" onClick={() => { onDeliveryChoice(field, true); setEditingDelivery(null); }}>Yes</button>
              <button type="button" className="check-chip" onClick={() => { onDeliveryChoice(field, false); setEditingDelivery(null); }}>No</button>
              <button type="button" className="check-chip check-chip-cancel" onClick={() => setEditingDelivery(null)}>Cancel</button>
            </span>
          ) : (
            <button type="button" className="edit-button" onClick={() => setEditingDelivery(field)}>Edit</button>
          )}
        </span>
      </li>
    );
  }

  function renderSetRow(row: CheckRow) {
    const editField = row.editField as EditableField;
    const override = overrides[editField];
    const isEdited = override !== undefined && override !== row.value.replace(" (stored value)", "");
    const isEditing = editing === editField;

    let editorBlock = null;
    if (isEditing && row.editor === "options") {
      editorBlock = (
        <span className="check-picker" role="group" aria-label={`Change the ${row.label.toLowerCase()}`}>
          {FIELD_OPTIONS[editField as PickableField].map((option) => {
            let className = "check-chip";
            if (option === (override ?? row.value.replace(" (stored value)", ""))) {
              className += " check-chip-current";
            }
            return (
              <button
                key={option}
                type="button"
                className={className}
                onClick={() => {
                  onOverride(editField, option);
                  setEditing(null);
                }}
              >
                {option}
              </button>
            );
          })}
          <button type="button" className="check-chip check-chip-cancel" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </span>
      );
    }
    if (isEditing && row.editor !== "options") {
      const input =
        row.editor === "textarea" ? (
          <textarea
            className="check-edit-input"
            value={draft}
            rows={4}
            onChange={(event) => setDraft(event.target.value)}
          />
        ) : (
          <input
            className="check-edit-input"
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        );
      editorBlock = (
        <span className="check-editor">
          {input}
          <span className="check-editor-actions">
            <button type="button" className="check-chip check-chip-save" onClick={saveTextEdit}>
              Save
            </button>
            <button type="button" className="check-chip check-chip-cancel" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </span>
        </span>
      );
    }

    return (
      <li key={row.label} className={`check-row check-${row.state}`}>
        <span className="check-icon" aria-hidden="true">
          {STATE_ICON[row.state]}
        </span>
        <span className="check-body">
          <span className="check-label">
            {row.label}
            {isEdited ? <span className="edited-tag">Edited</span> : null}
          </span>
          <span className="check-value">{isEdited ? override : row.value}</span>
          {editorBlock}
          {!isEditing ? (
            <button type="button" className="edit-button" onClick={() => startEdit(row)}>
              Edit
            </button>
          ) : null}
        </span>
      </li>
    );
  }

  return (
    <section className="card">
      <h2 className="card-title">Clone check</h2>
      <p className="card-sub">
        Everything the app recovered from your listing, before anything is created. Anything already set
        can be changed with Edit; anything missing needs your pick.
      </p>
      <ul className="check-list">
        {rows.map((row) => {
          const pick = row.field ? picks[row.field] : undefined;
          if ((row.state === "missing" || row.state === "unknown") && row.field && !pick) {
            return renderMissingRow(row);
          }
          if ((row.state === "missing" || row.state === "unknown") && row.field && pick) {
            return renderPickedRow(row, pick);
          }
          if (row.deliveryChoice) {
            return renderDeliveryRow(row);
          }
          if (row.editField === "photos") {
            return renderPhotosRow(row);
          }
          if (row.editField) {
            return renderSetRow(row);
          }
          return (
            <li key={row.label} className={`check-row check-${row.state}`}>
              <span className="check-icon" aria-hidden="true">
                {STATE_ICON[row.state]}
              </span>
              <span className="check-body">
                <span className="check-label">{row.label}</span>
                <span className="check-value">{row.value}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
