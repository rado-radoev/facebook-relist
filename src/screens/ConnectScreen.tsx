interface Props {
  onBack: () => void;
}

const STEPS: string[] = [
  "Open Relist and tap “Add person”.",
  "Log in on Facebook's own page — Relist never sees your password.",
  "Approve the text-message code on your phone.",
  "Your listings appear here — only yours.",
];

export default function ConnectScreen({ onBack }: Props) {
  return (
    <div className="screen">
      <button type="button" className="back-button" onClick={onBack}>
        ← Back
      </button>

      <h1 className="screen-title">Add a person</h1>
      <p className="screen-subtitle">Each person in the household gets their own Relist profile and Facebook login.</p>

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

      <p className="safety-note">Each person sees only their own listings. Nobody in the household can see or recreate anyone else's.</p>

      <button type="button" className="primary-button" disabled title="Preview only">
        Connect Facebook (preview)
      </button>
      <p className="screen-footnote">
        Preview only: this screen explains the flow. In the full app, the button above opens Facebook's own login
        page in the app's backend browser on the home server.
      </p>
    </div>
  );
}
