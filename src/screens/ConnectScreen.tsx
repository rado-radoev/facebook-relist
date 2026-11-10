import { useState } from "react";
import type { SessionStatus } from "../types";
import { ApiError, connectFacebook } from "../lib/api";
import RemoteBrowserView, { type LoginState } from "../components/RemoteBrowserView";

interface Props {
  facebookStatus: SessionStatus;
  onStatusChange: (status: SessionStatus) => void;
  onBack: () => void;
}

type TwoFactorChoice = "code" | "passkey" | null;

const DISCLOSURE =
  "When you sign in here, your Facebook password passes briefly through this app's memory on your own home server before Facebook receives it — it is never saved or logged, but if that server were compromised at that exact moment, the password could be captured, so use a password you don't reuse anywhere else.";

const PASSKEY_EXPLANATION =
  "That kind of sign-in can't be completed in Relist's browser. In Facebook Settings → Password and security, add a text-message or authenticator code option first, then come back.";

export default function ConnectScreen({ facebookStatus, onStatusChange, onBack }: Props) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<TwoFactorChoice>(null);
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

      <section className="card">
        <h2 className="card-title">After your password, what does Facebook usually ask you for?</h2>
        <div className="check-picker" role="group" aria-label="Two-factor sign-in method">
          <button
            type="button"
            className={`check-chip${choice === "code" ? " check-chip-current" : ""}`}
            aria-pressed={choice === "code"}
            onClick={() => setChoice("code")}
          >
            A code (text message or authenticator app)
          </button>
          <button
            type="button"
            className={`check-chip${choice === "passkey" ? " check-chip-current" : ""}`}
            aria-pressed={choice === "passkey"}
            onClick={() => setChoice("passkey")}
          >
            A security key or passkey
          </button>
        </div>
        {choice === "passkey" ? <p className="blocked-note" style={{ marginTop: 10 }}>{PASSKEY_EXPLANATION}</p> : null}
      </section>

      {choice !== "passkey" ? (
        <button
          type="button"
          className="primary-button"
          onClick={handleStart}
          disabled={starting || choice !== "code"}
        >
          {starting ? "Opening Facebook…" : "Open Facebook login"}
        </button>
      ) : null}

      {error ? <p className="auth-error">{error}</p> : null}
    </div>
  );
}
