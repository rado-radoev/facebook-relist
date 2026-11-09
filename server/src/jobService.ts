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

import { randomUUID } from "node:crypto";
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

export interface JobServiceOptions {
  /** Captured onto each job at creation (server config: RELIST_DRY_RUN). */
  dryRun: boolean;
  pollIntervalMs: number;
  stuckAfterMs: number;
  now?: () => Date;
  /** Jitter source for poll scheduling (0..1), injectable for tests. */
  random?: () => number;
}

const MAX_STEPS_PER_RUN = 16;

export class JobService {
  private readonly now: () => Date;
  private readonly random: () => number;
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

  async createJob(userId: string, listingId: string): Promise<RecreateJob> {
    const synced = this.store.getListings(userId);
    const listing = synced.find((entry) => entry.id === listingId);
    if (!listing) {
      throw new ListingNotSyncedError(listingId);
    }
    const clone = this.store.getClone(userId, listingId);
    if (!clone || !clone.recovery) {
      throw new CloneNotFoundError(listingId);
    }
    const resolved = resolveJobData(clone);
    if (!resolved.data) {
      throw new JobIncompleteError(resolved.missing);
    }
    const active = this.store.findActiveJob(userId);
    if (active) {
      throw new ActiveJobExistsError(active.id);
    }

    const data = resolved.data;
    const at = this.now().toISOString();
    const job: RecreateJob = {
      id: randomUUID(),
      userId,
      listingId,
      listingTitle: data.title,
      oldListingUrl: listing.url,
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
      const progressed = await this.stepOnce(job);
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
      if (job.status === "deleting") {
        return await this.stepVerify(job);
      }
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown driver error";
      this.audit(job, "driver_error", message);
      await this.persist(job);
      return false;
    }
  }

  // -- Steps ----------------------------------------------------------------

  private async stepCreate(job: RecreateJob): Promise<boolean> {
    const fp = fingerprintOf(job.data, job.listingId);

    // Duplicate guard — runs before EVERY create attempt, so a retry
    // after a crash (job persisted in "creating") finds the copy the
    // first attempt may already have posted instead of duplicating it.
    const duplicate = await this.driver.findPossibleDuplicate(job.userId, fp);
    if (duplicate) {
      job.newListingId = duplicate.id;
      job.newListingUrl = duplicate.url;
      this.audit(
        job,
        "duplicate_adopted",
        `A listing that looks like this copy already exists (${duplicate.url}) — adopting it instead of creating a duplicate.`,
      );
      this.startWatch(job);
      await this.persist(job);
      return true;
    }

    // Persist "creating" BEFORE driving the browser: if the server dies
    // mid-create, the resumed job re-runs the duplicate guard above.
    job.status = "creating";
    await this.persist(job);

    const archiveDir = archiveDirFor(this.dataDir, job.userId, job.listingId);
    const photoPaths = job.data.photoFiles.map((fileName) =>
      path.join(archiveDir, path.basename(fileName)),
    );
    const videoPath = job.data.videoFile
      ? path.join(archiveDir, path.basename(job.data.videoFile))
      : null;

    const outcome = await this.driver.createListing(job.userId, job.data, photoPaths, videoPath, {
      dryRun: job.dryRun,
    });

    if (outcome.kind === "dry_run") {
      this.audit(
        job,
        "create_dry_run",
        `Dry run: the create form was filled for "${job.data.title}" (${job.data.photoFiles.length} photo(s)) and stopped before posting. Nothing was created.`,
      );
      this.startWatch(job);
      await this.persist(job);
      return true;
    }
    if (outcome.kind === "unknown") {
      job.status = "failed";
      job.error = outcome.reason;
      this.audit(job, "create_unknown", outcome.reason);
      await this.persist(job);
      return true;
    }

    job.newListingId = outcome.listingId;
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

    if (availability === "available") {
      job.status = "available";
      job.availableAt = now.toISOString();
      job.nextPollAt = null;
      this.audit(job, "poll_available", `The new listing is live: ${job.newListingUrl}`);
      await this.persist(job);
      return true;
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
    this.audit(
      job,
      "poll_in_review",
      `Still in review (check #${job.pollCount}); next check in about ${Math.round(this.options.pollIntervalMs / 60000)} minutes.`,
    );
    await this.persist(job);
    return false;
  }

  private async stepDelete(job: RecreateJob): Promise<boolean> {
    if (job.dryRun) {
      // A dry-run job NEVER performs a real delete. The driver's own
      // dry-run walk opens the delete flow and stops before confirming.
      await this.driver.deleteListing(job.userId, job.listingId, { dryRun: true });
      this.audit(
        job,
        "delete_dry_run",
        "Dry run: the delete flow for the old listing was opened and stopped before confirming. Nothing was deleted.",
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
      this.audit(
        job,
        "delete_deferred",
        "The new listing's state could not be confirmed at delete time — the old listing was NOT deleted; will re-check.",
      );
      await this.persist(job);
      return false;
    }

    // Target check: the old listing must still be the person's own
    // listed item. If it is already gone, there is nothing to delete —
    // proceed to verification instead of failing.
    const stillListed = await this.driver.listingStillListed(job.userId, job.listingId);
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

    const outcome = await this.driver.deleteListing(job.userId, job.listingId, { dryRun: false });
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
      job.status = "failed";
      job.error = "Delete refused: the driver returned a dry-run result for a real job.";
      this.audit(job, "delete_refused", job.error);
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
    if (result.oldGone && result.newListed) {
      this.audit(
        job,
        "verified",
        `Verified: the old listing is gone and the new one is listed (${job.newListingUrl}).`,
      );
      await this.finishJob(job);
      return true;
    }
    const problems: string[] = [];
    if (!result.oldGone) {
      problems.push("the old listing still appears in the selling list");
    }
    if (!result.newListed) {
      problems.push("the new listing does not appear in the selling list");
    }
    job.status = "failed";
    job.error = `Verification failed: ${problems.join(" and ")}. Check Facebook before doing anything else.`;
    this.audit(job, "verify_failed", job.error);
    await this.persist(job);
    return true;
  }

  // -- Helpers --------------------------------------------------------------

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
