import { useState } from "react";
import type { SessionStatus } from "../types";
import { ApiError, connectFacebook } from "../lib/api";
import RemoteBrowserView, { type LoginState } from "../components/RemoteBrowserView";

interface Props {
  facebookStatus: SessionStatus;
  onStatusChange: (status: SessionStatus) => void;
  onBack: () => void;
}

const DISCLOSURE =
  "When you sign in here, your Facebook password passes briefly through this app's memory on your own home server before Facebook receives it — it is never saved or logged, but if that server were compromised at that exact moment, the password could be captured, so use a password you don't reuse anywhere else.";

export default function ConnectScreen({ facebookStatus, onStatusChange, onBack }: Props) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loginState, setLoginState] = useState<LoginState | null>(null);
  const [connectedName, setConnectedName] = useState<string | undefined>(undefined);

  const showRemote =
    loginState !== "connected" &&
    loginState !== "parked" &&
    loginState !== "ended" &&
    (starting || facebookStatus === "login_in_progress" || facebookStatus === "needs_check");

  async function handleStart() {
    setError(null);
    setStarting(true);
    try {
      const status = await connectFacebook();
      onStatusChange(status);
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : "Could not reach the Relist backend";
      setError(message);
      setStarting(false);
    }
  }

  function handleLoginState(state: LoginState, name?: string) {
    setLoginState(state);
    if (state === "connected") {
      setConnectedName(name);
      onStatusChange("connected");
    }
    if (state === "ended") {
      setStarting(false);
    }
  }

  if (loginState === "connected") {
    return (
      <div className="screen">
        <h1 className="screen-title">
          {connectedName ? `You're in — Connected as ${connectedName}` : "You're in — Connected"}
        </h1>
        <button type="button" className="primary-button" onClick={onBack}>
          Done
        </button>
      </div>
    );
  }

  if (loginState === "parked") {
    return (
      <div className="screen">
        <h1 className="screen-title">
          Facebook is checking this login. Nothing is wrong, and there is nothing for you to do
        </h1>
        <button type="button" className="primary-button" onClick={onBack}>
          Done
        </button>
      </div>
    );
  }

  if (showRemote) {
    return (
      <RemoteBrowserView onStatusChange={onStatusChange} onLoginState={handleLoginState} onExit={onBack} />
    );
  }

  if (facebookStatus === "verifying") {
    // The backend is confirming a session it already holds. There is
    // nothing to log into and no remote view to show yet — just say so.
    return (
      <div className="screen">
        <button type="button" className="back-button" onClick={onBack}>
          ← Back
        </button>
        <h1 className="screen-title">Connect Facebook</h1>
        <p className="empty-note">Verifying your Facebook session…</p>
      </div>
    );
  }

  if (facebookStatus === "connected") {
    // Already connected before this visit (we did not just finish a login
    // here — that path renders the success screen above instead).
    return (
      <div className="screen">
        <button type="button" className="back-button" onClick={onBack}>
          ← Back
        </button>
        <h1 className="screen-title">Connect Facebook</h1>
        <p className="primary-button connected-note">Facebook is connected ✓</p>
      </div>
    );
  }

  return (
    <div className="screen">
      <button type="button" className="back-button" onClick={onBack}>
        ← Back
      </button>

      <h1 className="screen-title">Connect Facebook</h1>
      <p className="screen-subtitle">Set up your own Facebook connection on this phone.</p>

      <p className="safety-note">
        This connects your own account, on your own phone. There is no way to connect or open anyone else's
        account here.
      </p>

      <section className="card">
        <p style={{ margin: 0, lineHeight: 1.5, fontSize: 14 }}>{DISCLOSURE}</p>
      </section>

      <button type="button" className="primary-button" onClick={handleStart} disabled={starting}>
        {starting ? "Opening Facebook…" : "Open Facebook login"}
      </button>

      {error ? <p className="auth-error">{error}</p> : null}
    </div>
  );
}
