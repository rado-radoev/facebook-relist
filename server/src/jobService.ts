// Sprint 3: the recreate job service — a persistent state machine that
// walks the requirements §3 order and enforces its safeguards:
//
//   queued → creating → in_review → available → deleting → done
//                                                    ↘ stuck / failed
//
// Safeguards, all enforced HERE (server-side, never just in the UI):
//  - A job cannot be created from an incomplete clone check: every
//    field must be recovered or supplied by the person's pick/edit.
//  - One active job per user (the per-user job lock).
//  - Before any create — including a retry after a crash — the person's
//    selling list is checked for a copy the job may already have made
//    (duplicate guard); a found copy is adopted, never duplicated.
//  - State is persisted BEFORE each browser action, so a server restart
//    resumes the job at a safe point in every status.
//  - The delete step re-verifies, fresh, at delete time: the new listing
//    must be Available NOW, its id must differ from the old listing's,
//    and the old listing must still be the person's own listed item.
//  - A dry-run job can never write: create stops before submit, delete
//    stops before confirm, no history is recorded.
//  - Review stuck > 48h → stuck, alert set, old listing NOT deleted.
//  - Every action lands in the job's audit log with a timestamp.

import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Store } from "./store.js";
import type { MarketplaceDriver } from "./facebookDriver.js";
import {
  fingerprintOf,
  fingerprintString,
  resolveJobData,
} from "./jobLogic.js";
import {
  isTerminalJobStatus,
  type JobHistoryEntry,
  type RecreateJob,
} from "./jobTypes.js";
import { archiveDirFor } from "./recovery.js";
import { ListingNotSyncedError } from "./scrapeService.js";

export class CloneNotFoundError extends Error {
  constructor(listingId: string) {
    super(`No clone check has been run for listing ${listingId}`);
    this.name = "CloneNotFoundError";
  }
}

export class JobIncompleteError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`The clone check is incomplete — still missing: ${missing.join(", ")}`);
    this.name = "JobIncompleteError";
    this.missing = missing;
  }
}

export class ActiveJobExistsError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super("Another recreate job is already running for this account");
    this.name = "ActiveJobExistsError";
    this.jobId = jobId;
  }
}

export class CloneChangedError extends Error {
  constructor() {
    super("The clone check changed after acknowledgement; save the current version before recreating.");
    this.name = "CloneChangedError";
  }
}

export interface JobServiceOptions {
  /** Captured onto each job at creation (server config: RELIST_DRY_RUN). */
  dryRun: boolean;
  pollIntervalMs: number;
  stuckAfterMs: number;
  now?: () => Date;
  /** Jitter source for poll scheduling (0..1), injectable for tests. */
  random?: () => number;
  /** Non-reentrant per-user coordinator; acquire once per whole job step. */
  withUserOperation?: <T>(userId: string, operation: () => Promise<T>) => Promise<T>;
}

const MAX_STEPS_PER_RUN = 16;

async function hashApprovedMedia(
  dataDir: string,
  userId: string,
  listingId: string,
  data: RecreateJob["data"],
): Promise<{ photos: string[]; video: string | null }> {
  const archiveDir = path.resolve(archiveDirFor(dataDir, userId, listingId));
  const resolvedArchiveDir = await realpath(archiveDir);
  const hashFile = async (fileName: string): Promise<string> => {
    if (!fileName || path.basename(fileName) !== fileName) {
      throw new Error("Media filename is not a safe archive-local name");
    }
    const candidate = path.resolve(resolvedArchiveDir, fileName);
    const actualPath = await realpath(candidate);
    if (!actualPath.startsWith(`${resolvedArchiveDir}${path.sep}`)) {
      throw new Error("Media path escaped the listing archive");
    }
    const bytes = await readFile(actualPath);
    return createHash("sha256").update(bytes).digest("hex");
  };
  const photos: string[] = [];
  for (const fileName of data.photoFiles) {
    photos.push(await hashFile(fileName));
  }
  const video = data.videoFile ? await hashFile(data.videoFile) : null;
  return { photos, video };
}

function approvedPayloadHash(
  data: RecreateJob["data"],
  mediaHashes: RecreateJob["mediaHashes"],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ data, mediaHashes }))
    .digest("hex");
}

export class JobService {
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly createTails = new Map<string, Promise<void>>();
  private readonly inFlightCreates = new Map<string, Promise<RecreateJob>>();
  /** Jobs currently being advanced by this service instance. A second
   *  processJob call for the same job JOINS the in-flight run instead
   *  of driving the same job twice concurrently (the route's background
   *  kick and the runner sweep can overlap). */
  private readonly inFlight = new Map<string, Promise<RecreateJob | undefined>>();

  constructor(
    private readonly store: Store,
    private readonly driver: MarketplaceDriver,
    private readonly dataDir: string,
    private readonly options: JobServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
  }

  // -- Creation -----------------------------------------------------------

  async createJob(userId: string, listingId: string, expectedRevision?: number): Promise<RecreateJob> {
    const key = `${userId}:${listingId}`;
    const existing = this.inFlightCreates.get(key);
    if (existing) {
      return existing;
    }
    const previous = this.createTails.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => lock);
    this.createTails.set(userId, tail);
    const run = (async () => {
      await previous;
      try {
        const create = () => this.createJobOnce(userId, listingId, expectedRevision);
        return this.options.withUserOperation
          ? await this.options.withUserOperation(userId, create)
          : await create();
      } finally {
        release();
      }
    })();
    this.inFlightCreates.set(key, run);
    try {
      return await run;
    } finally {
      this.inFlightCreates.delete(key);
      if (this.createTails.get(userId) === tail) {
        this.createTails.delete(userId);
      }
    }
  }

  private async createJobOnce(userId: string, listingId: string, expectedRevision?: number): Promise<RecreateJob> {
    const existingForListing = this.store.listJobs(userId).find((entry) => entry.listingId === listingId);
    if (existingForListing) {
      return existingForListing;
    }
    const synced = this.store.getListings(userId);
    const listing = synced.find((entry) => entry.id === listingId);
    if (!listing) {
      throw new ListingNotSyncedError(listingId);
    }
    const clone = this.store.getClone(userId, listingId);
    if (!clone || !clone.recovery) {
      throw new CloneNotFoundError(listingId);
    }
    if (expectedRevision !== undefined && expectedRevision !== (clone.revision ?? 0)) {
      throw new CloneChangedError();
    }
    if (clone.recovery.listingId !== listingId) {
      throw new JobIncompleteError(["clone_listing_identity"]);
    }
    const resolved = resolveJobData(clone);
    if (!resolved.data) {
      throw new JobIncompleteError(resolved.missing);
    }
    const active = this.store.findActiveJob(userId);
    if (active) {
      throw new ActiveJobExistsError(active.id);
    }

    const data = structuredClone(resolved.data);
    let mediaHashes: { photos: string[]; video: string | null };
    try {
      mediaHashes = await hashApprovedMedia(this.dataDir, userId, listingId, data);
    } catch {
      throw new JobIncompleteError(["photos", ...(data.videoFile ? ["video"] : [])]);
    }
    const approvedPayloadDigest = approvedPayloadHash(data, mediaHashes);
    const at = this.now().toISOString();
    const job: RecreateJob = {
      id: randomUUID(),
      userId,
      listingId,
      listingTitle: data.title,
      oldListingUrl: listing.url,
      originalListing: {
        id: listing.id,
        title: listing.title,
        price: listing.price,
        status: listing.status,
        photoUrl: listing.photoUrl,
        url: listing.url,
      },
      approvedPayloadHash: approvedPayloadDigest,
      mediaHashes,
      status: "queued",
      dryRun: this.options.dryRun,
      data,
      suppliedFields: resolved.suppliedFields,
      fingerprint: fingerprintString(fingerprintOf(data, listingId)),
      newListingId: null,
      newListingUrl: null,
      createdAt: at,
      updatedAt: at,
      inReviewSince: null,
      nextPollAt: null,
      lastPolledAt: null,
      pollCount: 0,
      availableAt: null,
      completedAt: null,
      error: null,
      alert: null,
      historyRecorded: false,
      audit: [],
    };
    this.audit(job, "job_created", `Recreate job created for "${data.title}".`);
    if (job.dryRun) {
      this.audit(
        job,
        "dry_run",
        "Dry-run job: it will walk every step but stop before posting or deleting anything.",
      );
    }
    if (data.videoFile === null && clone.recovery.video.present) {
      this.audit(
        job,
        "video_not_carried",
        "The listing has a video that could not be downloaded in the clone check, so the copy will not include it.",
      );
    }
    await this.store.createJob(job);
    return job;
  }

  getJob(userId: string, jobId: string): RecreateJob | undefined {
    return this.store.getJob(userId, jobId);
  }

  listJobs(userId: string): RecreateJob[] {
    return this.store.listJobs(userId);
  }

  listHistory(userId: string): JobHistoryEntry[] {
    return this.store.listHistory(userId);
  }

  // -- Runner ---------------------------------------------------------------

  /** Advance one job as far as it can go right now. Safe to call any
   *  time: terminal jobs and not-yet-due polls are no-ops, and a call
   *  that overlaps an in-flight run of the same job joins that run. */
  async processJob(userId: string, jobId: string): Promise<RecreateJob | undefined> {
    const existing = this.inFlight.get(jobId);
    if (existing) {
      return existing;
    }
    const run = this.runJob(userId, jobId);
    this.inFlight.set(jobId, run);
    try {
      return await run;
    } finally {
      this.inFlight.delete(jobId);
    }
  }

  private async runJob(userId: string, jobId: string): Promise<RecreateJob | undefined> {
    const job = this.store.getJob(userId, jobId);
    if (!job || isTerminalJobStatus(job.status)) {
      return job;
    }
    for (let step = 0; step < MAX_STEPS_PER_RUN; step += 1) {
      const operation = () => this.stepOnce(job);
      const progressed = this.options.withUserOperation
        ? await this.options.withUserOperation(job.userId, operation)
        : await operation();
      if (!progressed) {
        break;
      }
      if (isTerminalJobStatus(job.status)) {
        break;
      }
    }
    return job;
  }

  /** The restart/resume sweep: advance every active job (any user) as
   *  far as it can go. Each job acts only inside its owner's session. */
  async processDueJobs(): Promise<void> {
    const active = this.store.listAllActiveJobs();
    for (const job of active) {
      try {
        await this.processJob(job.userId, job.id);
      } catch {
        // One job's failure must not stop the sweep; the job's own
        // audit log carries what happened.
      }
    }
  }

  /** One state-machine step. Returns true when the job advanced. Any
   *  driver error is audited and stops this run with state intact, so a
   *  later sweep resumes from the persisted status. */
  private async stepOnce(job: RecreateJob): Promise<boolean> {
    try {
      if (job.status === "queued" || job.status === "creating") {
        return await this.stepCreate(job);
      }
      if (job.status === "in_review") {
        return await this.stepWatch(job);
      }
      if (job.status === "available") {
        return await this.stepDelete(job);
      }
      if (job.status === "delete_intent") {
        this.requireInput(
          job,
          "delete_reconciliation_required",
          "The process stopped after deletion intent was persisted. Check the old listing manually; automatic deletion retry is disabled.",
        );
        await this.persist(job);
        return true;
      }
      if (job.status === "deleting") {
        return await this.stepVerify(job);
      }
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown driver error";
      if (
        job.status === "in_review" &&
        job.inReviewSince &&
        this.now().getTime() - Date.parse(job.inReviewSince) > this.options.stuckAfterMs
      ) {
        job.status = "stuck";
        job.alert =
          "Facebook has kept the new listing in review for over 48 hours. " +
          "The old listing is still up and has NOT been deleted. Check Facebook, then recreate again if needed.";
        this.audit(job, "stuck", `${job.alert} The latest availability read failed: ${message}`);
      } else if (job.status === "creating") {
        this.requireInput(
          job,
          "create_reconciliation_required",
          `The create operation failed with an uncertain outcome: ${message} Check Facebook manually before any retry.`,
        );
      } else if (job.status === "delete_intent") {
        this.requireInput(
          job,
          "delete_reconciliation_required",
          `The delete operation failed with an uncertain outcome: ${message} Check the original listing manually before any retry.`,
        );
      } else {
        this.audit(job, "driver_error", message);
      }
      await this.persist(job);
      return false;
    }
  }

  // -- Steps ----------------------------------------------------------------

  private async stepCreate(job: RecreateJob): Promise<boolean> {
    if (job.status === "creating") {
      this.requireInput(
        job,
        "create_reconciliation_required",
        "The process stopped after a create attempt began. Check Facebook manually; automatic retry and duplicate adoption are disabled.",
      );
      return true;
    }
    if (await this.payloadChanged(job)) {
      this.requireInput(
        job,
        "approved_payload_changed",
        "The approved clone payload or archived media changed after job creation. Run clone recovery and approve it again.",
      );
      return true;
    }
    const fp = fingerprintOf(job.data, job.listingId);

    // Duplicate guard — runs before EVERY create attempt, so a retry
    // after a crash (job persisted in "creating") finds the copy the
    // first attempt may already have posted instead of duplicating it.
    const duplicate = await this.driver.findPossibleDuplicate(job.userId, fp);
    if (duplicate && "kind" in duplicate && duplicate.kind === "unknown") {
      this.requireInput(
        job,
        "duplicate_check_reconciliation_required",
        `A complete duplicate check could not be obtained: ${duplicate.reason} Check the selling list before retrying.`,
      );
      await this.persist(job);
      return true;
    }
    if (duplicate && !("kind" in duplicate && duplicate.kind === "unknown")) {
      const candidate = duplicate as import("./cloneTypes.js").SyncedListing;
      this.requireInput(
        job,
        "duplicate_reconciliation_required",
        `A possible matching listing exists (${candidate.url}). Verify its exact ID, seller and complete payload before continuing; it will not be adopted automatically.`,
      );
      return true;
    }

    // Persist "creating" BEFORE driving the browser: if the server dies
    // mid-create, the resumed job re-runs the duplicate guard above.
    job.status = "creating";
    await this.persist(job);

    const archiveDir = archiveDirFor(this.dataDir, job.userId, job.listingId);
    const photoPaths = job.data.photoFiles.map((fileName) => path.join(archiveDir, fileName));
    const videoPath = job.data.videoFile
      ? path.join(archiveDir, job.data.videoFile)
      : null;

    const outcome = await this.driver.createListing(job.userId, job.data, photoPaths, videoPath, {
      dryRun: job.dryRun,
    });

    if (outcome.kind === "dry_run") {
      this.audit(
        job,
        "create_dry_run",
        "Dry run: skipped the browser create flow. Nothing was uploaded, posted, or changed.",
      );
      this.startWatch(job);
      await this.persist(job);
      return true;
    }
    if (outcome.kind === "unknown") {
      job.status = "needs_input";
      const message = `Reconciliation required: creation outcome is unknown: ${outcome.reason} Check Facebook before any manual retry.`;
      job.alert = message;
      job.error = message;
      this.audit(job, "create_reconciliation_required", message);
      await this.persist(job);
      return true;
    }
    if (outcome.kind === "blocked") {
      job.status = "failed";
      job.error = outcome.reason;
      this.audit(job, "create_blocked", outcome.reason);
      await this.persist(job);
      return true;
    }

    const createdId = /^\d+$/.test(outcome.listingId) ? outcome.listingId : null;
    let urlId: string | null = null;
    try {
      const parsed = new URL(outcome.url);
      const match = parsed.pathname.match(/^\/marketplace\/item\/(\d+)\/?$/);
      if (
        parsed.protocol === "https:" &&
        (parsed.hostname === "facebook.com" || parsed.hostname === "www.facebook.com") &&
        !parsed.search &&
        !parsed.hash
      ) {
        urlId = match?.[1] ?? null;
      }
    } catch {
      // An unreadable create URL is an ambiguous side effect.
    }
    if (!createdId || createdId === job.listingId || urlId !== createdId) {
      this.requireInput(
        job,
        "create_reconciliation_required",
        "The create result did not identify a distinct listing with a matching canonical Facebook URL. Check Facebook manually; automatic retry is disabled.",
      );
      await this.persist(job);
      return true;
    }

    job.newListingId = createdId;
    job.newListingUrl = outcome.url;
    this.audit(job, "created", `New listing created: ${outcome.url}`);
    this.startWatch(job);
    await this.persist(job);
    return true;
  }

  private async stepWatch(job: RecreateJob): Promise<boolean> {
    if (job.dryRun) {
      // There is no real new listing to poll in a dry run; record the
      // simulation honestly and move on so the whole flow is walked.
      this.audit(
        job,
        "watch_simulated",
        "Dry run: no new listing exists to poll — simulating an Available result so the remaining steps are walked.",
      );
      job.status = "available";
      job.availableAt = this.now().toISOString();
      await this.persist(job);
      return true;
    }
    if (!job.newListingId) {
      job.status = "failed";
      job.error = "The job is in review but has no new listing id — stopping safely.";
      this.audit(job, "watch_failed", job.error);
      await this.persist(job);
      return true;
    }
    const now = this.now();
    if (job.nextPollAt && now.getTime() < Date.parse(job.nextPollAt)) {
      return false; // Not due yet.
    }

    const availability = await this.driver.checkListing(job.userId, job.newListingId);
    job.lastPolledAt = now.toISOString();
    job.pollCount += 1;

    // Blueprint §5 step 10: "available" on the listing page is not
    // enough — the new listing's own gallery must also verify (photo
    // count + first-photo identity) before the job may enter the
    // "available" state that later authorises deleting the old listing.
    // A verification that comes back unknown is handled exactly like
    // still-in-review below: keep watching, never delete.
    let photoVerificationPendingReason: string | null = null;
    if (availability === "available") {
      const photoCheck = await this.checkPublishedPhotos(job);
      if (photoCheck.state === "verified") {
        job.status = "available";
        job.availableAt = now.toISOString();
        job.nextPollAt = null;
        this.audit(job, "poll_available", `The new listing is live: ${job.newListingUrl}`);
        await this.persist(job);
        return true;
      }
      photoVerificationPendingReason =
        photoCheck.reason ?? "The new listing's photos could not be verified yet.";
    }
    if (availability === "gone") {
      job.status = "failed";
      job.error =
        "The new listing disappeared while it was in review. The old listing has NOT been deleted.";
      this.audit(job, "poll_gone", job.error);
      await this.persist(job);
      return true;
    }

    // Still in review (or unreadable — same safe response: keep watching).
    if (
      job.inReviewSince &&
      now.getTime() - Date.parse(job.inReviewSince) > this.options.stuckAfterMs
    ) {
      job.status = "stuck";
      job.alert =
        "Facebook has kept the new listing in review for over 48 hours. " +
        "The old listing is still up and has NOT been deleted. Check Facebook, then recreate again if needed.";
      this.audit(job, "stuck", job.alert);
      await this.persist(job);
      return true;
    }
    job.nextPollAt = new Date(now.getTime() + this.nextPollDelay()).toISOString();
    if (photoVerificationPendingReason !== null) {
      this.audit(
        job,
        "poll_photo_verification_pending",
        `The new listing is live but photo verification is pending: ${photoVerificationPendingReason} ` +
          `The old listing has NOT been deleted; next check in about ${Math.round(this.options.pollIntervalMs / 60000)} minutes.`,
      );
    } else {
      this.audit(
        job,
        "poll_in_review",
        `Still in review (check #${job.pollCount}); next check in about ${Math.round(this.options.pollIntervalMs / 60000)} minutes.`,
      );
    }
    await this.persist(job);
    return false;
  }

  /** The expected gallery of the new listing, verified by the driver
   *  when it supports it. Drivers without the optional
   *  verifyPublishedListing method (older fakes) skip the extra check —
   *  their "available" read is taken as before. The expected photo count
   *  comes from the job's own clone data; the first photo's stable
   *  identity is derived from the stored clone via the store (parallel
   *  to its photo files, honouring the job's photo selection order). */
  private async checkPublishedPhotos(
    job: RecreateJob,
  ): Promise<{ state: "verified" | "unknown"; reason: string | null }> {
    const verify = this.driver.verifyPublishedListing;
    if (typeof verify !== "function") {
      return { state: "verified", reason: null };
    }
    return verify.call(this.driver, job.userId, job.newListingId as string, {
      photoCount: job.data.photoFiles.length,
      firstPhotoIdentity: this.firstPhotoIdentity(job),
    });
  }

  private firstPhotoIdentity(job: RecreateJob): string | null {
    const firstFile = job.data.photoFiles[0];
    if (!firstFile) {
      return null;
    }
    const photos = this.store.getClone(job.userId, job.listingId)?.recovery?.photos;
    if (!photos || !Array.isArray(photos.files) || !Array.isArray(photos.identities)) {
      return null;
    }
    const index = photos.files.indexOf(firstFile);
    if (index < 0) {
      return null;
    }
    const identity = photos.identities[index];
    return typeof identity === "string" && identity.length > 0 ? identity : null;
  }

  private async stepDelete(job: RecreateJob): Promise<boolean> {
    if (job.dryRun) {
      // A dry-run job NEVER opens a destructive delete flow.
      await this.driver.deleteListing(job.userId, job.listingId, { dryRun: true });
      this.audit(
        job,
        "delete_dry_run",
        "Dry run: skipped opening the destructive delete flow. Nothing was deleted or changed.",
      );
      job.status = "deleting";
      await this.persist(job);
      return true;
    }

    if (!job.newListingId || !job.newListingUrl) {
      job.status = "failed";
      job.error = "Delete refused: the job has no new listing on record.";
      this.audit(job, "delete_refused", job.error);
      await this.persist(job);
      return true;
    }
    if (job.newListingId === job.listingId) {
      job.status = "failed";
      job.error =
        "Delete refused: the new listing id matches the old listing id — Relist will not delete the listing it just created.";
      this.audit(job, "delete_refused", job.error);
      await this.persist(job);
      return true;
    }

    // Fresh re-verification at delete time — the cached "available"
    // state is never trusted for a destructive step.
    const fresh = await this.driver.checkListing(job.userId, job.newListingId);
    if (fresh === "in_review") {
      job.status = "in_review";
      job.nextPollAt = new Date(this.now().getTime() + this.nextPollDelay()).toISOString();
      this.audit(
        job,
        "delete_deferred",
        "The new listing is back in review at delete time — the old listing was NOT deleted; watching again.",
      );
      await this.persist(job);
      return true;
    }
    if (fresh === "gone") {
      job.status = "failed";
      job.error =
        "The new listing is gone at delete time. The old listing has NOT been deleted.";
      this.audit(job, "delete_refused", job.error);
      await this.persist(job);
      return true;
    }
    if (fresh !== "available") {
      this.requireInput(
        job,
        "delete_reconciliation_required",
        "The new listing's state could not be confirmed at delete time — the old listing was NOT deleted. Check the replacement manually; automatic delete retry is disabled.",
      );
      await this.persist(job);
      return true;
    }

    const replacement = await this.driver.verifyNewListing(
      job.userId,
      job.newListingId,
      job.newListingUrl,
      job.approvedPayloadHash,
    );
    if (
      replacement.state !== "verified" ||
      replacement.listingId !== job.newListingId ||
      replacement.sellerMatchesOwner !== true ||
      replacement.payloadHash !== job.approvedPayloadHash
    ) {
      this.requireInput(
        job,
        "replacement_reconciliation_required",
        "The exact replacement listing, seller identity, and approved payload could not all be verified. The original was not deleted; manual reconciliation is required.",
      );
      await this.persist(job);
      return true;
    }

    const originalState = await this.driver.checkOriginalUnchanged(job.userId, job.originalListing);
    if (originalState !== "unchanged") {
      this.requireInput(
        job,
        "original_reconciliation_required",
        originalState === "changed"
          ? "The original listing changed after approval. It was not deleted; review the changes and approve again."
          : "The original listing could not be positively re-read. It was not deleted; manual reconciliation is required.",
      );
      await this.persist(job);
      return true;
    }

    // Target check: the old listing must still be the person's own
    // listed item. If it is already gone, there is nothing to delete —
    // proceed to verification instead of failing.
    const stillListed = await this.driver.listingStillListed(job.userId, job.listingId);
    if (stillListed === "unknown") {
      this.requireInput(
        job,
        "original_listing_reconciliation_required",
        "The original listing presence could not be confirmed. Its state and deletion outcome must be reconciled manually.",
      );
      await this.persist(job);
      return true;
    }
    if (!stillListed) {
      this.audit(
        job,
        "old_already_gone",
        "The old listing no longer appears in the selling list — skipping delete and verifying.",
      );
      job.status = "deleting";
      await this.persist(job);
      return true;
    }

    job.status = "delete_intent";
    this.audit(
      job,
      "delete_intent",
      `Deletion of original listing ${job.listingId} was authorized after fresh replacement checks.`,
    );
    await this.persist(job);

    const outcome = await this.driver.deleteListing(job.userId, job.listingId, { dryRun: false });
    if (outcome.kind === "unknown") {
      this.requireInput(
        job,
        "delete_reconciliation_required",
        `Deletion outcome is unknown: ${outcome.reason} Check the original listing before any retry.`,
      );
      await this.persist(job);
      return true;
    }
    if (outcome.kind === "not_deleted") {
      job.status = "failed";
      job.error =
        `The old listing could not be deleted: ${outcome.reason} ` +
        "The new listing is live; delete the old one from Facebook if it is still there.";
      this.audit(job, "delete_failed", job.error);
      await this.persist(job);
      return true;
    }
    if (outcome.kind !== "deleted") {
      this.requireInput(
        job,
        "delete_reconciliation_required",
        "The delete driver returned no confirmed result. Check the original listing before any retry.",
      );
      await this.persist(job);
      return true;
    }
    this.audit(job, "deleted", `Old listing deleted: ${job.oldListingUrl}`);
    job.status = "deleting";
    await this.persist(job);
    return true;
  }

  private async stepVerify(job: RecreateJob): Promise<boolean> {
    if (job.dryRun) {
      this.audit(
        job,
        "verify_simulated",
        "Dry run: verification simulated — in a real run Relist re-reads the selling list to confirm the old listing is gone and the new one is listed.",
      );
      await this.finishJob(job);
      return true;
    }
    if (!job.newListingId) {
      job.status = "failed";
      job.error = "Verification failed: the job has no new listing on record.";
      this.audit(job, "verify_failed", job.error);
      await this.persist(job);
      return true;
    }
    const result = await this.driver.verifyRecreate(job.userId, job.listingId, job.newListingId);
    if (
      result.complete &&
      result.oldGone &&
      result.newListed &&
      result.newListingId === job.newListingId &&
      result.newSellerId !== null &&
      result.newPayloadHash === job.approvedPayloadHash
    ) {
      this.audit(
        job,
        "verified",
        `Verified: the old listing is gone and the new one is listed (${job.newListingUrl}).`,
      );
      await this.finishJob(job);
      return true;
    }
    const problems: string[] = [];
    if (!result.complete) {
      problems.push("the selling-list read was incomplete");
    } else if (!result.oldGone) {
      problems.push("the old listing still appears in the selling list");
    }
    if (!result.newListed || result.newListingId !== job.newListingId) {
      problems.push("the new listing does not appear in the selling list");
    }
    if (!result.newSellerId) {
      problems.push("the new listing seller could not be verified");
    }
    if (result.newPayloadHash !== job.approvedPayloadHash) {
      problems.push("the new listing payload does not match the approved clone");
    }
    job.status = "failed";
    job.error = `Verification failed: ${problems.join(" and ")}. Check Facebook before doing anything else.`;
    this.audit(job, "verify_failed", job.error);
    await this.persist(job);
    return true;
  }

  // -- Helpers --------------------------------------------------------------

  private async payloadChanged(job: RecreateJob): Promise<boolean> {
    try {
      const currentMedia = await hashApprovedMedia(
        this.dataDir,
        job.userId,
        job.listingId,
        job.data,
      );
      return approvedPayloadHash(job.data, currentMedia) !== job.approvedPayloadHash;
    } catch {
      return true;
    }
  }

  private requireInput(job: RecreateJob, action: string, message: string): void {
    job.status = "needs_input";
    job.alert = message;
    job.error = message;
    this.audit(job, action, message);
  }

  private startWatch(job: RecreateJob): void {
    const at = this.now().toISOString();
    job.status = "in_review";
    job.inReviewSince = at;
    job.nextPollAt = job.dryRun
      ? at
      : new Date(this.now().getTime() + this.nextPollDelay()).toISOString();
  }

  private async finishJob(job: RecreateJob): Promise<void> {
    job.status = "done";
    job.completedAt = this.now().toISOString();
    this.audit(job, "done", `Recreate complete. New listing: ${job.newListingUrl ?? "(dry run)"}`);
    const existingHistory = this.store.listHistory(job.userId).some((entry) => entry.jobId === job.id);
    if (existingHistory) {
      job.historyRecorded = true;
    }
    if (!job.dryRun && !job.historyRecorded && job.newListingId && job.newListingUrl) {
      const entry: JobHistoryEntry = {
        id: randomUUID(),
        jobId: job.id,
        title: job.listingTitle,
        oldListingId: job.listingId,
        oldListingUrl: job.oldListingUrl,
        newListingId: job.newListingId,
        newListingUrl: job.newListingUrl,
        completedAt: job.completedAt,
        suppliedFields: job.suppliedFields,
      };
      await this.store.addHistory(job.userId, entry);
      job.historyRecorded = true;
    }
    await this.persist(job);
  }

  private nextPollDelay(): number {
    const jitterFactor = 0.9 + this.random() * 0.2;
    return Math.round(this.options.pollIntervalMs * jitterFactor);
  }

  private audit(job: RecreateJob, action: string, detail: string): void {
    job.audit.push({ at: this.now().toISOString(), action, detail });
    job.updatedAt = this.now().toISOString();
  }

  private async persist(job: RecreateJob): Promise<void> {
    job.updatedAt = this.now().toISOString();
    await this.store.updateJob(job);
  }
}
