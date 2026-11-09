// Shared recreate-job status constants: the progress timeline steps and
// how a backend job status maps onto them. Components import from here
// instead of hard-coding job status strings.

import type { JobStatus } from "../types";

export interface JobStep {
  id: string;
  label: string;
}

export const JOB_STEPS: JobStep[] = [
  { id: "queued", label: "Queued" },
  { id: "creating", label: "Creating new listing" },
  { id: "in_review", label: "In review — Facebook checks it" },
  { id: "available", label: "New listing live" },
  { id: "deleting", label: "Old listing deleted" },
  { id: "done", label: "Done" },
];

const STEP_INDEX: Record<JobStatus, number> = {
  queued: 0,
  creating: 1,
  in_review: 2,
  available: 3,
  deleting: 4,
  done: JOB_STEPS.length,
  stuck: 2,
  failed: 1,
};

/** Index of the step currently in progress for a job;
 *  JOB_STEPS.length means every step finished. A failed job's status
 *  alone doesn't say where it stopped, so the presence of a new listing
 *  id moves the marker past the create step. */
export function stepIndexForJob(job: { status: JobStatus; newListingId: string | null }): number {
  if (job.status === "failed") {
    return job.newListingId ? 3 : 1;
  }
  return STEP_INDEX[job.status];
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return status === "done" || status === "stuck" || status === "failed";
}
