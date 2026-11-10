// Sprint 3: the Marketplace driver — the ONLY code that writes to
// Facebook (create + delete), plus the read checks the job's safeguards
// depend on (duplicate detection, availability, verification).
//
// The job service talks to this interface only, so tests substitute a
// fake driver and no test ever touches Facebook. The real implementation
// drives the person's own backend browser (BrowserManager) the same way
// Sprints 1–2 read pages: labelled-control scripts via page.evaluate,
// in the marker-comment style of ADVANCE_WIZARD_SCRIPT.
//
// HONESTY: every write-path script here is LIVE-UNVERIFIED. No backend
// profile holds a real Facebook login yet, so the create/delete flows
// have never run against real Facebook — they get their first real run
// in Sprint 4, with the owner present. The safeguards around them (job
// state machine, duplicate guard, delete guards, dry-run default) are
// what this sprint verifies, with the fake driver.

import path from "node:path";
import type { BrowserManager } from "./browserManager.js";
import type { SyncedListing } from "./cloneTypes.js";
import { parseGallery, parseSellingCards } from "./facebookExtract.js";
import {
  interpretListingAvailability,
  matchesFingerprint,
  type ListingAvailability,
  type ListingFingerprint,
} from "./jobLogic.js";
import type { CloneJobData } from "./jobTypes.js";
import { FacebookNotConnectedError } from "./scrapeService.js";
import {
  SELLING_LIST_URL,
  listingPageUrl,
  type PageSnapshot,
} from "./snapshot.js";

export const CREATE_LISTING_URL = "https://www.facebook.com/marketplace/create/item";

export type CreateOutcome =
  | { kind: "created"; listingId: string; url: string }
  | { kind: "dry_run" }
  | { kind: "blocked"; reason: string }
  | { kind: "unknown"; reason: string };

export type DeleteOutcome =
  | { kind: "deleted" }
  | { kind: "dry_run" }
  | { kind: "unknown"; reason: string }
  | { kind: "not_deleted"; reason: string };

export interface VerifyResult {
  /** The old listing no longer appears in the person's selling list. */
  oldGone: boolean;
  /** The new listing appears in the person's selling list. */
  newListed: boolean;
  /** True only when the selling-list read positively completed. */
  complete: boolean;
  newListingId: string | null;
  newSellerId: string | null;
  newPayloadHash: string | null;
}

export interface NewListingCheck {
  state: "verified" | "unknown";
  listingId: string | null;
  sellerMatchesOwner: boolean | null;
  payloadHash: string | null;
}

export interface PublishedListingVerification {
  /** "verified" only when every check positively passed; any shortfall
   *  is "unknown" — never a false verified. */
  state: "verified" | "unknown";
  reason: string | null;
}

export interface RecreateOriginalSnapshot {
  id: string;
  title: string;
  price: string;
  status: string;
  photoUrl: string;
  url: string;
}

export interface ListingObservation {
  state: "present" | "absent" | "unknown";
  id: string | null;
  sellerId: string | null;
  status: ListingAvailability;
  payloadHash: string | null;
  title: string | null;
  price: string | null;
  photoUrl: string | null;
  url: string | null;
  complete: boolean;
}

export interface MarketplaceDriver {
  /** A selling-list card that looks like the copy this job is creating
   *  (duplicate guard), or null. Never returns the job's own old listing. */
  findPossibleDuplicate(
    userId: string,
    fp: ListingFingerprint,
  ): Promise<SyncedListing | null | { kind: "unknown"; reason: string }>;
  /** Drive Facebook's create flow. In dry-run, walk every step but stop
   *  before the final submit. photoPaths are absolute archive paths. */
  createListing(
    userId: string,
    data: CloneJobData,
    photoPaths: string[],
    videoPath: string | null,
    options: { dryRun: boolean },
  ): Promise<CreateOutcome>;
  /** Availability of one listing, from its own page. */
  checkListing(userId: string, listingId: string): Promise<ListingAvailability>;
  /** Whether a listing still appears in the person's selling list —
   *  the delete step's target check for the OLD listing. */
  listingStillListed(userId: string, listingId: string): Promise<boolean | "unknown">;
  /** Fresh, exact comparison; incomplete source data must return unknown. */
  checkOriginalUnchanged(userId: string, original: RecreateOriginalSnapshot): Promise<"unchanged" | "changed" | "unknown">;
  /** Exact replacement ID, owner and payload attestation. */
  verifyNewListing(userId: string, listingId: string, url: string, payloadHash: string): Promise<NewListingCheck>;
  /** Post-delete verification: old gone from the selling list, new in it. */
  verifyRecreate(userId: string, oldListingId: string, newListingId: string): Promise<VerifyResult>;
  /** Blueprint §5 step 10 (optional so test fakes that never drive the
   *  watch step keep working; the job service feature-detects it):
   *  confirm the NEW listing itself — present in a complete selling
   *  list, its detail page readable, and its gallery matching the
   *  expected photo count (and first-photo identity, when known). */
  verifyPublishedListing?(
    userId: string,
    newListingId: string,
    expected: { photoCount: number; firstPhotoIdentity?: string | null },
  ): Promise<PublishedListingVerification>;
  /** Delete a listing. In dry-run, open the delete flow but stop before
   *  the final confirm — nothing is deleted. */
  deleteListing(
    userId: string,
    listingId: string,
    options: { dryRun: boolean },
  ): Promise<DeleteOutcome>;
}

// ---------------------------------------------------------------------------
// In-page scripts (marker-commented so test fakes can recognise them)

function scriptJson(value: unknown): string {
  return JSON.stringify(value);
}

/** Set a labelled input/textarea's value the React way (native setter +
 *  input/change events). Returns true when a matching field was found. */
export function fillFieldScript(labelPart: string, value: string): string {
  return `/* relist-fill */ (() => {
    const labelPart = ${scriptJson(labelPart.toLowerCase())};
    const value = ${scriptJson(value)};
    const labelFor = (el) => {
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const labelEl = document.getElementById(labelledBy);
        if (labelEl) return (labelEl.textContent || "").trim();
      }
      const aria = el.getAttribute("aria-label");
      if (aria) return aria.trim();
      if (el.id) {
        const byFor = document.querySelector('label[for="' + el.id + '"]');
        if (byFor) return (byFor.textContent || "").trim();
      }
      return "";
    };
    for (const el of document.querySelectorAll("input, textarea")) {
      if (el.type === "checkbox" || el.type === "radio" || el.type === "hidden" || el.type === "file") {
        continue;
      }
      if (!labelFor(el).toLowerCase().includes(labelPart)) {
        continue;
      }
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  })()`;
}

/** Click a button/option whose visible text matches (exact, else prefix). */
export function clickTextScript(text: string): string {
  return `/* relist-click-text */ (() => {
    const target = ${scriptJson(text.trim().toLowerCase())};
    const elements = document.querySelectorAll('[role="button"], button, [role="option"], [role="radio"], a');
    let prefixMatch = null;
    for (const el of elements) {
      const label = (el.textContent || "").trim().toLowerCase();
      if (label === target) {
        el.click();
        return true;
      }
      if (!prefixMatch && label.startsWith(target)) {
        prefixMatch = el;
      }
    }
    if (prefixMatch) {
      prefixMatch.click();
      return true;
    }
    return false;
  })()`;
}

/** Set a labelled checkbox to the wanted state (click only if needed). */
export function setCheckboxScript(labelPart: string, wanted: boolean): string {
  return `/* relist-checkbox */ (() => {
    const labelPart = ${scriptJson(labelPart.toLowerCase())};
    const wanted = ${scriptJson(wanted)};
    for (const el of document.querySelectorAll('input[type="checkbox"]')) {
      const labelEl = el.closest("label");
      const label = ((labelEl ? labelEl.textContent : "") || el.getAttribute("aria-label") || "").trim();
      if (!label.toLowerCase().includes(labelPart)) {
        continue;
      }
      if (Boolean(el.checked) !== wanted) {
        el.click();
      }
      return true;
    }
    return false;
  })()`;
}

/** Open the delete flow on a listing's seller page: click "Delete
 *  listing" if visible; otherwise open the more-actions menu first. */
export const DELETE_OPEN_SCRIPT = `/* relist-delete-open */ (() => {
  const candidates = document.querySelectorAll('[role="button"], button, [role="menuitem"], a');
  for (const el of candidates) {
    const label = (el.textContent || "").trim().toLowerCase();
    if (label === "delete listing" || label === "delete") {
      el.click();
      return "clicked";
    }
  }
  for (const el of candidates) {
    const label = (el.textContent || el.getAttribute("aria-label") || "").trim().toLowerCase();
    if (label === "more actions" || label === "..." || label === "•••") {
      el.click();
      return "menu";
    }
  }
  return "not_found";
})()`;

/** Confirm an open delete dialog. Only ever run for a real (non-dry-run)
 *  delete, after the job's guards have passed. */
export const DELETE_CONFIRM_SCRIPT = `/* relist-delete-confirm */ (() => {
  const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
  for (const dialog of dialogs) {
    const buttons = dialog.querySelectorAll('[role="button"], button');
    for (const el of buttons) {
      const label = (el.textContent || "").trim().toLowerCase();
      if (label === "delete" || label === "delete listing") {
        el.click();
        return true;
      }
    }
  }
  return false;
})()`;

/** Count the photo thumbnails rendered in the create form's photo /
 *  upload section after an upload. Returns the count, or null when no
 *  photo/upload section can be found at all (the driver treats that as
 *  "unknown", never as zero). Best-effort and LIVE-UNVERIFIED, like the
 *  other collector scripts: it looks inside sections labelled for
 *  photos/uploads/media, skips avatar/profile/icon images and tiny
 *  (<32px) chrome, and counts each remaining <img> once. */
export const UPLOAD_COUNT_SCRIPT = `/* relist-upload-count */ (() => {
  const sections = [...document.querySelectorAll("[aria-label], [data-testid]")].filter((el) => {
    const hint = (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("data-testid") || "");
    return /photo|upload|media/i.test(hint);
  });
  if (sections.length === 0) {
    return null;
  }
  const seen = new Set();
  let count = 0;
  for (const section of sections) {
    for (const img of section.querySelectorAll("img")) {
      if (seen.has(img)) {
        continue;
      }
      seen.add(img);
      const src = img.currentSrc || img.src || "";
      if (!src) {
        continue;
      }
      const label = ((img.getAttribute("alt") || "") + " " + (img.getAttribute("aria-label") || "")).toLowerCase();
      if (/avatar|profile|icon/.test(label)) {
        continue;
      }
      const width = img.width || img.naturalWidth || 0;
      const height = img.height || img.naturalHeight || 0;
      if (width > 0 && width < 32 && height > 0 && height < 32) {
        continue;
      }
      count += 1;
    }
  }
  return count;
})()`;

const ITEM_ID_PATTERN = /\/marketplace\/item\/(\d+)/;

interface SellingListEvidence {
  surface?: {
    kind?: string;
    listingId?: string | null;
    readiness?: string;
  };
  completion?: {
    state?: string;
    expectedCount?: number | null;
    observedCount?: number;
  };
}

function isCompleteSellingList(
  snapshot: PageSnapshot,
): snapshot is PageSnapshot & { sellingCards: NonNullable<PageSnapshot["sellingCards"]> } {
  let url: URL;
  try {
    url = new URL(snapshot.url);
  } catch {
    return false;
  }
  const evidence = snapshot as PageSnapshot & SellingListEvidence;
  const completion = evidence.completion;
  return (
    url.protocol === "https:" &&
    ["facebook.com", "www.facebook.com"].includes(url.hostname) &&
    url.pathname.replace(/\/$/, "") === "/marketplace/you/selling" &&
    !url.search &&
    !url.hash &&
    evidence.surface?.kind === "selling_list" &&
    evidence.surface.readiness === "ready" &&
    Array.isArray(snapshot.sellingCards) &&
    completion?.state === "complete" &&
    Number.isInteger(completion.expectedCount) &&
    completion.expectedCount === snapshot.sellingCards.length &&
    completion.observedCount === snapshot.sellingCards.length
  );
}

function isExpectedListingSurface(snapshot: PageSnapshot, listingId: string): boolean {
  const evidence = snapshot as PageSnapshot & SellingListEvidence;
  return (
    evidence.surface?.kind === "listing" &&
    evidence.surface.listingId === listingId &&
    evidence.surface.readiness === "ready"
  );
}

// ---------------------------------------------------------------------------
// Real driver

/** Bounded polls for the create form's thumbnails to render after an
 *  upload (blueprint §5 step 9) before the count is called settled. */
const UPLOAD_COUNT_MAX_ATTEMPTS = 10;

export type PaceFn = () => Promise<void>;

const defaultPace: PaceFn = async () => {
  const ms = 700 + Math.floor(Math.random() * 800);
  await new Promise((resolve) => setTimeout(resolve, ms));
};

export class FacebookDriver implements MarketplaceDriver {
  private readonly pace: PaceFn;
  private readonly now: () => Date;

  constructor(
    private readonly browser: BrowserManager,
    pace?: PaceFn,
    now?: () => Date,
  ) {
    this.pace = pace ?? defaultPace;
    this.now = now ?? (() => new Date());
  }

  private async requireConnected(userId: string): Promise<void> {
    await this.browser.ensureSession(userId);
    const status = await this.browser.refreshStatus(userId);
    if (status !== "connected") {
      throw new FacebookNotConnectedError();
    }
  }

  private async sellingCards(userId: string): Promise<SyncedListing[]> {
    const snapshot = await this.browser.collectSnapshotAt(userId, SELLING_LIST_URL);
    if (!snapshot) {
      return [];
    }
    return parseSellingCards(snapshot.sellingCards ?? [], this.now());
  }

  async findPossibleDuplicate(
    userId: string,
    fp: ListingFingerprint,
  ): Promise<SyncedListing | null | { kind: "unknown"; reason: string }> {
    await this.requireConnected(userId);
    const snapshot = await this.browser.collectSnapshotAt(userId, SELLING_LIST_URL);
    if (!snapshot || !isCompleteSellingList(snapshot)) {
      return { kind: "unknown", reason: "The selling-list snapshot is missing or incomplete." };
    }
    const cards = parseSellingCards(snapshot.sellingCards, this.now());
    const today = this.now().toISOString().slice(0, 10);
    for (const card of cards) {
      if (matchesFingerprint(card, fp, today)) {
        return card;
      }
    }
    return null;
  }

  async createListing(
    userId: string,
    data: CloneJobData,
    photoPaths: string[],
    videoPath: string | null,
    options: { dryRun: boolean },
  ): Promise<CreateOutcome> {
    if (options.dryRun) {
      return { kind: "dry_run" };
    }
    await this.requireConnected(userId);
    const start = await this.browser.collectSnapshotAt(userId, CREATE_LISTING_URL);
    if (!start) {
      return { kind: "unknown", reason: "The create-listing page could not be opened." };
    }

    // Photos first — the create form keys everything else off the upload.
    const media = videoPath ? [...photoPaths, videoPath] : [...photoPaths];
    const uploaded =
      (await this.browser.uploadFiles(userId, 'input[type="file"][accept*="image"]', media)) ||
      (await this.browser.uploadFiles(userId, 'input[type="file"]', media));
    if (!uploaded) {
      return { kind: "unknown", reason: "The photo upload control could not be found on the create form." };
    }
    await this.pace();

    // Blueprint §5 step 9: prove the uploads actually landed BEFORE the
    // form is filled in and long before any Publish/Post click. The
    // assertion is on the photo count only — a video, when present, is
    // uploaded too but has no thumbnail count to assert against here.
    const uploadCheck = await this.verifyUploadedPhotoCount(userId, photoPaths.length);
    if (uploadCheck.kind !== "verified") {
      return uploadCheck;
    }

    await this.browser.runScript(userId, fillFieldScript("title", data.title));
    await this.pace();
    await this.browser.runScript(userId, fillFieldScript("price", data.price.replace(/^\$/, "")));
    await this.pace();
    await this.browser.runScript(userId, fillFieldScript("description", data.description));
    await this.pace();

    // Category + condition are option pickers: open, then click the value.
    await this.browser.runScript(userId, clickTextScript("Category"));
    await this.pace();
    await this.browser.runScript(userId, clickTextScript(data.category));
    await this.pace();
    await this.browser.runScript(userId, clickTextScript(data.condition));
    await this.pace();

    for (const [label, value] of Object.entries(data.attributes)) {
      await this.browser.runScript(userId, clickTextScript(label));
      await this.pace();
      await this.browser.runScript(userId, clickTextScript(value));
      await this.pace();
    }

    // Step 2: location + delivery. The wizard's Next is in-form
    // navigation (the same safe click recovery uses).
    const advanced = await this.browser.advanceWizard(userId);
    if (advanced) {
      await this.pace();
      await this.browser.runScript(userId, fillFieldScript("location", data.location));
      await this.pace();
      if (data.delivery.type) {
        await this.browser.runScript(userId, clickTextScript(data.delivery.type));
        await this.pace();
      }
      if (data.delivery.meetup) {
        const meetup = data.delivery.meetup;
        if (meetup.public === null || meetup.doorPickup === null || meetup.doorDropoff === null) {
          return { kind: "blocked", reason: "One or more meetup preferences are unknown; choose each value before continuing." };
        }
        await this.browser.runScript(
          userId,
          setCheckboxScript("public meetup", meetup.public),
        );
        await this.browser.runScript(
          userId,
          setCheckboxScript("door pickup", meetup.doorPickup),
        );
        await this.browser.runScript(
          userId,
          setCheckboxScript("door dropoff", meetup.doorDropoff),
        );
        await this.pace();
      }
    }

    if (options.dryRun) {
      // Walked the whole form; stop BEFORE the submit. Nothing posted.
      return { kind: "dry_run" };
    }

    const submitted =
      (await this.browser.runScript(userId, clickTextScript("Publish"))) === true ||
      (await this.browser.runScript(userId, clickTextScript("Post"))) === true;
    if (!submitted) {
      return { kind: "unknown", reason: "The create form's submit button could not be found." };
    }
    await this.pace();

    const after = await this.browser.collectCurrentSnapshot(userId);
    const urlMatch = after ? ITEM_ID_PATTERN.exec(after.url) : null;
    if (urlMatch) {
      return { kind: "created", listingId: urlMatch[1], url: listingPageUrl(urlMatch[1]) };
    }
    // Fall back to the selling list: a card that looks like ours.
    const cards = await this.sellingCards(userId);
    const today = this.now().toISOString().slice(0, 10);
    const fp: ListingFingerprint = {
      listingId: "",
      title: data.title.replace(/\s+/g, " ").trim().toLowerCase(),
      price: data.price.replace(/[^0-9.]/g, ""),
      photoKey: "",
    };
    for (const card of cards) {
      if (matchesFingerprint(card, fp, today)) {
        return { kind: "created", listingId: card.id, url: card.url };
      }
    }
    return {
      kind: "unknown",
      reason:
        "The create form was submitted, but the new listing's id could not be determined. " +
        "Check Facebook before retrying — the duplicate guard will look for the copy first.",
    };
  }

  /** Poll the create form's rendered photo thumbnails until they match
   *  the number of uploaded photos. A count that never materialises
   *  (script returns null / a non-number) is "unknown" — the create must
   *  not publish blind; a count that settles at any other number is
   *  "blocked", also without publishing. */
  private async verifyUploadedPhotoCount(
    userId: string,
    expectedCount: number,
  ): Promise<
    | { kind: "verified" }
    | { kind: "blocked"; reason: string }
    | { kind: "unknown"; reason: string }
  > {
    let observed: number | null = null;
    for (let attempt = 0; attempt < UPLOAD_COUNT_MAX_ATTEMPTS; attempt += 1) {
      const raw = await this.browser.runScript(userId, UPLOAD_COUNT_SCRIPT);
      if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
        observed = raw;
        if (raw === expectedCount) {
          return { kind: "verified" };
        }
      }
      if (attempt < UPLOAD_COUNT_MAX_ATTEMPTS - 1) {
        await this.pace();
      }
    }
    if (observed === null) {
      return {
        kind: "unknown",
        reason: "The photo uploads could not be verified on the create form.",
      };
    }
    return {
      kind: "blocked",
      reason:
        `The create form shows ${observed} photo thumbnail${observed === 1 ? "" : "s"}, ` +
        `but ${expectedCount} photo${expectedCount === 1 ? " was" : "s were"} uploaded — ` +
        "the listing was not published. Check the photos and try again.",
    };
  }

  async checkListing(userId: string, listingId: string): Promise<ListingAvailability> {
    await this.requireConnected(userId);
    const snapshot: PageSnapshot | null = await this.browser.collectSnapshotAt(
      userId,
      listingPageUrl(listingId),
    );
    if (!snapshot) {
      return "unknown";
    }
    if (!isExpectedListingSurface(snapshot, listingId)) {
      return "unknown";
    }
    return interpretListingAvailability(snapshot, listingId);
  }

  async listingStillListed(userId: string, listingId: string): Promise<boolean | "unknown"> {
    await this.requireConnected(userId);
    const snapshot = await this.browser.collectSnapshotAt(userId, SELLING_LIST_URL);
    if (!snapshot || !isCompleteSellingList(snapshot)) {
      return "unknown";
    }
    const cards = parseSellingCards(snapshot.sellingCards, this.now());
    return cards.some((card) => card.id === listingId);
  }

  async checkOriginalUnchanged(
    userId: string,
    original: RecreateOriginalSnapshot,
  ): Promise<"unchanged" | "changed" | "unknown"> {
    await this.requireConnected(userId);
    const snapshot = await this.browser.collectSnapshotAt(userId, SELLING_LIST_URL);
    if (!snapshot || !isCompleteSellingList(snapshot)) {
      return "unknown";
    }
    const card = parseSellingCards(snapshot.sellingCards, this.now()).find((entry) => entry.id === original.id);
    if (!card) {
      return "unknown";
    }
    return card.title === original.title &&
      card.price === original.price &&
      card.status === original.status &&
      card.photoUrl === original.photoUrl &&
      card.url === original.url
      ? "unchanged"
      : "changed";
  }

  async verifyNewListing(
    _userId: string,
    _listingId: string,
    _url: string,
    _payloadHash: string,
  ): Promise<NewListingCheck> {
    // Current extraction DTO cannot attest seller identity or full payload.
    // Do not infer either from a title/price card.
    return { state: "unknown", listingId: null, sellerMatchesOwner: null, payloadHash: null };
  }

  /** Blueprint §5 step 10: verify the NEW listing itself before the job
   *  may treat it as available (the state that later authorises deleting
   *  the old listing). Every shortfall returns "unknown" with a specific
   *  reason — this never produces a false verified:
   *  (1) a COMPLETE selling-list read must contain the new listing;
   *  (2) its own detail page must be the expected listing surface;
   *  (3) its gallery must hold exactly the expected number of photos
   *      and, when the first photo's stable identity is known, the
   *      first gallery slot must carry that identity. */
  async verifyPublishedListing(
    userId: string,
    newListingId: string,
    expected: { photoCount: number; firstPhotoIdentity?: string | null },
  ): Promise<PublishedListingVerification> {
    const unknown = (reason: string): PublishedListingVerification => ({
      state: "unknown",
      reason,
    });
    await this.requireConnected(userId);

    const listSnapshot = await this.browser.collectSnapshotAt(userId, SELLING_LIST_URL);
    if (!listSnapshot || !isCompleteSellingList(listSnapshot)) {
      return unknown(
        "The selling list could not be read completely, so the new listing's photos could not be verified.",
      );
    }
    const cards = parseSellingCards(listSnapshot.sellingCards, this.now());
    if (!cards.some((card) => card.id === newListingId)) {
      return unknown("The new listing does not appear in the selling list yet.");
    }

    const detail = await this.browser.collectSnapshotAt(userId, listingPageUrl(newListingId));
    if (!detail) {
      return unknown("The new listing's page could not be opened, so its photos could not be verified.");
    }
    if (!isExpectedListingSurface(detail, newListingId)) {
      return unknown("The new listing's page could not be confirmed, so its photos could not be verified.");
    }

    const photoUrls = parseGallery(detail);
    if (photoUrls.length !== expected.photoCount) {
      return unknown(
        `The new listing's gallery shows ${photoUrls.length} photo${photoUrls.length === 1 ? "" : "s"}, ` +
          `but ${expected.photoCount} were uploaded.`,
      );
    }
    if (expected.firstPhotoIdentity) {
      const firstIdentity = detail.gallery?.slots?.[0]?.identity ?? null;
      if (!firstIdentity) {
        return unknown("The new listing's first photo identity could not be read.");
      }
      if (firstIdentity !== expected.firstPhotoIdentity) {
        return unknown("The new listing's first photo does not match the clone's first photo.");
      }
    }
    return { state: "verified", reason: null };
  }

  async verifyRecreate(
    userId: string,
    oldListingId: string,
    newListingId: string,
  ): Promise<VerifyResult> {
    await this.requireConnected(userId);
    const snapshot = await this.browser.collectSnapshotAt(userId, SELLING_LIST_URL);
    const listComplete = Boolean(snapshot && isCompleteSellingList(snapshot));
    const cards = listComplete ? parseSellingCards(snapshot!.sellingCards!, this.now()) : [];
    const newCard = cards.find((card) => card.id === newListingId);
    // Blueprint §6: "old gone" needs BOTH proofs — the old id absent
    // from a complete, reloaded selling list AND the old listing's own
    // page reporting the unavailable ("gone") state. An item page that
    // reads "unknown" leaves the whole verification incomplete, never
    // a presumed-gone.
    const oldAvailability = await this.checkListing(userId, oldListingId);
    const complete = listComplete && oldAvailability !== "unknown";
    return {
      oldGone:
        complete &&
        !cards.some((card) => card.id === oldListingId) &&
        oldAvailability === "gone",
      newListed: Boolean(newCard),
      complete,
      newListingId: newCard?.id ?? null,
      newSellerId: null,
      newPayloadHash: null,
    };
  }

  async deleteListing(
    userId: string,
    listingId: string,
    options: { dryRun: boolean },
  ): Promise<DeleteOutcome> {
    if (options.dryRun) {
      return { kind: "dry_run" };
    }
    await this.requireConnected(userId);
    const opened = await this.browser.collectSnapshotAt(userId, listingPageUrl(listingId));
    if (!opened) {
      return { kind: "not_deleted", reason: "The listing page could not be opened." };
    }
    let result = await this.browser.runScript(userId, DELETE_OPEN_SCRIPT);
    if (result === "menu") {
      await this.pace();
      result = await this.browser.runScript(userId, DELETE_OPEN_SCRIPT);
    }
    if (result !== "clicked") {
      return { kind: "not_deleted", reason: "The delete control could not be found on the listing page." };
    }
    await this.pace();

    const confirmed = await this.browser.runScript(userId, DELETE_CONFIRM_SCRIPT);
    if (confirmed !== true) {
      return { kind: "not_deleted", reason: "The delete confirmation dialog could not be completed." };
    }
    await this.pace();

    const stillListed = await this.listingStillListed(userId, listingId);
    if (stillListed === "unknown") {
      return { kind: "unknown", reason: "The selling list could not confirm whether the original listing remains present." };
    }
    if (stillListed) {
      return { kind: "not_deleted", reason: "The listing still appears in the selling list after delete." };
    }
    return { kind: "deleted" };
  }
}

/** Absolute path of an archived media file for upload. */
export function archiveFilePath(archiveDir: string, fileName: string): string {
  return path.join(archiveDir, path.basename(fileName));
}
