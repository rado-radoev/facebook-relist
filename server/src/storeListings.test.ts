import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoredClone, SyncedListing } from "./cloneTypes.js";
import { Store } from "./store.js";

let dataDir: string;
let store: Store;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "relist-store-"));
  store = new Store(dataDir);
  await store.load();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function sampleListing(id: string): SyncedListing {
  return {
    id,
    title: "A listing",
    price: "$30",
    status: "Available",
    statusText: "Active",
    photoUrl: "https://cdn.fixture.local/x.jpg",
    url: `https://www.facebook.com/marketplace/item/${id}`,
    listedDate: "2026-10-11",
    syncedAt: "2026-11-09T00:00:00.000Z",
  };
}

describe("Store — Sprint 2 listings and clones", () => {
  it("scopes listings and clones per user and persists them across reload", async () => {
    const first = await store.createUser({ name: "A", email: "a@example.com", passwordHash: "x" });
    const second = await store.createUser({ name: "B", email: "b@example.com", passwordHash: "x" });

    await store.setListings(first.id, [sampleListing("111")]);
    expect(store.getListings(first.id)).toHaveLength(1);
    expect(store.getListings(second.id)).toEqual([]);

    const clone: StoredClone = {
      recovery: null,
      picks: { condition: "New" },
      edits: {},
      photoSelection: null,
      updatedAt: "2026-11-09T00:00:00.000Z",
    };
    await store.saveClone(first.id, "111", clone);
    expect(store.getClone(first.id, "111")?.picks.condition).toBe("New");
    expect(store.getClone(second.id, "111")).toBeUndefined();

    const reopened = new Store(dataDir);
    await reopened.load();
    expect(reopened.getListings(first.id)[0].id).toBe("111");
    expect(reopened.getClone(first.id, "111")?.picks.condition).toBe("New");
  });

  it("saveClonePicks creates a recovery-less record and preserves recovery on update", async () => {
    const user = await store.createUser({ name: "A", email: "a@example.com", passwordHash: "x" });
    const created = await store.saveClonePicks(user.id, "111", {
      picks: { condition: "Used - Good" },
      edits: {},
      photoSelection: null,
    });
    expect(created.recovery).toBeNull();
    expect(created.picks.condition).toBe("Used - Good");

    const withRecovery: StoredClone = {
      ...created,
      recovery: {
        listingId: "111",
        recoveredAt: "2026-11-09T00:00:00.000Z",
        title: { value: "T", source: "edit_form", reason: null },
        price: { value: "$1", source: "edit_form", reason: null },
        description: { value: "D", source: "edit_form", reason: null },
        category: { value: "C", source: "edit_form", reason: null },
        condition: { value: null, source: null, reason: "missing" },
        attributes: { value: {}, source: "edit_form", reason: null },
        location: { value: "San Diego", source: "edit_form", reason: null },
        delivery: { value: null, source: null, reason: "missing" },
        photos: { urls: [], files: [], downloaded: 0 },
        video: { present: false, state: "none", file: null, reason: null },
        step2Blocked: true,
      },
    };
    await store.saveClone(user.id, "111", withRecovery);
    const updated = await store.saveClonePicks(user.id, "111", {
      picks: { delivery: "Local pickup only" },
      edits: { price: "$28" },
      photoSelection: null,
    });
    expect(updated.recovery?.listingId).toBe("111");
    expect(updated.picks.delivery).toBe("Local pickup only");
    expect(updated.edits.price).toBe("$28");
  });

  it("loads a pre-Sprint-2 data file (users/sessions only) with empty listings", async () => {
    const legacy = {
      users: [
        {
          id: "legacy-user",
          name: "Legacy",
          email: "legacy@example.com",
          passwordHash: "x",
          facebookStatus: "connected",
          facebookConnectedAt: null,
          createdAt: "2026-11-09T00:00:00.000Z",
        },
      ],
      sessions: [],
    };
    await writeFile(path.join(dataDir, "relist-data.json"), JSON.stringify(legacy), "utf8");
    const reopened = new Store(dataDir);
    await reopened.load();
    expect(reopened.findUserById("legacy-user")?.email).toBe("legacy@example.com");
    expect(reopened.getListings("legacy-user")).toEqual([]);
    expect(reopened.getClone("legacy-user", "111")).toBeUndefined();
  });
});
