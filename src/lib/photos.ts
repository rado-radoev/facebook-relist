// Photo tiles for the clone preview's photo editor.
//
// Every listing's primary photo is a real file in the seed. The remaining
// photos are known by count (photoCount, verified live for two listings)
// but their files arrive with the backend download in Sprint 2 — here
// they are stand-in tiles. Removing a stand-in means "do not carry this
// photo into the clone"; replacing or adding uses real image files the
// person picks, held as data URLs for this session (from Sprint 2 the
// backend archive stores them properly).

import type { Listing } from "../types";

export interface PhotoTile {
  id: string;
  /** Image source, or null for a stand-in tile (file arrives in Sprint 2). */
  src: string | null;
  label: string;
  origin: "original" | "added" | "replaced";
}

export function initialPhotoTiles(listing: Listing): PhotoTile[] {
  const tiles: PhotoTile[] = [
    { id: "photo-1", src: listing.photo, label: "Photo 1", origin: "original" },
  ];
  const count = listing.photoCount ?? 1;
  for (let index = 2; index <= count; index += 1) {
    tiles.push({ id: `photo-${index}`, src: null, label: `Photo ${index}`, origin: "original" });
  }
  return tiles;
}

export function tilesDiffer(a: PhotoTile[], b: PhotoTile[]): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
