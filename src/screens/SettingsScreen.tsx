export default function SettingsScreen() {
  return (
    <div className="screen">
      <h1 className="screen-title">Settings</h1>

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
          This is a design preview: there is no Facebook connection and no backend. Listings, photos, and progress
          are stand-ins so you can see and tap through the real flow.
        </p>
      </section>
    </div>
  );
}
