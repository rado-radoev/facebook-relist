# Relist — Facebook Marketplace listing recreator

An iPhone-first PWA that recreates your own Facebook Marketplace listings
like-for-like: it downloads everything from the old listing (all photos,
title, price, description, stored category, condition, location, delivery),
creates a brand-new copy, waits for Facebook's review, and only then deletes
the old listing.

> **This branch (`build/sprint-1`) is Sprint 1: the backend foundation is
> real.** Relist app sign-in, per-user Facebook browser sessions, and the
> Connect Facebook live remote view all work against the backend in
> `server/`. **Listings are still the seed set** — live listings sync is
> Sprint 2, the recreate job is Sprint 3, and the real-iPhone check is
> Sprint 4 (see "Sprint 1" below).

## Sprint 1 — backend foundation

What works now:

- **Relist app accounts** — register / sign in / sign out with your own
  Relist email + password. Passwords are hashed with scrypt (Node's
  built-in memory-hard KDF — no native module to build). Sessions are
  httpOnly cookies; the backend stores only a hash of the session token.
- **One account per signed-in person, enforced by the backend.** Every API
  request derives the account from the session cookie. No endpoint accepts
  an account id, there is no admin, and there is no account switcher.
- **Per-user browser profiles** — each Relist user gets one persistent
  Playwright Chromium profile under `<DATA_DIR>/profiles/<userId>/` on the
  server, managed by a session manager (one active browser per user).
- **Connect Facebook** — starts that user's browser on Facebook's own
  login page. The app shows a **live remote view** (screenshots streamed
  over a WebSocket) and forwards taps and keystrokes into Facebook's page,
  so the person types their credentials into facebook.com itself and does
  their own 2FA/checkpoint. **No Relist form or endpoint ever receives a
  Facebook password.** Login completion is detected from Facebook's
  `c_user` cookie; the profile persists on the server.
- **Session states** — `not_connected` / `login_in_progress` / `connected`
  / `needs_check` / `expired`, served by the API and reflected live in the
  connection card. **Disconnect** ends the
  Facebook session and wipes that user's browser profile.
- **No Settings screen, no header identity block** (her call: there is
  nothing to set, and the connection card already carries the account and
  connection state). The `/api/auth/logout` endpoint exists, but there is
  no sign-out button in the UI for now. The two bottom tabs are Listings
  and History. The frontend reads the
  API base from `VITE_API_BASE_URL` (see `.env.example`).
- **Clone preview pickers + edits — design rule, binding for Sprint 2:**
  a field the clone check cannot recover is **never shown as just a
  warning**. Its row offers the field's real options inline (Condition →
  New / Used – Like New / Used – Good / Used – Fair — Facebook's actual
  values; category and delivery likewise), Recreate stays blocked until a
  pick is made, and the pick is treated as supplied and **saved per
  listing** so the same item never asks twice (localStorage in this seed
  UI; the backend store from Sprint 2). Every **already-set** field gets
  an **Edit** option too (the same option chips for category / condition /
  delivery; text editors for title / price / description / location; a
  photo editor for photos — remove / replace / add). An edited value is
  marked **Edited** and is the value the recreate uses; the recovered
  originals are never modified. **All** clone-check items are editable —
  no row is display-only. (Photo edits are session-only in this seed UI;
  from Sprint 2 the backend archive persists them like the other
  picks/edits.)
- **Condition recovery order (verified live 2026-11-09, for Sprint 2):**
  edit form → buyer-facing listing page's **Details** section (it shows
  "Condition — Used - like new" when the listing has one) → ask with
  options. The Hot Wheels listing has no condition anywhere on Facebook —
  its page and Your Listings both show Facebook's own prompt "Add info
  about your item's condition" — so for it, asking is the correct last
  step, which the picker above handles.

Verified: 30 Vitest tests (auth, session-state detection, store,
per-user isolation, API behaviour) plus a live end-to-end run on
2026-11-09 — a throwaway app user registered, connected, received real
screenshots of the actual facebook.com login page, and dummy text typed
through the remote view landed in Facebook's own email field (archived
frames: `server/scripts/e2e-frame-*.jpg`, regenerable any time with
`server/scripts/e2e-live.mjs`).

Not built yet:

- **Sprint 2:** live listings list + clone preview from the logged-in
  session (the listings in the app today are still the seed set, labelled
  as such on screen), including the listing-video download test.
- **Sprint 3:** the recreate job (create → poll review → delete old only
  once the new one is Available → verify) + real history.
- **Sprint 4:** install on the real iPhone and run one real recreate
  end-to-end. Known Sprint 4 item: the remote view's typing box is
  desktop-verified; the iOS keyboard behaviour gets checked there.

### Run the backend + frontend locally

```sh
# Backend (terminal 1)
cd server
npm install
npx playwright install chromium   # one-time browser download
npm run dev                       # http://localhost:8787

# Frontend (terminal 2, repo root)
npm install
npm run dev                       # http://localhost:5173
```

Backend config is via env (see `server/.env.example`): `PORT`, `HOST`,
`DATA_DIR` (accounts + browser profiles; default `server/data/`),
`CORS_ORIGIN`, `COOKIE_SECURE`, and two sandbox-only options
(`BROWSER_PROXY`, `BROWSER_IGNORE_CERT_ERRORS`) that should stay unset on
the home server.

Tests: `npm run server:test` from the repo root (or `npm test` in
`server/`).

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
- Whoever signs in on a device is that device's one person, and the seed
  listings stand in for their listings until Sprint 2.
- **Exposure note:** Relist runs on the home network for the household. If
  it were ever exposed publicly beyond the home network, the per-person app
  sign-in in front of it becomes even more important — never the shared,
  unauthenticated local page.

## Run the preview UI on its own

Without the backend, the frontend falls back to the sign-in screen and
cannot load an account — use the two-terminal setup above for the real
app. For a pure visual check of the screens:

```sh
npm install
npm run dev
```

Open the URL Vite prints (default http://localhost:5173). It is designed at
iPhone width (~390px) and centres as a phone-width column on desktop.

Other scripts:

```sh
npm run build        # type-check + production build into dist/
npm run preview      # serve the production build locally
npm run server:test  # backend test suite
```

## How the app is structured

```
index.html                  App entry, PWA manifest + favicon links
public/
  manifest.webmanifest      PWA manifest (name Relist, standalone, Mocha theme)
  icon.svg                  App icon
  listings/<id>.jpg         Primary photo for each seed listing
server/                     The Relist backend (Node + TypeScript + Fastify)
  src/config.ts             Env config (PORT, DATA_DIR, CORS, proxy options)
  src/passwords.ts          scrypt password hashing (node:crypto)
  src/store.ts              JSON store: users + hashed session tokens
  src/facebookStatus.ts     Facebook session states + page-signal detection
  src/browserManager.ts     One persistent Playwright profile per user
  src/connectShim.ts        CONNECT shim for picky egress proxies (only
                            used when a proxy is configured)
  src/auth.ts               Register / login / logout / me (cookie session)
  src/facebookRoutes.ts     Facebook status / connect / disconnect +
                            the live remote-view WebSocket
  src/*.test.ts             Vitest suites next to the code they cover
  scripts/e2e-live.mjs      Live end-to-end check against facebook.com
src/
  data/preview-seed.json    6 real listings used as stand-in data until Sprint 2
  data/listings.ts          Typed access to the seed data + history entries
  lib/api.ts                Backend API client (cookie session, no account ids)
  lib/status.ts             Shared status constants: labels, pill colours, filters
  lib/user.ts               Shared session constants: status labels, colours
  components/               ConnectionCard, ListingRow, StatusPill,
                            CloneCheckList, TabBar, RemoteBrowserView
  screens/                  Auth (Relist sign-in), Listings, Detail (clone
                            preview), Progress (recreate timeline), History,
                            History, Connect (live Facebook login view)
  App.tsx                   Shell: auth gate, header with signed-in identity,
                            view switching, bottom tab bar
  styles.css                Catppuccin Mocha theme
```

Screens:

- **Listings** — the header is just the app name; who is signed in and the
  Facebook connection state live on the connection card below it — there
  is no account switcher. The connection card is driven by the real backend state
  ("Connected as …", "Login in progress", "Check your phone", "Session
  expired", or a "Connect Facebook" button; Disconnect works and wipes the
  server-side browser profile), filter chips
  (Active / All / Available / In stock / Sold / Out of stock; Active is the
  default), listing rows with photo, price, status pill, and a photo-count
  badge where the count was verified (e.g. "5 photos + 1 video").
- **Listing detail / Clone preview** — a "Clone check" listing every
  recovered field with a status icon. A field Facebook could not confirm
  (for example the Hot Wheels listing's condition, which Facebook's edit
  form shows empty) is **not** a bare warning: its row offers the field's
  real options as tappable chips, Recreate stays blocked until a pick is
  made, and the pick is saved for that listing (see the design rule under
  "Sprint 1" above). Fields that *were* recovered show their value plus an
  **Edit** button — edits are marked "Edited" and are what the recreate
  uses.
- **Recreate progress** — timeline: Downloading photos → Creating new listing
  → In review → New listing live → Old listing deleted → Done. In the preview
  the steps advance on a timer. Safety rule shown on screen: *the old listing
  is only deleted after the new one is live.*
- **Connect Facebook** — the real connect flow: opens Facebook's own login
  page in the signed-in person's backend browser and shows it live, with
  taps and keystrokes forwarded into the page (see "Sprint 1" above).
- **History** — past recreations (the Oct 12, 2026 Hot Wheels recreate),
  belonging to the signed-in person.

## Seed data (stand-in until Sprint 2)

`src/data/preview-seed.json` and `public/listings/` are **stand-ins** for
live listings until Sprint 2 wires the listings list to the backend
session. The backend itself is real (see "Sprint 1" above): it runs on the
home server, holds a separate Facebook session per household account (the
app never stores anyone's password), and from Sprint 2 will read each
listing from its Facebook page and edit view and download all of its
photos — the two listings marked with `photoCount` / `category` /
`delivery` in the seed are the ones verified live on 2026-11-09.

## Deploy to Vercel later

The phone UI is a static Vite build, so moving it to Vercel needs no code
changes:

1. `npm run build` — output lands in `dist/`.
2. Either import this repo in Vercel (framework preset: **Vite**, build
   command `npm run build`, output directory `dist`), or run `vercel deploy`
   from the repo root.
3. The Facebook-facing backend stays on the home server; only this static UI
   moves to Vercel.
