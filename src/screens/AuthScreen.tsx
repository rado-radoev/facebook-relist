// Relist app sign-in. This is the app's own account (hashed on the backend,
// never a Facebook password) — it is what binds this device to one person.

import { useState } from "react";
import { ApiError, login, register } from "../lib/api";
import type { ApiUser } from "../lib/api";

interface Props {
  onSignedIn: (user: ApiUser) => void;
}

type Mode = "login" | "register";

export default function AuthScreen({ onSignedIn }: Props) {
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user =
        mode === "login" ? await login(email, password) : await register(name, email, password);
      onSignedIn(user);
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : "Could not reach the Relist backend";
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <h1 className="screen-title">{mode === "login" ? "Sign in to Relist" : "Create your Relist account"}</h1>
      <p className="screen-subtitle">
        Your own Relist sign-in — this device then only ever shows your own listings. This is not your
        Facebook password.
      </p>

      <form className="card auth-form" onSubmit={handleSubmit}>
        {mode === "register" ? (
          <label className="auth-field">
            <span>Your name</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="name"
              required
            />
          </label>
        ) : null}
        <label className="auth-field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
          />
        </label>
        <label className="auth-field">
          <span>Relist password (8+ characters)</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
            minLength={8}
          />
        </label>
        {error ? <p className="auth-error">{error}</p> : null}
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? "Working…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>

      <button
        type="button"
        className="link-button"
        onClick={() => setMode(mode === "login" ? "register" : "login")}
      >
        {mode === "login" ? "New to Relist? Create an account" : "Already have an account? Sign in"}
      </button>

      <p className="screen-footnote">
        Everyone in the family signs in on their own phone, with their own account. There is no account
        switcher.
      </p>
    </div>
  );
}
