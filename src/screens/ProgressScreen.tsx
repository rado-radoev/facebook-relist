import { useEffect, useState } from "react";
import type { Listing, RecreateJob } from "../types";
import { fetchJob } from "../lib/api";
import { JOB_STEPS, isTerminalJobStatus, stepIndexForJob } from "../lib/jobStatus";

const STEP_MS = 1300;
const POLL_MS = 3000;

interface Props {
  listing: Listing;
  /** Sprint 3: when set, this screen follows the real backend job.
   *  Without it (seed listings), it runs the labelled timer preview. */
  jobId?: string;
  onDone: () => void;
}

function stepState(index: number, current: number): string {
  if (index < current) {
    return "step step-done";
  }
  if (index === current) {
    return "step step-active";
  }
  return "step";
}

function stepIcon(index: number, current: number): string {
  if (index < current) {
    return "✓";
  }
  if (index === current) {
    return "…";
  }
  return "○";
}

function formatTime(iso: string | null): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function ProgressScreen({ listing, jobId, onDone }: Props) {
  const title = listing.title.replace(/\s+/g, " ").trim();
  if (jobId) {
    return <JobProgress jobId={jobId} title={title} onDone={onDone} />;
  }
  return <SeedProgress title={title} onDone={onDone} />;
}

/** The real recreate job, polled from the backend. The timeline is the
 *  job's actual state — when Facebook keeps the listing in review, this
 *  screen sits on the review step for as long as that takes. */
function JobProgress({ jobId, title, onDone }: { jobId: string; title: string; onDone: () => void }) {
  const [job, setJob] = useState<RecreateJob | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const next = await fetchJob(jobId);
        if (cancelled) {
          return;
        }
        setJob(next);
        setLoadError(null);
        if (!isTerminalJobStatus(next.status)) {
          timer = setTimeout(() => {
            void poll();
          }, POLL_MS);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        setLoadError(error instanceof Error ? error.message : "Could not load the job");
        timer = setTimeout(() => {
          void poll();
        }, POLL_MS);
      }
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [jobId]);

  if (!job) {
    return (
      <div className="screen">
        <h1 className="screen-title">Recreating…</h1>
        <p className="screen-subtitle">{title}</p>
        <p className="empty-note">{loadError ? `Couldn't load the job: ${loadError}` : "Loading the job…"}</p>
      </div>
    );
  }

  const current = stepIndexForJob(job);
  const finished = job.status === "done";
  const stopped = job.status === "failed";
  const stuck = job.status === "stuck";

  let heading = "Recreating…";
  if (finished) {
    heading = "Recreated";
  }
  if (stuck) {
    heading = "Still in review";
  }
  if (stopped) {
    heading = "Recreate stopped";
  }

  return (
    <div className="screen">
      <h1 className="screen-title">{heading}</h1>
      <p className="screen-subtitle">{title}</p>

      {job.dryRun ? (
        <div className="safety-note">
          🧪 Dry run — the backend is walking every step but will NOT post or delete anything on Facebook.
        </div>
      ) : null}

      <ol className="step-list">
        {JOB_STEPS.map((step, index) => (
          <li key={step.id} className={stepState(index, current)}>
            <span className="step-icon" aria-hidden="true">
              {stepIcon(index, current)}
            </span>
            <span>{step.label}</span>
          </li>
        ))}
      </ol>

      {job.status === "in_review" ? (
        <p className="screen-footnote">
          Facebook is reviewing the new listing. Relist checks about every 15 minutes
          {job.pollCount > 0 ? ` (checked ${job.pollCount}× so far)` : ""}
          {job.nextPollAt ? ` — next check ${formatTime(job.nextPollAt)}` : ""}. You can close the app; the
          backend keeps watching.
        </p>
      ) : null}

      {job.alert ? <div className="alert-note">⚠️ {job.alert}</div> : null}
      {job.error ? <div className="alert-note">⚠️ {job.error}</div> : null}

      <div className="safety-note">
        🔒 The old listing is only deleted after the new one is live. If Facebook keeps the new one in review, the
        old one stays up.
      </div>

      {finished ? (
        <div className="done-block">
          <p className="done-text">
            {job.dryRun
              ? "✅ Dry run complete — every step was walked, nothing was posted or deleted."
              : "✅ Recreated. Your new listing is live:"}
          </p>
          {!job.dryRun && job.newListingUrl ? (
            <a className="external-link" href={job.newListingUrl} target="_blank" rel="noreferrer">
              {job.newListingUrl.replace("https://www.", "")} ↗
            </a>
          ) : null}
          <button type="button" className="primary-button" onClick={onDone}>
            Back to listings
          </button>
        </div>
      ) : null}

      {stuck || stopped ? (
        <button type="button" className="primary-button" onClick={onDone}>
          Back to listings
        </button>
      ) : null}
    </div>
  );
}

/** Seed listings have no backend job — the original timer preview,
 *  clearly labelled as a preview. */
function SeedProgress({ title, onDone }: { title: string; onDone: () => void }) {
  const [current, setCurrent] = useState(0);
  const finished = current >= JOB_STEPS.length;

  useEffect(() => {
    if (finished) {
      return;
    }
    const timer = setTimeout(() => {
      setCurrent((value) => value + 1);
    }, STEP_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [current, finished]);

  return (
    <div className="screen">
      <h1 className="screen-title">Recreating…</h1>
      <p className="screen-subtitle">{title}</p>

      <ol className="step-list">
        {JOB_STEPS.map((step, index) => (
          <li key={step.id} className={stepState(index, current)}>
            <span className="step-icon" aria-hidden="true">
              {stepIcon(index, current)}
            </span>
            <span>{step.label}</span>
          </li>
        ))}
      </ol>

      <div className="safety-note">
        🔒 The old listing is only deleted after the new one is live. If Facebook keeps the new one in review, the
        old one stays up.
      </div>

      {finished ? (
        <div className="done-block">
          <p className="done-text">✅ Recreated. Your new listing is live:</p>
          <span className="fake-link">facebook.com/marketplace/item/preview-new-listing</span>
          <button type="button" className="primary-button" onClick={onDone}>
            Back to listings
          </button>
        </div>
      ) : null}

      <p className="screen-footnote">Preview: the steps advance on a timer. Nothing is really posted or deleted.</p>
    </div>
  );
}
