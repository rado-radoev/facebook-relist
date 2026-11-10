// Facebook session states for one Relist account, plus the pure logic that
// derives a state from what the backend browser currently shows. Kept free
// of Playwright/Fastify imports so the state logic is unit-testable alone.
//
//   not_connected      No Facebook session (never connected, or disconnected)
//   login_in_progress  The connect browser is open and login is not finished
//   connected          A live Facebook session (c_user cookie present)
//   needs_check        Facebook is showing a checkpoint / 2FA / approval page
//   expired            Was connected before, but the session cookie is gone
//   verifying          Login may have finished, but the strict §6 Connected
//                      ceremony has not (yet) confirmed it in a fresh context
//   profile_busy       The persistent profile cannot be opened right now
//                      (launch pending or profile closing/locked); this is
//                      NOT "not connected" — it is a transient state that
//                      is never persisted as the stored status

export type FacebookStatus =
  | "not_connected"
  | "login_in_progress"
  | "connected"
  | "needs_check"
  | "expired"
  | "verifying"
  | "profile_busy";

export const FACEBOOK_STATUSES: FacebookStatus[] = [
  "not_connected",
  "login_in_progress",
  "connected",
  "needs_check",
  "expired",
  "verifying",
  "profile_busy",
];

export interface PageSignals {
  /** True when Facebook's c_user session cookie is present. */
  hasUserCookie: boolean;
  /** Current URL of the browser tab. */
  url: string;
  /** The status the account had before this observation. */
  previousStatus: FacebookStatus;
}

const CHECK_MARKERS = ["checkpoint", "two_factor", "two-factor", "confirm_identity", "login/confirm"];

export function urlNeedsCheck(url: string): boolean {
  const lower = url.toLowerCase();
  return CHECK_MARKERS.some((marker) => lower.includes(marker));
}

export function detectFacebookStatus(signals: PageSignals): FacebookStatus {
  if (urlNeedsCheck(signals.url)) {
    return "needs_check";
  }
  if (signals.hasUserCookie) {
    return "connected";
  }
  if (signals.previousStatus === "connected") {
    return "expired";
  }
  if (signals.previousStatus === "not_connected") {
    // Browser was closed while on a plain page and the account never
    // connected: still simply not connected.
    return "not_connected";
  }
  return "login_in_progress";
}
