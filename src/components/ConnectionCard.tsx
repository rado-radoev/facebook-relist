import type { Account } from "../types";
import { firstName } from "../lib/accounts";

interface Props {
  account: Account;
  onConnect: () => void;
}

export default function ConnectionCard({ account, onConnect }: Props) {
  if (account.sessionStatus === "none") {
    return (
      <section className="connection-card">
        <div className="connection-avatar connection-avatar-muted" aria-hidden="true">
          {account.initials}
        </div>
        <div className="connection-text">
          <p className="connection-title">No Facebook account connected yet</p>
          <p className="connection-sub">{firstName(account.displayName)} can connect their own Facebook login</p>
        </div>
        <button type="button" className="connect-button" onClick={onConnect}>
          Connect Facebook
        </button>
      </section>
    );
  }

  if (account.sessionStatus === "expired") {
    return (
      <section className="connection-card">
        <div className="connection-avatar" aria-hidden="true">
          {account.initials}
        </div>
        <div className="connection-text">
          <p className="connection-title">Session expired for {account.displayName}</p>
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
        {account.initials}
      </div>
      <div className="connection-text">
        <p className="connection-title">Connected as {account.displayName}</p>
        <p className="connection-sub">Session stored on this device</p>
      </div>
      <button type="button" className="disconnect-button" disabled title="Preview only">
        Disconnect
      </button>
    </section>
  );
}
