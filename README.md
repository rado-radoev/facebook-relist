# Relist — Facebook Marketplace listing recreator

An experimental, offline-tested scaffold for reviewing and preparing a
Facebook Marketplace listing copy. It is not currently authorized to create
or delete Facebook listings. The live Facebook DOM, gallery completeness,
photo uploads, category/shipping/video flows, and replacement verification
remain unverified; see `docs/remediation-status.md` before using it.

> **Safety gate:** production Facebook create/delete are hard-disabled in
> the real driver. `RELIST_DRY_RUN=0`, restored jobs, API payloads, and UI
> state cannot enable them. Dry-run skips production browser create/delete
> actions; simulated job progress is exercised only with injected fake
> drivers. This is not evidence that a real recreate works. Live use also
> requires resolving the credential-relay policy and separately reviewed
> Facebook-readiness evidence. No deployment or live Facebook requests are
> part of this branch.

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
  so the person types into Facebook's page and does their own
  2FA/checkpoint. **This is a credential relay:** typed input passes through
  Relist frontend and server memory before reaching Facebook. It is not
  technical non-receipt, and consent does not change that fact. Login completion is detected from Facebook's
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
- **Condition recovery order (reported from a prior manual spike; not
  independently verified by the integrated collector):**
  edit form → buyer-facing listing page's **Details** section (it shows
  "Condition — Used - like new" when the listing has one) → ask with
  options. The Hot Wheels listing has no condition anywhere on Facebook —
  its page and Your Listings both show Facebook's own prompt "Add info
  about your item's condition" — so for it, asking is the correct last
  step, which the picker above handles.

Historical test counts and Facebook-facing scripts are not evidence of
current live integration. The legacy Facebook-facing E2E must not be run;
offline tests use synthetic data and injected browser/driver transports.

Not built yet:

- **Sprint 4:** install on the real iPhone and run one real recreate
  end-to-end. Known Sprint 4 item: the remote view's typing box is
  desktop-verified; the iOS keyboard behaviour gets checked there.
  (The Sprint 3 recreate job is built — see "Sprint 3" below.)

## Sprint 2 — listings sync + full clone recovery

What works now (all of it inside the signed-in person's own backend
browser session; identity still comes only from the app session):

- **Listings sync** — `POST /api/listings/sync` opens the person's own
  selling list (`facebook.com/marketplace/you/selling`) read-only and
  stores their listings per user: id, title, price, status, primary
  photo, listing link, listed date. `GET /api/listings` serves the stored
  set. The Listings screen shows the real synced listings when connected
  (with a Sync / Re-sync button); before the first sync it shows the seed
  set, clearly labelled as samples. One honesty note on status: the
  selling list shows a single undifferentiated "Active" state, which
  sync maps to the app's "Available" — the Available/In stock distinction
  from other Facebook surfaces is not visible on that page.
- **Clone recovery** — `POST /api/listings/:id/clone/recover` gathers
  the full clone in the verified recovery order: **Edit form first**
  (Step 1; then Step 2 via the wizard's own Next button — in-form
  navigation, never a save), **listing page Details as fallback** (a set
  condition appears there as a labelled row), then **missing, with the
  reason** — a value is never invented. The known hard case is handled:
  when an empty condition disables the edit form's Next, Step 2 is never
  read; location still falls back to the listing page's "Listed … in
  San Diego, CA" label, and delivery is reported missing with the
  blocked-Step-2 reason instead of failing the whole recovery.
- **Photo archive** — every photo the listing page exposes is downloaded
  (original order) into `<DATA_DIR>/archive/<userId>/<listingId>/`; a
  photo whose download fails is recorded at its own slot as missing,
  never dropped or shifted. The person's archived photos are served back
  only to that person (`GET /api/listings/:id/photos/:index`).
- **Video, honestly flagged** — recovery records a listing's video and
  attempts the same download as photos (100 MB archive cap). The clone
  reports one of: not present / `recovered` / `present_not_downloaded`
  with the reason. Actually downloading a real listing video is still
  untested territory (see below).
- **Persistence + isolation** — recoveries and the person's saved
  picks/edits/photo selection live in the backend store, scoped by the
  owning user (`GET/PUT /api/listings/:id/clone[/picks]`). Recovery is
  **refused (404)** for any listing that is not in the caller's own
  synced list, so nobody can point recovery — or clone reads, picks, or
  photo reads — at someone else's listing. The frontend clone preview is
  wired to this real data: synced listings get a "Run clone check" card,
  and the recovered-vs-missing checklist (pickers for missing fields,
  Edit for everything set) is fed by the recovery, with picks/edits
  saved to the backend instead of localStorage.
- **Revision-bound saves + structured delivery edits** — every clone
  record carries a monotonic `revision`. A picks/edits save sends the
  revision the screen loaded; if the stored clone has moved on, the
  save is refused with **409** ("changed since it was loaded; reload
  before saving or recreating") instead of silently overwriting, and
  the screen keeps its local state visible. Starting a recreate job
  sends the same revision and gets the same 409 treatment when it is
  stale — a job is never built from clone data the person did not
  approve. Saves without a revision (legacy clients) are still
  accepted. Records written before revision tracking load unchanged:
  a missing revision reads as 0. Delivery choices are structured end
  to end: shipping and each meetup option (public / door pickup / door
  dropoff) can be set to an explicit yes or no in the clone preview,
  an unanswered option stays **unknown** (never collapsed to "no"),
  and job resolution refuses to recreate while any of them is still
  unknown.
- **Read-only against Facebook** — sync and recovery open pages and read
  them; the only click anywhere is the edit wizard's "Next". No listing
  is created, edited, or deleted in this sprint (that's Sprint 3).

How it is verified — and what is NOT verified yet:

- **59 Vitest tests** (30 from Sprint 1, all still passing): the
  snapshot→data mapping is unit-tested against **fixture snapshots** in
  `server/src/fixtures/` — honest hand reconstructions, in the
  collector's output shape, of the two listings the 2026-11-09 spike
  verified live (Hot Wheels: 3 photos, Toys & Games, condition missing
  everywhere, Step 2 blocked; Keyboard Switches: 5 photos + 1 video,
  Keyboards & Keypads, Used - Like New, attributes, San Diego, Local
  pickup only, shipping off, all meetup prefs unchecked). API tests
  drive the full flow (register → connect → sync → recover → picks →
  photo serving) through a fake browser serving those fixtures,
  including the cross-user refusal cases.
- **Live verification is PENDING the owner's first Connect (Sprint 4).**
  No backend profile holds a real Facebook login yet, so none of the
  scraping layer has run against real Facebook: the collector script's
  DOM selectors, the edit-page URL pattern (`/marketplace/edit/<id>`),
  the selling-page card/status text shapes, gallery-photo scoping on a
  real listing page, photo downloads from Facebook's real CDN, and
  video download are all first-run items for that session. The design
  degrades honestly if a surface differs: an unreadable edit form falls
  back to the listing page, and anything still unreadable is reported
  missing with a reason — never guessed.

## Sprint 3 — the recreate job (create → watch → delete)

The highest-stakes part of Relist: the first code that writes to
Facebook. It is built safeguard-first — the safeguards below are the
deliverable, enforced in the backend (`server/src/jobService.ts`),
never just in the UI.

**The flow (requirements §3, in order, no shortcuts):**

1. **Job creation** — `POST /api/listings/:id/jobs` builds the job from
   the stored clone check: recovered values + the person's picks/edits
   (`server/src/jobLogic.ts` resolves them). The server refuses (400,
   with the field names) while **any** field is still missing/unpicked,
   refuses (404) listings that aren't the caller's own synced ones, and
   refuses (409) while another job is active for the account — **one
   job per user at a time**.
2. **Create** — inside the owning user's own browser session, the
   driver walks Facebook's Marketplace create flow with human pacing:
   upload the archived photos (original order, plus the video when it
   was recovered), fill title/price/description, pick
   category/condition/attributes, then Step 2 (location, delivery type,
   meetup preferences) and submit. The new listing's id/link is
   recorded from the result.
3. **Watch** — the job polls the new listing about every 15 minutes
   (`RELIST_POLL_INTERVAL_MS`, jittered) until it is Available. Review
   stuck past 48 hours (`RELIST_STUCK_AFTER_MS`) → the job goes
   **stuck**, an alert is surfaced in the app, and the old listing is
   **not** deleted.
4. **Delete** — only after the new listing is confirmed Available, and
   only after the delete step **re-verifies fresh, at delete time**:
   the new listing must be Available *now* (the cached state is never
   trusted), its id must differ from the old listing's id, and the old
   listing must still be the person's own listed item. Then the old
   listing is deleted.
5. **Verify + history** — the job re-reads the selling list (new one
   present, old one gone) before calling itself done, and records a
   history entry (old link, new link, date, and which fields the
   person supplied or edited). The Progress screen follows the real
   job state from the API (`GET /api/jobs/:id`, polled); History shows
   the backend's completed jobs (`GET /api/history`).

**Idempotency & crash safety:**

- The job is a **persistent state machine** —
  `queued → creating → in_review → available → deleting → done`,
  with `stuck` / `failed` as safe terminal states — stored in the
  backend store and saved **before** each browser action. A server
  restart resumes every active job from its persisted state (the
  runner sweeps on startup and every 30s); every step is safe to
  re-enter.
- **Duplicate guard:** before *every* create attempt — including a
  retry after a crash mid-create — the person's selling list is
  checked for a copy the job may already have posted (title + price +
  first-photo fingerprint; best-effort, see `jobLogic.ts`). A found
  copy is **adopted** as the job's new listing, never duplicated.
- **Per-user job lock** (above) plus an in-process guard so the
  route's background kick and the runner sweep can never drive the
  same job concurrently; the store's atomic writes use per-save tmp
  files for the same reason (a race the Sprint 3 tests caught).
- **Audit log:** every job carries a timestamped audit trail
  (creation, each poll, guard decisions, delete, verification),
  visible in the job API and the Progress screen's data.

- **Dry-run — default; not a live preview:**

- `RELIST_DRY_RUN` unset (or anything but `0`) = **dry-run ON**. A
  job created in dry-run mode is marked `dryRun` permanently.
- The production Facebook driver returns before browser create/delete
  interaction in dry-run mode. It does not fill a form or open a Delete
  menu. State-machine walkthroughs are tested with injected fake drivers;
  they are simulated and do not prove production Facebook behavior.
- `RELIST_DRY_RUN=0` = **live mode** — the owner's switch. Jobs created
  while it is set are marked `dryRun: false`, and the driver performs
  real creates and deletes for them. The setting is captured onto each
  job at creation, so changing it later never flips a job that already
  exists. Default stays ON (safe); `0` is for a supervised real
  recreate, owner present.
- Prove it any time with the fake-driver smoke check:
  `cd server && npx tsx scripts/dry-run-smoke.ts` (6 checks: job is
  dry-run by default, walks to done, the driver only ever receives
  dry-run calls, no history recorded).

**How it is verified — and what is NOT verified yet:**

- **99 Vitest tests** (59 from Sprints 1–2, all still passing): the
  pure resolution/fingerprint/availability logic (18), the state
  machine against a fake driver with a fake clock (15) — full happy
  path, stuck-after-48h with the old listing never deleted,
  delete-guard refusals (fresh check back in review, new id == old
  id, dry-run), duplicate adoption, resume-after-restart from both
  `in_review` and mid-`creating`, per-user lock and isolation — and
  the API surface (7) including 400-with-missing-fields, 409 lock,
  and cross-user 404s.
- **Live create/delete is UNVERIFIED.** Every write-path script in
  `server/src/facebookDriver.ts` (create-form filling, photo upload,
  category/condition pickers, the delete flow, availability reading)
  is written from the verified spike observations but has **never run
  against real Facebook** — no backend profile holds a real login
  yet. The first live run is Sprint 4: the owner present, her
  listing, her confirmation, dry-run first, then one real recreate
  watched end to end. Until then, no claim is made that a real
  create or delete works.

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

Both loopback spellings work: open the app at `http://localhost:5173`
**or** `http://127.0.0.1:5173` (or `http://[::1]:5173`). The backend
binds dual-stack (IPv4 + IPv6) by default, the frontend talks to the
backend on the same host name the page was served from, and the
backend accepts any loopback origin — so it no longer matters which
spelling your browser resolves `localhost` to.

**If sign-in says "Could not reach the Relist backend":** the backend
(terminal 1) is not running or not reachable. Check
<http://localhost:8787/api/health> in the browser — it should answer
`{"ok":true}`. If it doesn't load, (re)start terminal 1 and leave it
running; the frontend alone cannot sign anyone in.

**Phone test on the home Wi-Fi:** the backend binds every interface by
default (dual-stack `::`), so it also answers at the PC's LAN address.
Start the frontend so the phone can reach it, and tell the backend the
phone's page origin (a LAN origin is not loopback, so it must be the
configured one):

```sh
# Backend (terminal 1) — use your PC's LAN IP
CORS_ORIGIN=http://192.168.1.20:5173 npm run dev

# Frontend (terminal 2)
npm run dev -- --host
```

Then open `http://192.168.1.20:5173` (your PC's LAN IP) in the phone's
browser and sign in there. The app talks to the backend on the same
host the page was served from, so nothing else needs configuring.

Backend config is via env (see `server/.env.example`): `PORT`, `HOST`,
`DATA_DIR` (accounts + browser profiles; default `server/data/`),
`CORS_ORIGIN`, `COOKIE_SECURE`, and two sandbox-only options
(`BROWSER_PROXY`, `BROWSER_IGNORE_CERT_ERRORS`) that should stay unset on
the home server.

Tests: `npm ci && npm ci --prefix server`, then `npm run server:test`,
`npm run server:typecheck`, and `npm run build` from the repo root. The
dev servers are reachable on the home LAN by design (that is how the
phone test works) — do not expose them beyond the home network: no
port forwarding, no public URL. Relist's own sign-in is the only gate
in front of them.

## Run it in Docker (home server)

The whole app as two containers: the backend (with Playwright's
Chromium inside it — the phone never runs Playwright; it only shows the
live view) and the web frontend.

```sh
cp .env.example .env
# Edit .env: set CORS_ORIGIN to the exact address you will open on the
# phone, e.g. CORS_ORIGIN=http://192.168.1.20:5173 with your Docker
# host's LAN IP. It must match exactly, or sign-in is blocked.
docker compose up -d --build
```

Then open `http://<docker-host-LAN-IP>:5173` on the phone and sign in.
The app calls the backend at the same origin it was loaded from, and
the web image proxies those `/api` calls (including the live-view
WebSocket) to the backend container internally — so the phone only
needs port 5173. Compose also publishes the backend's 8787 on the
host, which is handy for health checks
(`http://localhost:8787/api/health`) but not needed by the app.

**Data:** everything that matters — accounts, Facebook browser
profiles, downloaded photos — lives in the named Docker volume
`relist-data`, mounted at `/data` in the backend container, so it
survives rebuilds and restarts. Back it up with
`docker run --rm -v relist-data:/data -v "$PWD":/backup alpine tar czf /backup/relist-data.tgz -C /data .`
(stop the backend first for a clean copy).

**Dry-run is still the default** in Docker too: recreates post and
delete nothing real until `RELIST_DRY_RUN=0` is set in `.env` for a
supervised live run.

**Older CPUs (no x86-64-v2):** the backend still runs. Photo
validation's primary decoder (sharp) cannot load on such CPUs, so
validation automatically falls back to ffprobe; only photo recovery is
affected, and only for hosts missing both. Setting the VM's CPU type
to **host** in the hypervisor restores the primary decoder.

**Home network only.** Do not port-forward these ports, put them on a
public URL, or otherwise expose them beyond the home network — the app
has no gate beyond its own sign-in, and whoever can reach it can drive
a signed-in Facebook session.

### Behind Nginx Proxy Manager (HTTPS)

Put a single NPM proxy host in front of the **web** service
(`<docker-host>:5173`) and turn NPM's **Websockets Support** ON. No
NPM custom location is needed: the web image already proxies `/api`
(HTTP and the live-view WebSocket) to the backend internally, so NPM
only ever talks to the web container.

For that route, the backend's `.env` values must match the HTTPS
origin exactly:

```sh
CORS_ORIGIN=https://fbrelist.superlan.duckdns.org   # your subdomain, exactly as opened in the browser
COOKIE_SECURE=1
```

With `COOKIE_SECURE=1` the session cookie is only sent over HTTPS:
the plain-HTTP LAN address (`http://<docker-host>:5173`) will still
load, but it will not hold a session — always use the HTTPS address.

## Sign in to Relist with Facebook (optional)

Relist can offer **Continue with Facebook** on its own sign-in screen —
Facebook confirms who you are TO Relist, so there is no separate Relist
password to forget. This is only about signing in to the app itself: it
does **not** connect your Marketplace listings (that is still the
separate Connect step, with the backend browser, afterwards).

One-time setup, on the owner:

1. Go to [developers.facebook.com](https://developers.facebook.com) →
   **My Apps → Create App**, and add the **Facebook Login** use case.
2. In **Facebook Login → Settings**, set **Valid OAuth Redirect URIs**
   to exactly:
   `https://fbrelist.superlan.duckdns.org/api/auth/facebook/callback`
   (your own public Relist address + that path — it must match
   character for character).
3. From **App Settings → Basic**, take the **App ID** and **App
   Secret**, and put them in the Docker host's `.env` (the same file
   that holds `CORS_ORIGIN`):

   ```sh
   FACEBOOK_APP_ID=<your app id>
   FACEBOOK_APP_SECRET=<your app secret>
   ```

   The secret is a password-grade credential: it belongs only in that
   `.env` on the Docker host — never in chat, never in git.
4. Restart the backend (`docker compose up -d`). The sign-in screen now
   shows **Continue with Facebook**. Leave either variable out and the
   feature stays fully off: no button, and the endpoints answer 404.

How it works on the phone: tapping the button runs Facebook's own login
in the browser, then lands on a Relist page that says you're signed in
and shows a **one-time sign-in code**. The browser that finished the
Facebook login is not the installed app (iOS keeps their storage
separate), so if the app doesn't open signed in, tap **I have a sign-in
code** on the app's sign-in screen and type the code in. Codes work
once and expire in 10 minutes. Email/password sign-in keeps working
exactly as before; an account first created through Facebook has no
Relist password, and if its email matches an existing Relist account,
the Facebook identity is attached to that existing account — same
account, same listings, same browser profile.

## Household accounts — one signed-in person per device

The Relist backend can serve a whole household, but **there is no account
switcher, by design**:

- **Each person installs Relist on their own phone** and signs in to Relist
  as themselves, with their own app sign-in. A device only ever belongs to
  its one signed-in person, and the UI shows only that person's listings
  and history — there is no cross-account view, no admin, and no way to open
  anyone else's account from your phone.
- **Own Facebook login per person.** Each person connects their own
  Facebook account, typing credentials into Facebook's login page in the
  app's backend browser. This relays typed input through Relist frontend
  and server memory. The original owner's absolute password non-receipt
  requirement is unresolved; this architecture does not satisfy it. A
  text-message code approval on their own phone is
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
  src/store.ts              JSON store: users, hashed session tokens,
                            per-user synced listings + clone records
  src/facebookStatus.ts     Facebook session states + page-signal detection
  src/browserManager.ts     One persistent Playwright profile per user;
                            read-only snapshot collection + wizard advance
  src/connectShim.ts        CONNECT shim for picky egress proxies (only
                            used when a proxy is configured)
  src/auth.ts               Register / login / logout / me (cookie session)
  src/facebookRoutes.ts     Facebook status / connect / disconnect +
                            the live remote-view WebSocket
  src/snapshot.ts           PageSnapshot shape + the in-page collector
                            script (read-only) + Facebook page URLs
  src/facebookExtract.ts    Pure snapshot → data mapping: selling list,
                            edit form, listing Details, recovery merge
  src/cloneTypes.ts         Synced listing / clone recovery API shapes
  src/recovery.ts           Recovery orchestration: field merge + photo
                            and video download into the archive
  src/scrapeService.ts      Sync + recovery driven through the person's
                            own browser session (synced-list gate)
  src/listingsRoutes.ts     Listings / sync / clone / picks / photo APIs
  src/fixtures/             Fixture snapshots of the two spike listings
                            (labelled reconstructions — see its index.ts)
  src/*.test.ts             Vitest suites next to the code they cover
  scripts/e2e-live.mjs      Live end-to-end check against facebook.com
src/
  data/preview-seed.json    6 real listings used as stand-ins before the
                            first sync (labelled samples on screen)
  data/listings.ts          Typed access to the seed data + history entries
  lib/api.ts                Backend API client (cookie session, no account ids)
  lib/cloneMapping.ts       Backend DTOs → screen Listing mapping
  lib/status.ts             Shared status constants: labels, pill colours, filters
  lib/user.ts               Shared session constants: status labels, colours
  components/               ConnectionCard, ListingRow, StatusPill,
                            CloneCheckList, TabBar, RemoteBrowserView
  screens/                  Auth (Relist sign-in), Listings, Detail (clone
                            preview), Progress (recreate timeline),
                            History, Connect (live Facebook login view)
  App.tsx                   Shell: auth gate, header, view switching,
                            bottom tab bar
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

## Seed data (stand-in until the first sync)

`src/data/preview-seed.json` and `public/listings/` are **stand-ins**
shown only until the person's first listings sync, and labelled as
samples on screen. From Sprint 2 the backend session reads each listing
from its Facebook selling list, edit view, and listing page, and
downloads all of its photos to the archive — the two listings marked
with `photoCount` / `category` / `delivery` in the seed are the ones
verified live on 2026-11-09, and they are also the two fixture cases the
Sprint 2 extraction tests are built from.

## Deployment boundary (not deployed or live-verified)

Do not deploy the static UI separately and assume CORS is sufficient. The
browser API uses same-origin paths/cookies and remote control uses WebSockets;
an unrelated frontend/backend origin has cookie/SameSite and HTTPS/WSS
constraints. A deployment, if later approved, should use one HTTPS origin
with a reverse proxy routing `/api` and WebSocket traffic to a private backend.
Keep the backend and Vite/Vitest services off public interfaces. Use private
TLS/access networking, dedicated unprivileged runtime, private data/profile
directories and permissions, and tested encrypted backups with a documented
retention/restore policy. A host operator can access browser profile/session
material; filesystem permissions do not remove that trust boundary.

1. For offline local UI builds, run `npm ci` then `npm run build`; output is
   written to `dist/`.
2. No deployment is configured or verified by this project. Choose and test
   a same-origin HTTPS reverse proxy/private-network design before exposing
   authentication or browser-control routes.
3. PWA metadata exists, but there is no verified offline application/data
   mode. Sensitive API/browser content must not be cached by a service worker.
