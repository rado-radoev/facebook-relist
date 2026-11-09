import { useEffect, useState } from "react";
import type { Listing } from "../types";

const STEPS = [
  "Downloading photos",
  "Creating new listing",
  "In review — Facebook checks it",
  "New listing live",
  "Old listing deleted",
  "Done",
] as const;

const STEP_MS = 1300;

interface Props {
  listing: Listing;
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

export default function ProgressScreen({ listing, onDone }: Props) {
  // `current` is the step in progress; STEPS.length means all finished.
  const [current, setCurrent] = useState(0);
  const finished = current >= STEPS.length;

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
      <p className="screen-subtitle">{listing.title.replace(/\s+/g, " ").trim()}</p>

      <ol className="step-list">
        {STEPS.map((label, index) => (
          <li key={label} className={stepState(index, current)}>
            <span className="step-icon" aria-hidden="true">
              {stepIcon(index, current)}
            </span>
            <span>{label}</span>
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
