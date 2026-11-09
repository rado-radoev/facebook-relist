// Fixture page snapshots for the extraction/recovery tests.
//
// These are HONEST RECONSTRUCTIONS — not captured Facebook HTML. They are
// rebuilt by hand from the verified spike records in the requirements doc
// (§4-C, live read-only checks on 2026-11-09) and the later listing-page
// condition check, in the PageSnapshot shape the real collector returns:
//
//   selling-list.json          The selling list with both spike listings.
//   hot-wheels-edit.json       Edit form, Step 1: 3 photos, title, $30,
//                              verbatim description, stored category
//                              "Toys & Games", condition EMPTY, and the
//                              Next button disabled (the known quirk that
//                              blocks Step 2 for this listing).
//   hot-wheels-listing.json    Listing page: exactly 3 photos, Details has
//                              NO condition row, and the page carries
//                              Facebook's own "Add info about your item's
//                              condition" prompt — the condition exists
//                              nowhere on Facebook for this listing.
//   switches-edit-step1.json   Edit form, Step 1: 5 photos, "Keyboards &
//                              Keypads", condition "Used - Like New",
//                              attributes Is Wireless / Color / Has
//                              Bluetooth, Next enabled.
//   switches-edit-step2.json   Edit form, Step 2: Location "San Diego",
//                              delivery "Local pickup only", shipping NOT
//                              set up, all three meetup prefs unchecked.
//   switches-listing.json      Listing page: 5 photos + 1 video, Details
//                              rows Condition "Used - like new" (Facebook's
//                              own casing), Color, Is Wireless (Y/N),
//                              Has Bluetooth (Y/N).
//
// Photo/video URLs use the reserved fixture host cdn.fixture.local — they
// are identifiers for the fake downloader in tests, never fetched.

import type { PageSnapshot } from "../snapshot.js";
import hotWheelsEdit from "./hot-wheels-edit.json" with { type: "json" };
import hotWheelsListing from "./hot-wheels-listing.json" with { type: "json" };
import sellingList from "./selling-list.json" with { type: "json" };
import switchesEditStep1 from "./switches-edit-step1.json" with { type: "json" };
import switchesEditStep2 from "./switches-edit-step2.json" with { type: "json" };
import switchesListing from "./switches-listing.json" with { type: "json" };

export const HOT_WHEELS_ID = "2173406210055821";
export const SWITCHES_ID = "1452483746465654";

export const sellingListSnapshot = sellingList as PageSnapshot;
export const hotWheelsEditSnapshot = hotWheelsEdit as PageSnapshot;
export const hotWheelsListingSnapshot = hotWheelsListing as PageSnapshot;
export const switchesEditStep1Snapshot = switchesEditStep1 as PageSnapshot;
export const switchesEditStep2Snapshot = switchesEditStep2 as PageSnapshot;
export const switchesListingSnapshot = switchesListing as PageSnapshot;

/** Snapshot lookup keyed by the URL the fake browser is "on". */
export function fixtureSnapshotForUrl(url: string): PageSnapshot | null {
  if (url.includes("/marketplace/you/selling")) {
    return sellingListSnapshot;
  }
  if (url.includes(`/marketplace/edit/${HOT_WHEELS_ID}`)) {
    return hotWheelsEditSnapshot;
  }
  if (url.includes(`/marketplace/edit/${SWITCHES_ID}`)) {
    if (url.includes("step=2")) {
      return switchesEditStep2Snapshot;
    }
    return switchesEditStep1Snapshot;
  }
  if (url.includes(`/marketplace/item/${HOT_WHEELS_ID}`)) {
    return hotWheelsListingSnapshot;
  }
  if (url.includes(`/marketplace/item/${SWITCHES_ID}`)) {
    return switchesListingSnapshot;
  }
  return null;
}
