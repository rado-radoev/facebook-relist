export default function ConnectionCard() {
  return (
    <section className="connection-card">
      <div className="connection-avatar" aria-hidden="true">
        R
      </div>
      <div className="connection-text">
        <p className="connection-title">Connected as Radoslav Radoev</p>
        <p className="connection-sub">Session stored on this device</p>
      </div>
      <button type="button" className="disconnect-button" disabled title="Preview only">
        Disconnect
      </button>
    </section>
  );
}
