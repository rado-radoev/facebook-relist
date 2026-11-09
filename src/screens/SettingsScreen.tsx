import type { CurrentUser } from "../types";
import { SESSION_META } from "../lib/user";

interface Props {
  user: CurrentUser;
}

export default function SettingsScreen({ user }: Props) {
  const meta = SESSION_META[user.facebookStatus];

  return (
    <div className="screen">
      <h1 className="screen-title">Settings</h1>

      <section className="card">
        <h2 className="card-title">Your account</h2>
        <ul className="setting-rows">
          <li className="setting-row">
            <span className="setting-row-label">Signed in as</span>
            <span className="setting-row-value">{user.displayName}</span>
          </li>
          <li className="setting-row">
            <span className="setting-row-label">Facebook</span>
            <span className="setting-row-value" style={{ color: meta.color }}>
              {meta.label}
            </span>
          </li>
          <li className="setting-row">
            <span className="setting-row-label">App lock PIN</span>
            <span className="setting-row-value">Off</span>
          </li>
        </ul>
        <p className="setting-text">App lock PIN: off — optional, protects this phone only.</p>
      </section>

      <section className="card">
        <h2 className="card-title">Family</h2>
        <p className="setting-text">
          Everyone else in the family installs Relist on their own phone and signs in with their own account.
          Nobody can switch into your account — there is no account switcher.
        </p>
      </section>

      <section className="card">
        <h2 className="card-title">Where Relist runs</h2>
        <p className="setting-text">
          Relist runs locally: this app on your phone talks to its own small backend on your home server. Your
          Facebook session is stored on that server only — the app never stores your password.
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
          This is a design preview: there is no Facebook connection and no backend. Listings, photos, identity, and
          progress are stand-ins so you can see and tap through the real flow.
        </p>
      </section>
    </div>
  );
}
