import { useEffect, useState } from "react";
import type { JobHistoryEntry } from "../types";
import { fetchJobHistory } from "../lib/api";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; entries: JobHistoryEntry[] }
  | { kind: "unreachable" };

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function shortUrl(url: string): string {
  return url.replace("https://www.", "").replace("https://", "");
}

export default function HistoryScreen() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const entries = await fetchJobHistory();
        if (!cancelled) {
          setState({ kind: "loaded", entries });
        }
      } catch {
        if (!cancelled) {
          setState({ kind: "unreachable" });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="screen">
      <h1 className="screen-title">History</h1>
      <p className="screen-subtitle">Listings you have recreated with Relist.</p>

      {state.kind === "loading" ? <p className="empty-note">Loading…</p> : null}

      {state.kind === "loaded" && state.entries.length === 0 ? (
        <p className="empty-note">
          Nothing recreated yet. When a recreate finishes — new listing live, old one deleted — it shows up here.
        </p>
      ) : null}

      {state.kind === "loaded" ? (
        <div className="listing-list">
          {state.entries.map((entry) => (
            <article key={entry.id} className="history-card">
              <p className="history-date">{formatDate(entry.completedAt)}</p>
              <p className="history-title">{entry.title}</p>
              <p className="history-detail">
                Old:{" "}
                <a className="external-link" href={entry.oldListingUrl} target="_blank" rel="noreferrer">
                  {shortUrl(entry.oldListingUrl)} ↗
                </a>{" "}
                → New:{" "}
                <a className="external-link" href={entry.newListingUrl} target="_blank" rel="noreferrer">
                  {shortUrl(entry.newListingUrl)} ↗
                </a>
              </p>
              {entry.suppliedFields.length > 0 ? (
                <p className="history-detail">
                  You supplied or edited: {entry.suppliedFields.join(", ")}.
                </p>
              ) : (
                <p className="history-detail">Recreated exactly as recovered — nothing supplied or edited.</p>
              )}
            </article>
          ))}
        </div>
      ) : null}

      {state.kind === "unreachable" ? (
        <p className="empty-note">
          Couldn't reach the backend, so your real history isn't available. Reconnect and try again.
        </p>
      ) : null}
    </div>
  );
}
