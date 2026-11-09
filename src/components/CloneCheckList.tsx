import { useState } from "react";
import type { Listing } from "../types";
import { FIELD_OPTIONS, type FieldPicks, type PickableField } from "../lib/fieldOptions";

export type CheckState = "ok" | "warn" | "unknown" | "missing";

/** Fields the person can edit in the clone preview. */
export type EditableField = PickableField | "title" | "price" | "description" | "location";

export type FieldOverrides = Partial<Record<EditableField, string>>;

export interface CheckRow {
  label: string;
  value: string;
  state: CheckState;
  /** Set when the field was not recovered and the person must pick. */
  field?: PickableField;
  /** Set when the field has a value the person may edit. */
  editField?: EditableField;
  /** How the editor for a set field works. */
  editor?: "options" | "text" | "textarea";
}

function categoryRow(listing: Listing): CheckRow {
  if (listing.category) {
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
    value: "Not recovered — pick the category:",
    state: "missing",
    field: "category",
  };
}

function conditionRow(listing: Listing): CheckRow {
  if (listing.conditionFlag) {
    // Facebook shows this listing's condition nowhere (its edit form is
    // empty and the listing page itself carries Facebook's "add info
    // about condition" prompt), so it cannot be recovered. Never just a
    // warning: the person picks from Facebook's real condition values.
    return {
      label: "Condition",
      value: "Facebook doesn't have it for this listing — pick the condition:",
      state: "missing",
      field: "condition",
    };
  }
  return { label: "Condition", value: listing.condition, state: "ok", editField: "condition", editor: "options" };
}

function photosRow(listing: Listing): CheckRow {
  if (listing.photoCount !== null) {
    let value = `${listing.photoCount} of ${listing.photoCount} downloaded`;
    if (listing.videoCount > 0) {
      value += ` · ${listing.videoCount} video to carry over (untested)`;
    }
    return { label: "Photos", value, state: "ok" };
  }
  return { label: "Photos", value: "Not counted yet — the backend downloads all of them", state: "unknown" };
}

function deliveryRow(listing: Listing): CheckRow {
  if (!listing.delivery) {
    return {
      label: "Delivery",
      value: "Not recovered — pick the delivery:",
      state: "missing",
      field: "delivery",
    };
  }
  if (listing.delivery.startsWith("Not readable")) {
    return {
      label: "Delivery",
      value: "Facebook's edit form was blocked — pick the delivery:",
      state: "missing",
      field: "delivery",
    };
  }
  let value = listing.delivery;
  if (listing.shipping) {
    value += ` · Shipping: ${listing.shipping}`;
  }
  return { label: "Delivery", value, state: "ok", editField: "delivery", editor: "options" };
}

export function buildCloneCheck(listing: Listing): CheckRow[] {
  return [
    {
      label: "Title",
      value: listing.title.replace(/\s+/g, " ").trim(),
      state: "ok",
      editField: "title",
      editor: "text",
    },
    { label: "Price", value: listing.price, state: "ok", editField: "price", editor: "text" },
    {
      label: "Description",
      value: listing.description.trim(),
      state: "ok",
      editField: "description",
      editor: "textarea",
    },
    categoryRow(listing),
    conditionRow(listing),
    photosRow(listing),
    { label: "Location", value: listing.locationLabel, state: "ok", editField: "location", editor: "text" },
    deliveryRow(listing),
  ];
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
};

interface Props {
  listing: Listing;
  picks: FieldPicks;
  onPick: (field: PickableField, value: string) => void;
  overrides: FieldOverrides;
  onOverride: (field: EditableField, value: string) => void;
}

export default function CloneCheckList({ listing, picks, onPick, overrides, onOverride }: Props) {
  const rows = buildCloneCheck(listing);
  const [editing, setEditing] = useState<EditableField | null>(null);
  const [draft, setDraft] = useState("");

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
      <li key={row.label} className="check-row check-missing">
        <span className="check-icon" aria-hidden="true">
          {STATE_ICON.missing}
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
    return (
      <li key={row.label} className="check-row check-ok">
        <span className="check-icon" aria-hidden="true">
          {STATE_ICON.ok}
        </span>
        <span className="check-body">
          <span className="check-label">{row.label}</span>
          <span className="check-value">{pick} (your pick — saved for this listing)</span>
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
          if (row.state === "missing" && row.field && !pick) {
            return renderMissingRow(row);
          }
          if (row.state === "missing" && pick) {
            return renderPickedRow(row, pick);
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
