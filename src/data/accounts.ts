import type { Account } from "../types";

// Household accounts: one Relist profile per person, each with its own
// Facebook login and its own backend browser session. In the preview the
// second person is a placeholder who has not connected Facebook yet.
export const accounts: Account[] = [
  {
    id: "radoslav-radoev",
    displayName: "Radoslav Radoev",
    initials: "RR",
    sessionStatus: "connected",
  },
  {
    id: "family-member",
    displayName: "Family member",
    initials: "FM",
    sessionStatus: "none",
  },
];

export const defaultAccount: Account = accounts[0];
