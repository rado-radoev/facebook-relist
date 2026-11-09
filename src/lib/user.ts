// Shared helpers for the signed-in user: Facebook session status labels
// and colours, first names. Components import from here instead of
// hard-coding session strings. The status values mirror the backend's
// facebook session states (server/src/facebookStatus.ts).

import type { SessionStatus } from "../types";

export interface SessionMeta {
  label: string;
  /** Catppuccin Mocha colour used for the session status text/dot. */
  color: string;
}

export const SESSION_META: Record<SessionStatus, SessionMeta> = {
  connected: { label: "Connected", color: "#a6da95" },
  login_in_progress: { label: "Login in progress", color: "#89b4fa" },
  needs_check: { label: "Check your phone", color: "#f9e2af" },
  expired: { label: "Session expired", color: "#f9e2af" },
  not_connected: { label: "Not connected", color: "#a6adc8" },
};

export function firstName(displayName: string): string {
  return displayName.split(" ")[0];
}

export function initialsOf(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  const first = parts[0]?.charAt(0) ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  return (first + last).toUpperCase();
}
