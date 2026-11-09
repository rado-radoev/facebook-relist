import type { CurrentUser } from "../types";

// The person signed in to Relist on this device. The backend can serve
// other household members too, but always on their own phone, signed in as
// themselves — this app never lists or switches between accounts.
export const currentUser: CurrentUser = {
  id: "radoslav-radoev",
  displayName: "Radoslav Radoev",
  initials: "RR",
  facebookStatus: "connected",
};
