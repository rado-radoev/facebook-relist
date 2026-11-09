import { historyEntries } from "../data/listings";

export default function HistoryScreen() {
  return (
    <div className="screen">
      <h1 className="screen-title">History</h1>
      <p className="screen-subtitle">Listings you have recreated with Relist.</p>

      <div className="listing-list">
        {historyEntries.map((entry) => (
          <article key={entry.id} className="history-card">
            <p className="history-date">{entry.dateLabel}</p>
            <p className="history-title">{entry.title}</p>
            <p className="history-detail">{entry.detail}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
