// Photo editor for the clone preview: every photo can be removed or
// replaced, and new photos can be added. Changes live in the parent
// (DetailScreen) and are what the recreate will use — the recovered
// originals themselves are never modified.

import type { ChangeEvent } from "react";
import { readFileAsDataUrl, type PhotoTile } from "../lib/photos";

interface Props {
  tiles: PhotoTile[];
  onChange: (tiles: PhotoTile[]) => void;
}

export default function PhotoEditor({ tiles, onChange }: Props) {
  async function handleReplace(tileId: string, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    const src = await readFileAsDataUrl(file);
    onChange(
      tiles.map((tile) => (tile.id === tileId ? { ...tile, src, origin: "replaced" as const } : tile)),
    );
  }

  async function handleAdd(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files ? [...event.target.files] : [];
    event.target.value = "";
    if (files.length === 0) {
      return;
    }
    const added: PhotoTile[] = [];
    for (const file of files) {
      const src = await readFileAsDataUrl(file);
      added.push({
        id: `added-${Date.now()}-${added.length}`,
        src,
        label: `Added photo ${added.length + 1}`,
        origin: "added",
      });
    }
    onChange([...tiles, ...added]);
  }

  function handleRemove(tileId: string) {
    onChange(tiles.filter((tile) => tile.id !== tileId));
  }

  return (
    <span className="photo-editor">
      <span className="photo-grid">
        {tiles.map((tile) => (
          <span key={tile.id} className="photo-tile">
            {tile.src ? (
              <img className="photo-tile-img" src={tile.src} alt={tile.label} />
            ) : (
              <span className="photo-tile-placeholder">{tile.label} — arrives with the backend download</span>
            )}
            <span className="photo-tile-label">
              {tile.label}
              {tile.origin === "replaced" ? <span className="photo-tile-tag">Replaced</span> : null}
              {tile.origin === "added" ? <span className="photo-tile-tag">New</span> : null}
            </span>
            <span className="photo-tile-actions">
              <label className="photo-tile-button">
                Replace
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(event) => void handleReplace(tile.id, event)}
                />
              </label>
              <button type="button" className="photo-tile-button" onClick={() => handleRemove(tile.id)}>
                Remove
              </button>
            </span>
          </span>
        ))}
      </span>
      {tiles.length === 0 ? (
        <span className="photo-empty">No photos — a listing needs at least one. Add a photo to continue.</span>
      ) : null}
      <label className="check-chip photo-add-button">
        + Add photo
        <input type="file" accept="image/*" multiple hidden onChange={(event) => void handleAdd(event)} />
      </label>
    </span>
  );
}
