// Listings + clone recovery for the signed-in person only (Sprint 2).
//
// Every route derives the account from the app session cookie (the
// Sprint 1 rule — no account id is ever accepted from the client), and
// recovery is refused for any listing that is not in the caller's own
// synced list, so a signed-in person can only ever sync, recover, and
// read their own listings and clone archives.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { makeRequireAuth } from "./auth.js";
import type { CloneEdits, ClonePicks } from "./cloneTypes.js";
import { archiveDirFor } from "./recovery.js";
import {
  FacebookNotConnectedError,
  ListingNotSyncedError,
  ScrapeFailedError,
  type ScrapeService,
} from "./scrapeService.js";
import type { Store } from "./store.js";

const PICK_KEYS = new Set(["condition", "category", "delivery"]);
const EDIT_KEYS = new Set([
  "title",
  "price",
  "description",
  "category",
  "condition",
  "delivery",
  "location",
  "attributes",
]);

const PHOTO_CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function readStringRecord(
  body: Record<string, unknown>,
  key: string,
  allowedKeys: Set<string>,
  maxLength: number,
): Record<string, string> | null {
  const raw = body[key];
  if (raw === undefined) {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const result: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(raw)) {
    if (!allowedKeys.has(entryKey) || typeof entryValue !== "string") {
      return null;
    }
    if (entryValue.length > maxLength) {
      return null;
    }
    result[entryKey] = entryValue;
  }
  return result;
}

function readPicksBody(body: unknown): {
  picks: ClonePicks;
  edits: CloneEdits;
  photoSelection: string[] | null;
} | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const picks = readStringRecord(record, "picks", PICK_KEYS, 200);
  const edits = readStringRecord(record, "edits", EDIT_KEYS, 5000);
  if (!picks || !edits) {
    return null;
  }
  let photoSelection: string[] | null = null;
  const rawSelection = record.photoSelection;
  if (rawSelection !== undefined && rawSelection !== null) {
    if (!Array.isArray(rawSelection)) {
      return null;
    }
    for (const entry of rawSelection) {
      if (typeof entry !== "string" || entry.length > 200) {
        return null;
      }
    }
    photoSelection = rawSelection as string[];
  }
  return {
    picks: picks as ClonePicks,
    edits: edits as CloneEdits,
    photoSelection,
  };
}

export function registerListingsRoutes(
  app: FastifyInstance,
  store: Store,
  scraper: ScrapeService,
  dataDir: string,
): void {
  const requireAuth = makeRequireAuth(store);

  app.get("/api/listings", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      await reply.code(401).send({ error: "Not signed in" });
      return;
    }
    const listings = store.getListings(user.id);
    const syncedAt = listings.length > 0 ? listings[0].syncedAt : null;
    await reply.send({ listings, syncedAt });
  });

  app.post("/api/listings/sync", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      await reply.code(401).send({ error: "Not signed in" });
      return;
    }
    try {
      const listings = await scraper.syncListings(user.id);
      const syncedAt = listings.length > 0 ? listings[0].syncedAt : null;
      await reply.send({ listings, syncedAt });
    } catch (error) {
      if (error instanceof FacebookNotConnectedError) {
        await reply.code(409).send({ error: "Connect Facebook before syncing listings" });
        return;
      }
      if (error instanceof ScrapeFailedError) {
        await reply.code(502).send({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.get(
    "/api/listings/:id/clone",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        await reply.code(401).send({ error: "Not signed in" });
        return;
      }
      const { id } = request.params as { id: string };
      const clone = store.getClone(user.id, id);
      if (!clone) {
        await reply.code(404).send({ error: "No clone check has been run for this listing" });
        return;
      }
      await reply.send({ clone });
    },
  );

  app.post(
    "/api/listings/:id/clone/recover",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        await reply.code(401).send({ error: "Not signed in" });
        return;
      }
      const { id } = request.params as { id: string };
      try {
        const clone = await scraper.recoverListing(user.id, id);
        await reply.send({ clone });
      } catch (error) {
        if (error instanceof ListingNotSyncedError) {
          await reply.code(404).send({ error: "That listing is not in your synced listings" });
          return;
        }
        if (error instanceof FacebookNotConnectedError) {
          await reply.code(409).send({ error: "Connect Facebook before running a clone check" });
          return;
        }
        if (error instanceof ScrapeFailedError) {
          await reply.code(502).send({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );

  app.put(
    "/api/listings/:id/clone/picks",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        await reply.code(401).send({ error: "Not signed in" });
        return;
      }
      const { id } = request.params as { id: string };
      const synced = store.getListings(user.id);
      if (!synced.some((listing) => listing.id === id)) {
        await reply.code(404).send({ error: "That listing is not in your synced listings" });
        return;
      }
      const parsed = readPicksBody(request.body);
      if (!parsed) {
        await reply.code(400).send({ error: "Invalid picks/edits payload" });
        return;
      }
      const clone = await store.saveClonePicks(user.id, id, parsed);
      await reply.send({ clone });
    },
  );

  // Archived photo files for the caller's own clone. The file name comes
  // from the caller's own stored recovery — never from the request — so
  // this cannot be aimed at another user's archive.
  app.get(
    "/api/listings/:id/photos/:index",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        await reply.code(401).send({ error: "Not signed in" });
        return;
      }
      const { id, index } = request.params as { id: string; index: string };
      const clone = store.getClone(user.id, id);
      const photoIndex = Number(index);
      if (!clone || !clone.recovery || !Number.isInteger(photoIndex) || photoIndex < 0) {
        await reply.code(404).send({ error: "Photo not found" });
        return;
      }
      const fileName = clone.recovery.photos.files[photoIndex];
      if (!fileName) {
        await reply.code(404).send({ error: "Photo not found" });
        return;
      }
      const filePath = path.join(archiveDirFor(dataDir, user.id, id), path.basename(fileName));
      try {
        const data = await readFile(filePath);
        const contentType = PHOTO_CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? "image/jpeg";
        await reply.header("Content-Type", contentType).send(data);
      } catch {
        await reply.code(404).send({ error: "Photo not found" });
      }
    },
  );
}
