import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// Register the service worker (public/sw.js). It exists to guarantee
// /api/ responses are never cached; registration failing (unsupported
// browser, non-secure context, dev server quirks) must never break the
// app, so failures are swallowed quietly.
if ("serviceWorker" in navigator) {
  try {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // No service worker — the app works exactly the same without one.
    });
  } catch {
    // Same as above: never let SW registration break startup.
  }
}

const rootElement = document.getElementById("root");

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
