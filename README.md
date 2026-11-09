# Relist — Facebook Marketplace listing recreator

An iPhone-first PWA that recreates your own Facebook Marketplace listings
like-for-like: it downloads everything from the old listing (all photos,
title, price, description, stored category, condition, location, delivery),
creates a brand-new copy, waits for Facebook's review, and only then deletes
the old listing.

> **This branch (`preview/scaffold`) is a design preview only.**
> There is **no Facebook connection, no backend, and no credentials** in this
> preview. Listings, photos, and the recreate progress are stand-ins so the
> real flow can be seen and tapped through on a phone.

## Run it locally

```sh
npm install
npm run dev
```

Open the URL Vite prints (default http://localhost:5173). It is designed at
iPhone width (~390px) and centres as a phone-width column on desktop.

Other scripts:

```sh
npm run build    # type-check + production build into dist/
npm run preview  # serve the production build locally
```

## How the preview is structured

```
index.html                  App entry, PWA manifest + favicon links
public/
  manifest.webmanifest      PWA manifest (name Relist, standalone, Mocha theme)
  icon.svg                  App icon
  listings/<id>.jpg         Primary photo for each seed listing
src/
  data/preview-seed.json    6 real listings used as preview data
  data/listings.ts          Typed access to the seed data + history entries
  lib/status.ts             Shared status constants: labels, pill colours, filters
  components/               ConnectionCard, ListingRow, StatusPill,
                            CloneCheckList, TabBar
  screens/                  Listings, Detail (clone preview), Progress
                            (recreate timeline), History, Settings
  App.tsx                   Shell: header, view switching, bottom tab bar
  styles.css                Catppuccin Mocha theme
```

Screens in the preview:

- **Listings** — connection card ("Connected as … — session stored on this
  device", Disconnect is disabled in the preview), filter chips
  (Active / All / Available / In stock / Sold / Out of stock; Active is the
  default), listing rows with photo, price, status pill, and a photo-count
  badge where the count was verified (e.g. "5 photos + 1 video").
- **Listing detail / Clone preview** — a "Clone check" listing every
  recovered field with a status icon. Fields Facebook could not confirm are
  flagged in amber (for example the Hot Wheels listing's condition) — flagged,
  never guessed.
- **Recreate progress** — timeline: Downloading photos → Creating new listing
  → In review → New listing live → Old listing deleted → Done. In the preview
  the steps advance on a timer. Safety rule shown on screen: *the old listing
  is only deleted after the new one is live.*
- **History** — past recreations (the Oct 12, 2026 Hot Wheels recreate).
- **Settings** — where the app runs and how it will be deployed.

## Preview data

`src/data/preview-seed.json` and `public/listings/` are **preview stand-ins**
for the app's own backend. In the full app, the backend runs on the home
server, holds the Facebook session (the app never stores the password), reads
each listing from its Facebook page and edit view, and downloads all of its
photos — the two listings marked with `photoCount` / `category` / `delivery`
in the seed are the ones verified live on 2026-11-09.

## Deploy to Vercel later

The phone UI is a static Vite build, so moving it to Vercel needs no code
changes:

1. `npm run build` — output lands in `dist/`.
2. Either import this repo in Vercel (framework preset: **Vite**, build
   command `npm run build`, output directory `dist`), or run `vercel deploy`
   from the repo root.
3. The Facebook-facing backend stays on the home server; only this static UI
   moves to Vercel.
