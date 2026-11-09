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

## Household accounts

Relist is designed for a household, not a single user:

- **One profile per person.** The Listings screen has an account switcher
  (plus a "＋ Add person" chip), and Settings lists every profile under
  "Household accounts" with its session status.
- **Own Facebook login per person.** Each person logs in with their own
  Facebook account, typing their credentials into **Facebook's own login
  page** in the app's backend browser — the app never sees or stores
  anyone's password. A text-message code approval on their own phone is
  part of that login.
- **Separate backend browser session per account**, stored only on the home
  server, and **everything is scoped by account**: listings, clone checks,
  saved answers, and history belong to one person, and each person sees
  only their own listings.
- **Optional per-profile PIN** (off by default in the preview's copy) for
  anyone who wants a lock on their profile.
- In this preview there are two profiles: Radoslav (connected, owns all 6
  seed listings) and a placeholder "Family member" who has not connected
  yet — switching to them shows the not-connected state and the Add/Connect
  explanation.
- **Exposure note:** this local, household-trust design is fine on the home
  network. If Relist were ever exposed publicly beyond the home network, it
  would first need a real per-person app login in front of it.

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
  data/accounts.ts          Household accounts: one profile per person
  data/listings.ts          Typed access to the seed data + history entries
  lib/status.ts             Shared status constants: labels, pill colours, filters
  lib/accounts.ts           Shared session constants: status labels, colours, first names
  components/               AccountSwitcher, ConnectionCard, ListingRow,
                            StatusPill, CloneCheckList, TabBar
  screens/                  Listings, Detail (clone preview), Progress
                            (recreate timeline), History, Settings, Connect
                            (Add person / Connect Facebook explanation)
  App.tsx                   Shell: header, view switching, bottom tab bar
  styles.css                Catppuccin Mocha theme
```

Screens in the preview:

- **Listings** — account switcher (one chip per household member, the
  active person highlighted, plus "＋ Add person"), a connection card that
  reflects the active account ("Connected as … — session stored on this
  device" with Disconnect disabled in the preview, or a not-connected state
  with a "Connect Facebook" button for a member who has not connected yet —
  their listings area is empty), filter chips
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
- **Add person / Connect** — the steps a household member follows to
  connect their own Facebook login; each person sees only their own
  listings.
- **History** — past recreations (the Oct 12, 2026 Hot Wheels recreate),
  scoped to the active account.
- **Settings** — "Household accounts" (every profile with its session
  status, and the optional per-profile PIN), plus where the app runs and
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
