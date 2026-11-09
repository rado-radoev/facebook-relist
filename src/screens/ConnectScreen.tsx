import { useState } from "react";
import type { SessionStatus } from "../types";
import { ApiError, connectFacebook } from "../lib/api";
import RemoteBrowserView from "../components/RemoteBrowserView";

interface Props {
  facebookStatus: SessionStatus;
  onStatusChange: (status: SessionStatus) => void;
  onBack: () => void;
}

const STEPS: string[] = [
  "Tap “Open Facebook login” and Relist opens Facebook's login page in its backend browser, on your home server.",
  "Log in on Facebook's own page — you type into Facebook itself, in the live view below. Relist never sees your password.",
  "Approve the text-message code on your phone if Facebook asks.",
  "When Facebook lets you in, this screen shows Connected and your listings appear — only yours.",
];

export default function ConnectScreen({ facebookStatus, onStatusChange, onBack }: Props) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showRemote = facebookStatus === "login_in_progress" || facebookStatus === "needs_check" || starting;

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

  return (
    <div className="screen">
      <button type="button" className="back-button" onClick={onBack}>
        ← Back
      </button>

      <h1 className="screen-title">Connect Facebook</h1>
      <p className="screen-subtitle">Set up your own Facebook connection on this phone.</p>

      <section className="card">
        <h2 className="card-title">How connecting works</h2>
        <ol className="connect-steps">
          {STEPS.map((step, index) => (
            <li key={step} className="connect-step">
              <span className="connect-step-number" aria-hidden="true">
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </section>

      <p className="safety-note">
        This connects your own account, on your own phone. There is no way to connect or open anyone else's
        account here.
      </p>

      {facebookStatus === "connected" ? (
        <p className="primary-button connected-note">Facebook is connected ✓</p>
      ) : null}

      {facebookStatus !== "connected" && !showRemote ? (
        <button type="button" className="primary-button" onClick={handleStart} disabled={starting}>
          {starting ? "Opening Facebook…" : "Open Facebook login"}
        </button>
      ) : null}

      {error ? <p className="auth-error">{error}</p> : null}

      {facebookStatus !== "connected" && showRemote ? (
        <RemoteBrowserView onStatusChange={onStatusChange} />
      ) : null}

      {facebookStatus === "needs_check" ? (
        <p className="screen-footnote">
          Facebook is showing a security check — finish it in the live view above (or approve the login on
          your phone), and Relist will notice automatically.
        </p>
      ) : null}
    </div>
  );
}
