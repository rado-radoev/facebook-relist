# Relist remediation status — integration checkpoint

This document describes the integrated jobs checkpoint `ff26f30158974c8f64e2158589e0cfed80f0af71` plus documentation edits currently being prepared. It is not a release verdict. The security, extraction, and frontend streams are not yet integrated here; their current worktrees must not be treated as evidence for this checkpoint. No Facebook login, profile, request, create, delete, deployment, or live selector test was performed.

Status meanings: RESOLVED means implemented and evidenced in the integrated code/tests; SUPERSEDED means the original condition no longer exists in this code and a replacement is documented; PARTIAL means a bounded portion is addressed but acceptance remains; BLOCKED means no retained evidence or implementation closes the finding.

## High findings

| Finding | Status | Original finding and integrated evidence / remaining work |
|---|---|---|
| H1 — Facebook credentials transit Relist | PARTIAL | The README now calls remote input a credential relay and records that consent is not technical non-receipt. The architecture still sends typed input through browser/client and server memory. The original owner's absolute password non-receipt requirement remains unresolved; no waiver is claimed. Sensitive diagnostics and transport handling still need integrated verification. |
| H2 — authenticated WebSockets survive logout/expiry and Origin was not enforced | BLOCKED | The jobs checkpoint does not include auth/socket changes. Need current exact-origin enforcement and revocation/expiry while socket remains open, with queued-input execution authorization tests. |
| H3 — concurrent browser operations mix listing data | BLOCKED | The jobs stream supports an optional `withUserOperation` hook, but `app.ts` is not yet wired to a shared `BrowserManager` coordinator. Base sync/recovery and remote frame/input paths have not been integrated/tested against a common lock. |
| H4 — unknown/rejected states normalize as Available | PARTIAL | Jobs now require positive complete selling-list evidence for duplicate/replacement checks and exact recognized availability evidence (`server/src/jobLogic.ts`, `server/src/jobService.ts`, `server/src/facebookDriver.ts`; worker tests include incomplete-list and unknown-state gates). Ordinary sync extraction remains at base behavior; active/review conflicts and live status tokens are not independently verified. |
| H5 — gallery is unscoped/incomplete and video absence is inferred | BLOCKED | No extraction commit is integrated. The retained base collector and fixture contract do not prove listing-scoped native DOM gallery completion, identities, lazy traversal, or video absence. Automatic photo recovery remains unverified. |
| H6 — approval accepts incomplete fields and failed media | PARTIAL | `server/src/jobLogic.ts` and `server/src/jobService.ts` now fail closed on incomplete/failed photo evidence, unknown video, unknown structured delivery/attributes, missing fields, mutated/missing approved media, and pin approved job data/media hashes. Worker RED→GREEN cases are recorded in `jobs-handoff.json`. Still missing: durable versioned frontend approval acknowledgments, editable media upload/add/replace/reorder with immutable ownership, structured edits, and integrated React/API persistence tests. |
| H7 — insecure network/storage defaults | PARTIAL | README documents same-origin HTTPS reverse proxy/private network, private profile/data storage, encrypted backup/restore, and host trust boundaries. Security config and storage hardening commit is pending exact handoff validation and integration. Nothing was deployed or publicly exposed. |

## Medium findings

| Finding | Status | Original finding and integrated evidence / remaining work |
|---|---|---|
| M1 — store writes race and load errors become empty state | BLOCKED | Jobs checkpoint relies on the base store. Security commit `fe0543ceaba3272116204945cbe13421fa213d14` is reported by the user, but its exact handoff is pending; do not consume until verified. Need final full concurrency/restart/fail-closed store tests. |
| M2 — browser launch/disconnect lifecycle races | BLOCKED | Security lifecycle implementation has not been integrated. Must validate deferred launch/close/profile-removal against concurrent ensure/disconnect calls before status changes. |
| M3 — edited/added/reordered media not persisted immutably | BLOCKED | No upload API or integrated immutable media registry exists at the jobs-only checkpoint. Jobs only validates approved archive filenames/hashes; this does not deliver UI media editing. |
| M4 — picks/edits may claim saved despite pending/failure and picked rows cannot be edited | BLOCKED | Frontend stream is not integrated. Versioned acknowledgments, retry/error UI, save races, reload and edit-after-pick need real React/API tests. |
| M5 — delivery/attributes collapse unknown subfields or use stand-in options | PARTIAL | Jobs refuses unknown nullable shipping/meetup/attributes rather than converting them to false/empty. UI/API cannot yet persist explicit structured choices; valid live options remain unverified and shipping support is not established. |
| M6 — failed/partial sync replaces good data and empty sync loses timestamp | BLOCKED | No extraction/store sync commit is integrated. Need positive surface/readiness/completion evidence, atomic last-good update, independently persisted empty-success timestamp across restart, and failure/partial preservation tests. |
| M7 — media downloads lack network/resource/content bounds | BLOCKED | No extraction implementation is integrated. Need offline-injected transport tests for redirects, private/mapped IPs, deadlines, byte caps, response disposal, decoded media validation and generated valid media. |
| M8 — Facebook identity not bound and stale data can survive reconnect | BLOCKED | Not established in jobs checkpoint. Need identity-scoping/invalidation and disconnect/reconnect tests; `c_user` alone is not to be described as complete identity attestation. |
| M9 — async browser failures can escape / queues unbounded | PARTIAL | Jobs contain step errors into durable reconciliation, but this does not establish socket/frame/poller error containment or bounded input. Security stream is pending; test full routes and execution-time revocation. |
| M10 — proxy/certificate escape hatches can be unsafe | PARTIAL | README says proxy/cert bypass settings are sandbox-only and should remain unset, but server enforcement is not integrated yet. HTTPS proxy semantics, TLS validation and refusal of real-account operation with bypass need verification. |
| M11 — demo/history/connection behavior misleads | PARTIAL | Sprint 3 jobs/API are integrated and dry-run smoke passed with an injected driver; dry-run now skips production browser mutation paths and does not open generic Delete (`facebookDriver.ts`, `jobService.ts`). Frontend empty-list/sample separation, history and logout/retry state still await frontend integration and boundary tests. |
| M12 — deployment/PWA claims omit requirements | PARTIAL | README no longer recommends unrelated-origin Vercel deployment and states same-origin HTTPS reverse proxy/private access, PWA offline limitations, and no sensitive caching. Deployment and device installation remain unverified; frontend transport defaults need integrated review. |

## Current verification evidence (jobs-only checkpoint)

- Source handoff: `/home/rado/.hermes/workspaces/relist-hardening/jobs-handoff.json`, source commit `7172fa9bd14cca712f587c7c5927ec05bb3484d0`.
- Integration commit: `ff26f30158974c8f64e2158589e0cfed80f0af71`, a cherry-pick of the source jobs commit.
- `npm ci` at root and `npm ci` in `server/` passed. Root full dependency audit: 1 moderate + 1 high finding (development dependency chain). Server full dependency audit: 3 moderate + 1 high + 2 critical findings in development tooling (Vitest/Vite/esbuild chain); do not expose those development/test servers. Root production-only audit: 0 vulnerabilities.
- `npm run server:test`: 15 files, 155 tests passed.
- `npm run server:typecheck`: passed.
- `npm run build`: TypeScript and Vite production build passed.
- `TMPDIR=/home/rado/.hermes/cache/scratch npx tsx scripts/dry-run-smoke.ts` in `server/`: six injected fake-driver checks passed. This is not live Facebook evidence.
- `git diff --check`: passed on jobs checkpoint before current uncommitted documentation edits.
- Jobs worker handoff preserves focused RED→GREEN evidence for failed photo slots, incomplete selling-list evidence, explicit unknown field picks, truthful dry-run messaging, and review-deadline errors.

## Release gates and unresolved decisions

- Real Facebook create/delete remain hard-disabled in the production driver; `RELIST_DRY_RUN=0`, persisted jobs, request fields, approvals, or UI state cannot waive the gate.
- No live selector, upload, category, shipping, video, seller identity, exact replacement fidelity, gallery completeness or deletion behavior is proven. Live automatic photo recovery is not replaced by manual upload; both require separate evidence.
- The original owner must resolve the absolute password non-receipt requirement. This remote-view architecture is a credential relay through Relist memory; user consent is not technical non-receipt. No silent waiver is made.
- Integrated frontend media upload/add/replace/reorder, explicit empty/not-applicable and structured delivery/location/attribute edits, save/revision acknowledgment, full shared operation coordinator, captured-native-DOM evidence, broad blocked-network browser QA, CI workflow, final dependency audit, full docs cleanup and independent exact-SHA Luna review remain outstanding.

## Addendum — owner-directed reversals (2026-11-09, branch `fix/restore-owner-switches`)

After reviewing this merge, the owner kept the hardening overall but
directed four specific behaviors restored to their pre-merge form
(commit `797b5b4`), because they encode her own rulings for a home-LAN
app rather than oversights:

1. **Default bind + network hosts.** The loopback-only default bind
   (`127.0.0.1`) and the startup gates for non-loopback hosts
   (mandatory `COOKIE_SECURE=1`, https `CORS_ORIGIN`, TLS files) are
   reversed: the default bind is dual-stack `::` again and a LAN /
   wildcard `HOST` boots plainly. TLS remains supported and optional
   when `TLS_CERT_FILE` + `TLS_KEY_FILE` are set (the pair-must-match
   check stays). Why: the owner's PC browser resolves `localhost` to
   IPv6 first (an IPv4-only bind was a proven sign-in failure there),
   and the iPhone-on-Wi-Fi test requires binding a LAN address over
   plain HTTP — the gates made that test impossible. This narrows the
   H7 network-posture finding back to the owner's accepted home-LAN
   posture; the finding's public-exposure concerns stand as documented
   and are addressed by the "never expose beyond the home network"
   rule in the README, not by boot gates.
2. **Loopback origins on any port.** `isAllowedRequestOrigin` again
   accepts the configured origin plus any loopback origin (localhost /
   127.0.0.1 / ::1, any port), matching the CORS policy in
   `corsOrigin.ts`; the same-port / configured-must-be-loopback
   restrictions are removed. Why: the owner's ruling from the original
   fix — local access must not depend on which loopback spelling or
   port the browser happens to use. Non-loopback, non-configured
   origins remain rejected, so the H2 origin-enforcement intent is
   preserved for off-box origins.
3. **The owner's dry-run switch.** `RELIST_DRY_RUN` is again the
   real-writes switch (`dryRun: env.RELIST_DRY_RUN !== "0"`, default
   ON, captured per job at creation), and the driver-level
   `LIVE_MUTATIONS_ENABLED` hard gate is removed — the per-job
   `dryRun` flag is once more the only write gate. This supersedes the
   "Release gates" bullet above ("Real Facebook create/delete remain
   hard-disabled… `RELIST_DRY_RUN=0` … cannot waive the gate"): that
   is no longer true. Why: the switch is the owner's — dry-run stays
   the default, and `=0` is reserved for a supervised first real
   recreate with the owner present. All other job safeguards (missing-
   field refusal, duplicate guard, delete-time re-verification,
   stuck-after-48h) are unchanged.
4. **Sign-out UI.** The "Sign out of Relist" button added to every
   screen is removed again, per the owner's standing ruling that the
   app has no sign-out UI. The backend logout endpoint and its
   session-revocation behavior (H2) are unchanged and still tested at
   the API level.

Everything else in the hardening merge stands as documented above.

**Follow-up (2026-11-09, branch `feature/revision-delivery-edits`):**
the preserved unfinished integration work has landed. Clone saves are
now revision-bound (stale saves and stale job creation return 409 with
the current revision; legacy records without a revision read as 0 and
keep working), and delivery edits are structured (shipping + meetup
options as explicit true / false / null, with unknown never coerced to
false during job resolution). This closes the save/approval half of
H6 and the structured-choice part of M5 as far as the offline code and
tests can prove them; live Facebook verification remains a Sprint 4
item, as before.
