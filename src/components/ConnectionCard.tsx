import type { CurrentUser } from "../types";

interface Props {
  user: CurrentUser;
  onConnect: () => void;
}

export default function ConnectionCard({ user, onConnect }: Props) {
  if (user.facebookStatus === "none") {
    return (
      <section className="connection-card">
        <div className="connection-avatar connection-avatar-muted" aria-hidden="true">
          {user.initials}
        </div>
        <div className="connection-text">
          <p className="connection-title">Connect your Facebook account</p>
          <p className="connection-sub">Log in on Facebook's own page — Relist never sees your password</p>
        </div>
        <button type="button" className="connect-button" onClick={onConnect}>
          Connect Facebook
        </button>
      </section>
    );
  }

  if (user.facebookStatus === "expired") {
    return (
      <section className="connection-card">
        <div className="connection-avatar" aria-hidden="true">
          {user.initials}
        </div>
        <div className="connection-text">
          <p className="connection-title">Facebook session expired</p>
          <p className="connection-sub">Log in again on Facebook's page to reconnect</p>
        </div>
        <button type="button" className="connect-button" onClick={onConnect}>
          Reconnect
        </button>
      </section>
    );
  }

  return (
    <section className="connection-card">
      <div className="connection-avatar" aria-hidden="true">
        {user.initials}
      </div>
      <div className="connection-text">
        <p className="connection-title">Connected as {user.displayName}</p>
        <p className="connection-sub">Session stored on this device</p>
      </div>
      <button type="button" className="disconnect-button" disabled title="Preview only">
        Disconnect
      </button>
    </section>
  );
}
