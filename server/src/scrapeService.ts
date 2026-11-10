// Listings sync + clone recovery, driven through the signed-in person's
// own backend browser session.
//
// Guarantees kept from Sprint 1 and the requirements:
//  - Everything runs inside the caller's own browser profile; the user id
//    always comes from the app session, never from the request.
//  - A listing can only be recovered if it is in that user's own synced
//    list — anything else is refused (ListingNotSyncedError), so one
//    person can never point recovery at someone else's listing.
//  - Read-only against Facebook: pages are opened and read; the only
//    click ever made is the edit wizard's "Next" (in-form navigation,
//    never a save). No creates, edits, or deletes happen in this sprint.

import type { BrowserManager } from "./browserManager.js";
import type { StoredClone, SyncedListing } from "./cloneTypes.js";
import {
  parseEditForm,
  parseGallery,
  parseGallerySlots,
  parseSellingCards,
} from "./facebookExtract.js";
import {
  FileArchive,
  archiveDirFor,
  defaultDownloader,
  recoverCloneData,
  type FileDownloader,
} from "./recovery.js";
import {
  SELLING_LIST_URL,
  editListingUrl,
  listingPageUrl,
  type PageSnapshot,
} from "./snapshot.js";
import type { Store } from "./store.js";

export class FacebookNotConnectedError extends Error {
  constructor() {
    super("Facebook is not connected for this account");
    this.name = "FacebookNotConnectedError";
  }
}

export class ListingNotSyncedError extends Error {
  constructor(listingId: string) {
    super(`Listing ${listingId} is not in this account's synced listings`);
    this.name = "ListingNotSyncedError";
  }
}

export class ScrapeFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScrapeFailedError";
  }
}

interface UserOperationBrowser {
  withUserOperation?<T>(userId: string, operation: () => Promise<T>): Promise<T>;
}

function withUserOperation<T>(browser: BrowserManager, userId: string, operation: () => Promise<T>): Promise<T> {
  const coordinator = (browser as unknown as UserOperationBrowser).withUserOperation;
  return coordinator ? coordinator.bind(browser)(userId, operation) : operation();
}

function isExpectedPage(snapshot: PageSnapshot, kind: "selling_list" | "edit_form" | "listing", listingId?: string): boolean {
  let url: URL;
  try {
    url = new URL(snapshot.url);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.hostname !== "www.facebook.com" || snapshot.surface?.kind !== kind || snapshot.surface.readiness !== "ready") {
    return false;
  }
  if (listingId && snapshot.surface.listingId !== listingId) return false;
  if (kind === "selling_list") return url.pathname === "/marketplace/you/selling" && snapshot.surface.listingId === null;
  const route = kind === "edit_form" ? `/marketplace/edit/${listingId}` : `/marketplace/item/${listingId}`;
  return url.pathname === route;
}

export class ScrapeService {
  private readonly downloader: FileDownloader;
  private readonly now: () => Date;

  constructor(
    private readonly store: Store,
    private readonly browser: BrowserManager,
    private readonly dataDir: string,
    downloader?: FileDownloader,
    now?: () => Date,
  ) {
    this.downloader = downloader ?? defaultDownloader;
    this.now = now ?? (() => new Date());
  }

  private async requireConnected(userId: string): Promise<void> {
    await this.browser.ensureSession(userId);
    const status = await this.browser.refreshStatus(userId);
    if (status !== "connected") {
      throw new FacebookNotConnectedError();
    }
  }

  /** Read the person's own selling list and replace their synced copy. */
  async syncListings(userId: string): Promise<SyncedListing[]> {
    return withUserOperation(this.browser, userId, () => this.syncListingsUnsafe(userId));
  }

  private async syncListingsUnsafe(userId: string): Promise<SyncedListing[]> {
      await this.requireConnected(userId);
      const snapshot = await this.browser.collectSnapshotAt(userId, SELLING_LIST_URL);
      if (!snapshot || !isExpectedPage(snapshot, "selling_list")) {
        throw new ScrapeFailedError("The verified selling-list surface is unavailable or not ready; saved listings were preserved.");
      }
      const cards = snapshot.sellingCards;
      const completion = snapshot.completion;
      if (!cards || !completion || completion.state !== "complete" || completion.expectedCount === null ||
        completion.expectedCount !== completion.observedCount || completion.observedCount !== cards.length) {
        throw new ScrapeFailedError("The selling-list count is missing, incomplete, or inconsistent; saved listings were preserved.");
      }
      const syncedAt = this.now().toISOString();
      const listings = parseSellingCards(cards, new Date(syncedAt));
      await this.store.setListingsSync(userId, listings, syncedAt);
      return listings;
  }

  /**
   * Recover the full clone for one of the person's own listings:
   * edit form (Step 1, then Step 2 when the wizard can advance) and the
   * listing page, merged in the verified recovery order, with the photo
   * files (and the video, attempted) downloaded into the archive.
   */
  async recoverListing(userId: string, listingId: string): Promise<StoredClone> {
    return withUserOperation(this.browser, userId, () => this.recoverListingUnsafe(userId, listingId));
  }

  private async recoverListingUnsafe(userId: string, listingId: string): Promise<StoredClone> {
    const synced = this.store.getListings(userId);
    if (!synced.some((listing) => listing.id === listingId)) {
      throw new ListingNotSyncedError(listingId);
    }
    await this.requireConnected(userId);

      const editStep1 = await this.browser.collectSnapshotAt(userId, editListingUrl(listingId));
      if (editStep1 && !isExpectedPage(editStep1, "edit_form", listingId)) {
        throw new ScrapeFailedError("The edit surface did not match the requested listing; saved recovery was preserved.");
      }
      let editStep2: PageSnapshot | null = null;
      const editData = editStep1 ? parseEditForm(editStep1, null) : null;
      if (editData && !editData.step2Blocked) {
      // Step 2 (location/delivery) only exists after Step 1's Next. An
      // empty required field disables Next (the Hot Wheels quirk) — then
      // Step 2 is simply never read and its fields fall back / go missing.
        const advanced = await this.browser.advanceWizard(userId);
        if (advanced) {
          editStep2 = await this.browser.collectCurrentSnapshot(userId);
          if (editStep2 && !isExpectedPage(editStep2, "edit_form", listingId)) {
            throw new ScrapeFailedError("The Step 2 surface did not match the requested listing; saved recovery was preserved.");
          }
        }
      }

      const listingSnapshot = await this.browser.collectSnapshotAt(userId, listingPageUrl(listingId));
      if (!listingSnapshot || !isExpectedPage(listingSnapshot, "listing", listingId)) {
        throw new ScrapeFailedError("The verified listing surface did not match the requested listing; saved recovery was preserved.");
      }

      const archive = new FileArchive(archiveDirFor(this.dataDir, userId, listingId));
      // 403 re-mint: a signed CDN URL can expire between snapshot and
      // download. Re-collect the listing page, re-parse its gallery, and
      // hand back the URL at the same slot — matched by the original
      // slot identity when identities are available, else by position.
      // Any failure to re-collect yields null (no retry).
      const originalSlots = parseGallerySlots(listingSnapshot);
      const remint = async (index: number): Promise<string | null> => {
        try {
          const freshSnapshot = await this.browser.collectSnapshotAt(
            userId,
            listingPageUrl(listingId),
          );
          if (!freshSnapshot || !isExpectedPage(freshSnapshot, "listing", listingId)) {
            return null;
          }
          const freshSlots = parseGallerySlots(freshSnapshot);
          const originalIdentity = originalSlots?.[index]?.identity;
          if (originalIdentity && freshSlots) {
            const match = freshSlots.find((slot) => slot.identity === originalIdentity);
            if (match) {
              return match.url;
            }
          }
          const freshUrls = parseGallery(freshSnapshot);
          return freshUrls[index] ?? null;
        } catch {
          return null;
        }
      };
      const recovery = await recoverCloneData(
      listingId,
      { editStep1, editStep2, listing: listingSnapshot },
      this.downloader,
      archive,
      this.now(),
      {},
      { remint },
      );

      const existing = this.store.getClone(userId, listingId);
      const record: StoredClone = {
      recovery,
      picks: existing ? existing.picks : {},
      edits: existing ? existing.edits : {},
      photoSelection: existing ? existing.photoSelection : null,
      updatedAt: this.now().toISOString(),
      };
      await this.store.saveClone(userId, listingId, record);
      return record;
  }
}
