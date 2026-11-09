// Sprint 3: the recreate job — shared shapes and status vocabulary.
//
// A job walks the requirements §3 order and nothing else:
// create the new listing FIRST, watch it through Facebook's review, and
// delete the old listing ONLY once the new one is confirmed Available.
// The state machine is persisted in the backend store after every step,
// so a server restart resumes a job wherever it stopped.
//
// Dry-run is a property of the JOB (captured from server config when the
// job is created): a dry-run job walks the same states, but the driver
// stops before the create submit and before the delete confirm, and no
// history entry is recorded — nothing on Facebook changes.

import type { DeliveryInfo } from "./cloneTypes.js";

/** Job statuses, in walk order. Terminal: done / stuck / failed. */
export const JOB_STATUSES = [
  "queued",
  "creating",
  "in_review",
  "available",
  "deleting",
  "done",
  "stuck",
  "failed",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "done",
  "stuck",
  "failed",
]);

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

/**
 * The fully-resolved listing data a job will create: the recovered clone
 * with the person's picks (for fields Facebook could not recover) and
 * edits (changes to recovered fields) already applied. A job can only be
 * created when every field here is present — the server enforces that,
 * not just the UI (see resolveJobData in jobLogic.ts).
 */
export interface CloneJobData {
  title: string;
  /** Display price, e.g. "$30". */
  price: string;
  description: string;
  category: string;
  condition: string;
  attributes: Record<string, string>;
  location: string;
  delivery: DeliveryInfo;
  /** Archive file names to upload, in original order. */
  photoFiles: string[];
  /** Source photo URLs parallel to photoFiles (fingerprint input). */
  photoUrls: string[];
  /** Archive file name of the listing's video, when it was recovered. */
  videoFile: string | null;
}

export interface AuditEvent {
  at: string;
  action: string;
  detail: string;
}

export interface RecreateJob {
  id: string;
  /** Owning Relist user. Internal only — never sent to the client. */
  userId: string;
  /** The OLD listing this job recreates. */
  listingId: string;
  listingTitle: string;
  /** The synced listing's public URL, for history/reporting. */
  oldListingUrl: string;
  status: JobStatus;
  /** True when this job can never write to Facebook (see header). */
  dryRun: boolean;
  data: CloneJobData;
  /** Fields whose value came from the person's pick or edit, not from
   *  Facebook recovery — recorded so history can say what was supplied. */
  suppliedFields: string[];
  /** Duplicate-guard fingerprint: title + price + first photo. */
  fingerprint: string;
  newListingId: string | null;
  newListingUrl: string | null;
  createdAt: string;
  updatedAt: string;
  /** When the new listing entered review (watch window start). */
  inReviewSince: string | null;
  /** When the watch step next polls Facebook. */
  nextPollAt: string | null;
  lastPolledAt: string | null;
  pollCount: number;
  availableAt: string | null;
  completedAt: string | null;
  /** Human-readable failure/stuck explanation, when terminal-bad. */
  error: string | null;
  /** Set on stuck jobs: what the person needs to know. The old listing
   *  is NOT deleted for a stuck job. */
  alert: string | null;
  historyRecorded: boolean;
  audit: AuditEvent[];
}

/** One completed (real, non-dry-run) recreate, for the History screen. */
export interface JobHistoryEntry {
  id: string;
  jobId: string;
  title: string;
  oldListingId: string;
  oldListingUrl: string;
  newListingId: string;
  newListingUrl: string;
  completedAt: string;
  /** Fields the person supplied or edited (vs. recovered verbatim). */
  suppliedFields: string[];
}

/** The job shape the API returns: everything except the owner id. */
export type PublicJob = Omit<RecreateJob, "userId">;

export function toPublicJob(job: RecreateJob): PublicJob {
  const { userId: _userId, ...rest } = job;
  return rest;
}
