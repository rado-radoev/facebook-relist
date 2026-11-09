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

## Household accounts — one signed-in person per device

The Relist backend can serve a whole household, but **there is no account
switcher, by design**:

- **Each person installs Relist on their own phone** and signs in to Relist
  as themselves, with their own app sign-in. A device only ever belongs to
  its one signed-in person, and the UI shows only that person's listings
  and history — there is no cross-account view, no admin, and no way to open
  anyone else's account from your phone.
- **Own Facebook login per person.** Each person connects their own
  Facebook account, typing their credentials into **Facebook's own login
  page** in the app's backend browser — the app never sees or stores
  anyone's password. A text-message code approval on their own phone is
  part of that login.
- **The backend derives the account from the authenticated Relist session
  on every request.** It never accepts an account id from the client, so a
  signed-in person can only ever reach their own listings, clone checks,
  saved answers, and history. Each account gets its own separate backend
  browser session, stored only on the home server.
- **Optional app-lock PIN** (off by default in the preview's copy) protects
  only their own device.
- In this preview the single signed-in person is Radoslav Radoev
  (connected, owns all 6 seed listings).
- **Exposure note:** Relist runs on the home network for the household. If
  it were ever exposed publicly beyond the home network, the per-person app
  sign-in in front of it becomes even more important — never the shared,
  unauthenticated local page.

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
  data/preview-seed.json    6 real listings used as preview data (each has an accountId)
  data/currentUser.ts       The one person signed in on this device
  data/listings.ts          Typed access to the seed data + history entries
  lib/status.ts             Shared status constants: labels, pill colours, filters
  lib/user.ts               Shared session constants: status labels, colours, first names
  components/               ConnectionCard, ListingRow, StatusPill,
                            CloneCheckList, TabBar
  screens/                  Listings, Detail (clone preview), Progress
                            (recreate timeline), History, Settings, Connect
                            (first-time Facebook setup for your own account)
  App.tsx                   Shell: header with signed-in identity, view
                            switching, bottom tab bar
  styles.css                Catppuccin Mocha theme
```

Screens in the preview:

- **Listings** — the header shows who is signed in on this device (avatar,
  name, and a "Sign out" stub) — there is no account switcher. Below it, a
  connection card for that same person ("Connected as … — session stored on
  this device" with Disconnect disabled in the preview, or a not-connected
  state with a "Connect Facebook" button), filter chips
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
- **Connect Facebook** — first-time setup: the steps the signed-in person
  follows to connect their own Facebook login on their own phone.
- **History** — past recreations (the Oct 12, 2026 Hot Wheels recreate),
  belonging to the signed-in person.
- **Settings** — "Your account" (who is signed in, Facebook session status,
  and the optional app-lock PIN that protects this phone only), a short
  "Family" note (family members use Relist on their own phone, signed in as
  themselves — there is no account switcher), plus where the app runs and
  how it will be deployed.

## Preview data

`src/data/preview-seed.json` and `public/listings/` are **preview stand-ins**
for the app's own backend. In the full app, the backend runs on the home
server, holds a separate Facebook session per household account (the app
never stores anyone's password), reads
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
