// Shared helpers for the signed-in user: Facebook session status labels
// and colours, first names. Components import from here instead of
// hard-coding session strings.

import type { SessionStatus } from "../types";

export interface SessionMeta {
  label: string;
  /** Catppuccin Mocha colour used for the session status text/dot. */
  color: string;
}

export const SESSION_META: Record<SessionStatus, SessionMeta> = {
  connected: { label: "Connected", color: "#a6da95" },
  expired: { label: "Session expired", color: "#f9e2af" },
  none: { label: "Not connected", color: "#a6adc8" },
};

export function firstName(displayName: string): string {
  return displayName.split(" ")[0];
}
