import type { CurrentUser } from "../types";

interface Props {
  user: CurrentUser;
  onConnect: () => void;
  onDisconnect: () => void;
}

export default function ConnectionCard({ user, onConnect, onDisconnect }: Props) {
  if (user.facebookStatus === "not_connected") {
    return (
      <section className="connection-card">
        <div className="connection-avatar connection-avatar-muted" aria-hidden="true">
          {user.initials}
        </div>
        <div className="connection-text">
          <p className="connection-title">Connect your Facebook account</p>
          <p className="connection-sub">
            Facebook login text is relayed through Relist's frontend and backend memory before reaching its browser; this UI does not intentionally save it.
          </p>
        </div>
        <button type="button" className="connect-button" onClick={onConnect}>
          Connect Facebook
        </button>
      </section>
    );
  }

  if (user.facebookStatus === "login_in_progress") {
    return (
      <section className="connection-card">
        <div className="connection-avatar" aria-hidden="true">
          {user.initials}
        </div>
        <div className="connection-text">
          <p className="connection-title">Facebook login in progress</p>
          <p className="connection-sub">Finish logging in on Facebook's page</p>
        </div>
        <button type="button" className="connect-button" onClick={onConnect}>
          Continue
        </button>
      </section>
    );
  }

  if (user.facebookStatus === "needs_check") {
    return (
      <section className="connection-card">
        <div className="connection-avatar" aria-hidden="true">
          {user.initials}
        </div>
        <div className="connection-text">
          <p className="connection-title">Facebook needs a check</p>
          <p className="connection-sub">Approve the login or enter the code Facebook sent you</p>
        </div>
        <button type="button" className="connect-button" onClick={onConnect}>
          Continue
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
        <p className="connection-sub">Session stored on the home server</p>
      </div>
      <button type="button" className="disconnect-button" onClick={onDisconnect}>
        Disconnect
      </button>
    </section>
  );
}
