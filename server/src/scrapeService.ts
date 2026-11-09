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
import { parseEditForm, parseSellingCards } from "./facebookExtract.js";
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
    return this.browser.withUserOperation(userId, () => this.syncListingsUnsafe(userId));
  }

  private async syncListingsUnsafe(userId: string): Promise<SyncedListing[]> {
    await this.requireConnected(userId);
    const snapshot = await this.browser.collectSnapshotAt(userId, SELLING_LIST_URL);
    if (!snapshot) {
      throw new ScrapeFailedError("The selling list page could not be read.");
    }
    const syncedAt = this.now().toISOString();
    const listings = parseSellingCards(snapshot.sellingCards ?? [], new Date(syncedAt));
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
    return this.browser.withUserOperation(userId, () => this.recoverListingUnsafe(userId, listingId));
  }

  private async recoverListingUnsafe(userId: string, listingId: string): Promise<StoredClone> {
    const synced = this.store.getListings(userId);
    if (!synced.some((listing) => listing.id === listingId)) {
      throw new ListingNotSyncedError(listingId);
    }
    await this.requireConnected(userId);

    const editStep1 = await this.browser.collectSnapshotAt(userId, editListingUrl(listingId));
    let editStep2: PageSnapshot | null = null;
    const editData = editStep1 ? parseEditForm(editStep1, null) : null;
    if (editData && !editData.step2Blocked) {
      // Step 2 (location/delivery) only exists after Step 1's Next. An
      // empty required field disables Next (the Hot Wheels quirk) — then
      // Step 2 is simply never read and its fields fall back / go missing.
      const advanced = await this.browser.advanceWizard(userId);
      if (advanced) {
        editStep2 = await this.browser.collectCurrentSnapshot(userId);
      }
    }

    const listingSnapshot = await this.browser.collectSnapshotAt(userId, listingPageUrl(listingId));
    if (!listingSnapshot) {
      throw new ScrapeFailedError("The listing page could not be read.");
    }

    const archive = new FileArchive(archiveDirFor(this.dataDir, userId, listingId));
    const recovery = await recoverCloneData(
      listingId,
      { editStep1, editStep2, listing: listingSnapshot },
      this.downloader,
      archive,
      this.now(),
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
