import type { Account } from "../types";
import { SESSION_META } from "../lib/accounts";

interface Props {
  accounts: Account[];
}

export default function SettingsScreen({ accounts }: Props) {
  return (
    <div className="screen">
      <h1 className="screen-title">Settings</h1>

      <section className="card">
        <h2 className="card-title">Household accounts</h2>
        <p className="card-sub">One profile per person — each with their own Facebook login and listings.</p>
        <ul className="account-list">
          {accounts.map((account) => {
            const meta = SESSION_META[account.sessionStatus];
            return (
              <li key={account.id} className="account-list-row">
                <span className="account-chip-avatar" aria-hidden="true">
                  {account.initials}
                </span>
                <span className="account-list-name">{account.displayName}</span>
                <span className="account-list-status" style={{ color: meta.color }}>
                  {meta.label}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="setting-text">Profile PIN: off — optional per person, for anyone who wants a lock on their profile.</p>
      </section>

      <section className="card">
        <h2 className="card-title">Where Relist runs</h2>
        <p className="setting-text">
          Relist runs locally: this app on your phone talks to its own small backend on your home server. Each
          person's Facebook session is stored separately on that server only — the app never stores anyone's
          password.
        </p>
      </section>

      <section className="card">
        <h2 className="card-title">Deployment</h2>
        <p className="setting-text">
          The phone UI can be moved to Vercel later without changes (it is a static Vite build). The backend that
          talks to Facebook stays on your home server.
        </p>
      </section>

      <section className="card">
        <h2 className="card-title">About this preview</h2>
        <p className="setting-text">
          This is a design preview: there is no Facebook connection and no backend. Listings, photos, accounts, and
          progress are stand-ins so you can see and tap through the real flow.
        </p>
      </section>
    </div>
  );
}
