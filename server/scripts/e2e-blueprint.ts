// End-to-end proof of the research-blueprint rebuild against a REAL
// Chromium in this sandbox. A custom launcher (mirroring the production
// launcher's wrapping) installs Playwright route interception on the
// persistent context, so every facebook.com URL is fulfilled from local
// fixture pages — the URLs, cookies, payloads, and DOM the production
// code sees are the real shapes; only the origin server is fake. The
// whole production stack runs: Fastify app, Relist auth, the live-login
// WebSocket + CDP screencast, the strict §6 Connected ceremony (with a
// real context restart), listings sync, payload-first clone recovery
// into the image vault, and a REAL (non-dry-run) recreate job whose
// delete step must stay gated until the new listing verifies live.
//
// What this cannot prove: real Facebook's live payload shape can drift
// from these fixtures. The owner's first real login + sync on her host
// remains the acceptance test.
//
// Run: npx tsx scripts/e2e-blueprint.ts   (exit 0 = all checks passed)

import { deflateSync } from "node:zlib";
import { createHash as sha256Of } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { buildApp, type AppParts } from "../src/app.js";
import type { Config } from "../src/config.js";
import {
  buildLaunchOptions,
  type BrowserHandle,
  type BrowserLauncher,
  type ContextLike,
  type PageLike,
} from "../src/browserManager.js";

const APP_PORT = 8979;
const ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const FB = "https://www.facebook.com";

// ---------------------------------------------------------------------------
// Fixture photo bytes: minimal 64x64 PNGs (deterministic, distinct hashes)

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function makePng(red: number, green: number, blue: number): Buffer {
  const width = 64;
  const height = 64;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = red;
    row[1 + x * 3 + 1] = green;
    row[1 + x * 3 + 2] = blue;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Fixture "Facebook" state

interface FixturePhoto {
  id: string;
  largeUrl: string;
  smallUrl: string;
  bytes: Buffer;
}

interface FixtureListing {
  id: string;
  title: string;
  price: string;
  description: string;
  category: string;
  condition: string;
  location: string;
  photos: FixturePhoto[];
  state: "live" | "in_review" | "deleted";
}

function photo(id: string, red: number, green: number, blue: number): FixturePhoto {
  return {
    id,
    largeUrl: `https://scontent-lax3-1.xx.fbcdn.net/v/t39.30808-6/${id}_large.png?oh=fixture`,
    smallUrl: `https://scontent-lax3-1.xx.fbcdn.net/v/t39.30808-6/${id}_small.png?oh=fixture`,
    bytes: makePng(red, green, blue),
  };
}

const listings = new Map<string, FixtureListing>();
const chairPhotos = [photo("ph101", 200, 30, 30), photo("ph102", 30, 200, 30), photo("ph103", 30, 30, 200)];
const gamePhotos = [photo("ph201", 230, 160, 20), photo("ph202", 140, 40, 180)];
listings.set("700001", {
  id: "700001",
  title: "Vintage Wooden Chair",
  price: "45",
  description: "Solid oak chair, sturdy and clean. Pickup in San Diego.",
  category: "Furniture",
  condition: "Used - Good",
  location: "San Diego, California",
  photos: chairPhotos,
  state: "live",
});
listings.set("700002", {
  id: "700002",
  title: "Board Game Bundle",
  price: "25",
  description: "Three family board games, complete sets.",
  category: "Toys & Games",
  condition: "Used - Like New",
  location: "San Diego, California",
  photos: gamePhotos,
  state: "live",
});

let deleteConfirmClicks = 0;
let nextListingSerial = 700003;

const photoBytesByUrl = new Map<string, Buffer>();
for (const listing of listings.values()) {
  for (const entry of listing.photos) {
    photoBytesByUrl.set(entry.largeUrl, entry.bytes);
    photoBytesByUrl.set(entry.smallUrl, entry.bytes);
  }
}

function liveListings(): FixtureListing[] {
  return [...listings.values()].filter((listing) => listing.state !== "deleted");
}

function payloadJson(listing: FixtureListing): string {
  return JSON.stringify({
    data: {
      marketplace_listing: {
        listing_photos: listing.photos.map((entry) => ({
          id: entry.id,
          image: { uri: entry.largeUrl, width: 960, height: 960 },
          image_versions: [{ uri: entry.smallUrl, width: 120, height: 120 }],
        })),
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Fixture pages (served by route fulfilment at real facebook.com URLs)

const LOGIN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Log in</title></head>
<body style="margin:0;font-family:sans-serif;background:#fff">
  <h1 style="position:absolute;top:40px;left:20px;font-size:20px">Log in</h1>
  <input id="email" type="email" name="email" autocomplete="username"
    style="position:absolute;top:120px;left:20px;width:350px;height:44px;font-size:16px">
  <input id="pass" type="password" name="pass" autocomplete="current-password"
    style="position:absolute;top:220px;left:20px;width:350px;height:44px;font-size:16px">
  <button id="loginBtn" type="button"
    style="position:absolute;top:300px;left:20px;width:350px;height:44px;font-size:16px">Log in</button>
  <script>
    document.getElementById("loginBtn").addEventListener("click", async () => {
      await fetch("${FB}/fixture-login", { method: "POST" });
      const expiry = new Date(Date.now() + 365 * 24 * 3600 * 1000).toUTCString();
      document.cookie = "c_user=4242424242; path=/; expires=" + expiry;
      document.cookie = "xs=fixture-xs-token; path=/; expires=" + expiry;
      location.href = "${FB}/marketplace/you/selling";
    });
  </script>
</body></html>`;

function sellingHtml(): string {
  const live = liveListings();
  const cards = live
    .map(
      (listing) => `  <div class="card">
    <a href="${FB}/marketplace/item/${listing.id}" aria-label="${listing.title}"><img src="${listing.photos[0]?.smallUrl ?? ""}" width="100" height="100"></a>
    <div>${listing.title}</div>
    <div>$${listing.price}</div>
    <div>Active · Listed on 11/9</div>
  </div>`,
    )
    .join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Your listings</title></head>
<body style="margin:0;font-family:sans-serif">
<div role="main">
  <h1>Your listings</h1>
  <div>${live.length} listings</div>
${cards}
</div>
</body></html>`;
}

function detailHtml(listing: FixtureListing): string {
  if (listing.state === "deleted") {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>Listing</title></head>
<body><div role="main">
  <h1>This content is no longer available</h1>
  <p>The listing you are looking for has been removed.</p>
</div></body></html>`;
  }
  const review =
    listing.state === "in_review"
      ? `<div>Your listing is in review. We will let you know when it is live.</div>`
      : "";
  const sellerButtons =
    listing.state === "live"
      ? `<button type="button">Mark as sold</button>
  <button type="button">Edit listing</button>
  <button type="button" id="deleteBtn">Delete listing</button>
  <script>
    document.getElementById("deleteBtn").addEventListener("click", () => {
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      dialog.innerHTML = '<p>Delete this listing?</p><button type="button" id="confirmDelete">Delete</button>';
      document.body.appendChild(dialog);
      document.getElementById("confirmDelete").addEventListener("click", async () => {
        await fetch("${FB}/fixture-delete/${listing.id}", { method: "POST" });
        location.href = "${FB}/marketplace/you/selling";
      });
    });
  </script>`
      : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${listing.title}</title></head>
<body><div role="main">
  <h1>${listing.title}</h1>
  <div>$${listing.price}</div>
  <div role="group" aria-label="Listing photos"><span>${listing.photos.length} photos, 0 videos</span></div>
  <p>${listing.description}</p>
  ${review}
  ${sellerButtons}
  <div class="details">
    <h2>Details</h2>
    <div>Condition</div>
    <div>${listing.condition}</div>
    <div>Category</div>
    <div>${listing.category}</div>
  </div>
  <script type="application/json">${payloadJson(listing)}</script>
</div></body></html>`;
}

function editHtml(listing: FixtureListing): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Edit listing</title></head>
<body><div role="main">
  <div id="step1">
    <input type="text" aria-label="Title" value="${listing.title}">
    <input type="text" aria-label="Price" value="${listing.price}">
    <textarea aria-label="Description">${listing.description}</textarea>
    <select aria-label="Category">
      <option${listing.category === "Furniture" ? " selected" : ""}>Furniture</option>
      <option${listing.category === "Toys & Games" ? " selected" : ""}>Toys &amp; Games</option>
    </select>
    <select aria-label="Condition">
      <option${listing.condition === "New" ? " selected" : ""}>New</option>
      <option${listing.condition === "Used - Like New" ? " selected" : ""}>Used - Like New</option>
      <option${listing.condition === "Used - Good" ? " selected" : ""}>Used - Good</option>
      <option${listing.condition === "Used - Fair" ? " selected" : ""}>Used - Fair</option>
    </select>
    <button type="button" id="nextBtn">Next</button>
  </div>
  <template id="step2tpl">
    <div id="step2">
      <input type="text" aria-label="Location" value="${listing.location}">
      <select aria-label="Delivery">
        <option selected>Local pickup</option>
        <option>Shipping</option>
      </select>
      <label>Shipping <input type="checkbox"></label>
      <label>Public meetup <input type="checkbox" checked></label>
      <label>Door pickup <input type="checkbox" checked></label>
      <label>Door dropoff <input type="checkbox"></label>
    </div>
  </template>
  <script>
    document.getElementById("nextBtn").addEventListener("click", () => {
      document.getElementById("step1").remove();
      const tpl = document.getElementById("step2tpl");
      document.querySelector('[role="main"]').appendChild(tpl.content.cloneNode(true));
    });
  </script>
</div></body></html>`;
}

function createHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Create listing</title></head>
<body><div role="main">
  <div id="step1">
    <section aria-label="Photos">
      <input type="file" accept="image/*" multiple id="fileInput">
      <div id="thumbs"></div>
    </section>
    <input type="text" aria-label="Title" value="">
    <input type="text" aria-label="Price" value="">
    <textarea aria-label="Description"></textarea>
    <button type="button" id="catBtn">Category</button>
    <div id="catOptions">
      <button type="button">Furniture</button>
      <button type="button">Toys &amp; Games</button>
    </div>
    <div id="condOptions">
      <button type="button">New</button>
      <button type="button">Used - Like New</button>
      <button type="button">Used - Good</button>
      <button type="button">Used - Fair</button>
    </div>
    <button type="button" id="nextBtn">Next</button>
  </div>
  <template id="step2tpl">
    <div id="step2">
      <input type="text" aria-label="Location" value="">
      <button type="button">Local pickup</button>
      <label>Public meetup <input type="checkbox" id="cbPublic"></label>
      <label>Door pickup <input type="checkbox" id="cbPickup"></label>
      <label>Door dropoff <input type="checkbox" id="cbDropoff"></label>
      <button type="button" id="publishBtn">Publish</button>
    </div>
  </template>
  <script>
    document.getElementById("fileInput").addEventListener("change", (event) => {
      const thumbs = document.getElementById("thumbs");
      thumbs.innerHTML = "";
      for (const file of event.target.files) {
        const img = document.createElement("img");
        img.src = URL.createObjectURL(file);
        img.width = 64;
        img.height = 64;
        thumbs.appendChild(img);
      }
    });
    document.getElementById("nextBtn").addEventListener("click", () => {
      document.getElementById("step1").remove();
      const tpl = document.getElementById("step2tpl");
      document.querySelector('[role="main"]').appendChild(tpl.content.cloneNode(true));
      document.getElementById("publishBtn").addEventListener("click", async () => {
        const res = await fetch("${FB}/fixture-publish", { method: "POST" });
        const body = await res.json();
        location.href = "${FB}/marketplace/item/" + body.id;
      });
    });
  </script>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Fixture launcher: the production launcher's wrapping, plus route
// fulfilment of facebook.com from the fixture state above.

type RawContext = Awaited<ReturnType<typeof import("playwright").chromium.launchPersistentContext>>;
type RawPage = ReturnType<RawContext["pages"]>[number];
type RawRoute = Parameters<Parameters<RawContext["route"]>[1]>[0];

async function fulfillHtml(route: RawRoute, html: string): Promise<void> {
  await route.fulfill({ status: 200, contentType: "text/html", body: html });
}

async function installFixtureRoutes(rawContext: RawContext): Promise<void> {
  await rawContext.route("https://www.facebook.com/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === "/fixture-login") {
      const expires = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
      await rawContext.addCookies([
        { name: "c_user", value: "4242424242", domain: ".facebook.com", path: "/", expires },
        { name: "xs", value: "fixture-xs-token", domain: ".facebook.com", path: "/", expires },
      ]);
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }
    if (pathname.startsWith("/fixture-delete/")) {
      const id = pathname.split("/").pop() ?? "";
      const target = listings.get(id);
      if (target) {
        target.state = "deleted";
        deleteConfirmClicks += 1;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }
    if (pathname === "/fixture-publish") {
      const source = listings.get("700001");
      const id = String(nextListingSerial);
      nextListingSerial += 1;
      if (source) {
        listings.set(id, { ...source, id, state: "in_review" });
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id }),
      });
      return;
    }
    if (pathname.startsWith("/login")) {
      await fulfillHtml(route, LOGIN_HTML);
      return;
    }
    if (pathname === "/marketplace/you/selling") {
      await fulfillHtml(route, sellingHtml());
      return;
    }
    if (pathname.startsWith("/marketplace/item/")) {
      const id = pathname.split("/").pop() ?? "";
      const listing = listings.get(id);
      await fulfillHtml(
        route,
        listing
          ? detailHtml(listing)
          : detailHtml({
              id,
              title: "Gone",
              price: "0",
              description: "",
              category: "",
              condition: "",
              location: "",
              photos: [],
              state: "deleted",
            }),
      );
      return;
    }
    if (pathname.startsWith("/marketplace/edit/")) {
      const id = pathname.split("/").pop() ?? "";
      const listing = listings.get(id);
      await fulfillHtml(route, listing ? editHtml(listing) : LOGIN_HTML);
      return;
    }
    if (pathname === "/marketplace/create/item") {
      await fulfillHtml(route, createHtml());
      return;
    }
    await fulfillHtml(
      route,
      `<!doctype html><html><body><div role="main"><h1>Facebook</h1></div></body></html>`,
    );
  });
}

function wrapRawContext(rawContext: RawContext): { context: ContextLike } {
  const pageCache = new WeakMap<object, PageLike>();
  const wrapPage = (rawPage: RawPage): PageLike => {
    const cached = pageCache.get(rawPage);
    if (cached) {
      return cached;
    }
    let cdpPromise: Promise<never> | undefined;
    const wrapped: PageLike = {
      url: () => rawPage.url(),
      goto: (url) => rawPage.goto(url),
      screenshot: (options) => rawPage.screenshot(options),
      mouse: rawPage.mouse,
      keyboard: rawPage.keyboard,
      evaluate: (expression) => rawPage.evaluate(expression),
      viewportSize: () => rawPage.viewportSize(),
      close: () => rawPage.close(),
      cdp: () => {
        cdpPromise ??= rawContext.newCDPSession(rawPage).then((raw) => ({
          send: (method: string, params?: Record<string, unknown>) => raw.send(method, params),
          on: (event: string, callback: (params: unknown) => void) => {
            raw.on(event, callback as (params: never) => void);
          },
          off: (event: string, callback: (params: unknown) => void) => {
            if (raw.off) {
              raw.off(event, callback as (params: never) => void);
            } else if (raw.removeListener) {
              raw.removeListener(event, callback as (params: never) => void);
            }
          },
          detach: () => raw.detach(),
        })) as Promise<never>;
        return cdpPromise;
      },
    } as PageLike;
    if (typeof rawPage.setInputFiles === "function") {
      (wrapped as { setInputFiles?: unknown }).setInputFiles = (
        selector: string,
        files: string[],
      ) => rawPage.setInputFiles(selector, files);
    }
    pageCache.set(rawPage, wrapped);
    return wrapped;
  };
  const context: ContextLike = {
    cookies: (url) => rawContext.cookies(url),
    clearCookies: () => rawContext.clearCookies(),
    close: () => rawContext.close(),
    pages: () => rawContext.pages().map(wrapPage),
    newPage: async () => wrapPage(await rawContext.newPage()),
    onPage: (callback) => {
      rawContext.on("page", (rawPage) => callback(wrapPage(rawPage)));
    },
  };
  return { context };
}

const fixtureLauncher: BrowserLauncher = async (profileDir: string): Promise<BrowserHandle> => {
  const { chromium } = await import("playwright");
  const rawContext = await chromium.launchPersistentContext(
    profileDir,
    buildLaunchOptions({}),
  );
  await installFixtureRoutes(rawContext);
  const existing = rawContext.pages()[0] ?? (await rawContext.newPage());
  existing.setDefaultNavigationTimeout(60000);
  const { context } = wrapRawContext(rawContext);
  const page = context.pages()[0];
  return { context, page };
};

// ---------------------------------------------------------------------------
// View socket helper (same protocol the PWA speaks)

interface View {
  ws: WebSocket;
  frames: number;
  messages: Array<Record<string, unknown>>;
  waitFor: (pred: (m: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
  waitFrames: (n: number, timeoutMs?: number) => Promise<void>;
  send: (m: Record<string, unknown>) => void;
  close: () => void;
}

function openView(cookie: string): Promise<View> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${APP_PORT}/api/facebook/view`, {
      headers: { Cookie: cookie, Origin: ORIGIN },
    });
    const view: View = {
      ws,
      frames: 0,
      messages: [],
      send: (m) => ws.send(JSON.stringify(m)),
      close: () => ws.close(),
      waitFor: (pred, timeoutMs = 15000) =>
        new Promise((res, rej) => {
          const existing = view.messages.find(pred);
          if (existing) return res(existing);
          const started = Date.now();
          const timer = setInterval(() => {
            const found = view.messages.find(pred);
            if (found) {
              clearInterval(timer);
              res(found);
            } else if (Date.now() - started > timeoutMs) {
              clearInterval(timer);
              rej(new Error("waitFor timed out"));
            }
          }, 25);
        }),
      waitFrames: (n, timeoutMs = 15000) =>
        new Promise((res, rej) => {
          const started = Date.now();
          const timer = setInterval(() => {
            if (view.frames >= n) {
              clearInterval(timer);
              res();
            } else if (Date.now() - started > timeoutMs) {
              clearInterval(timer);
              rej(new Error(`waitFrames timed out (got ${view.frames})`));
            }
          }, 25);
        }),
    };
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        view.frames += 1;
        return;
      }
      try {
        view.messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch {
        // Non-JSON frames are ignored by the client too.
      }
    });
    ws.on("open", () => resolve(view));
    ws.on("error", reject);
  });
}

// ---------------------------------------------------------------------------

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const EMAIL_TAP = { nx: 195 / 390, ny: 142 / 844 };
const PASS_TAP = { nx: 195 / 390, ny: 242 / 844 };
const LOGIN_TAP = { nx: 195 / 390, ny: 322 / 844 };

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "relist-blueprint-e2e-"));
  const config: Config = {
    port: APP_PORT,
    host: "127.0.0.1",
    dataDir,
    corsOrigin: ORIGIN,
    cookieSecure: false,
    browserIgnoreCertErrors: false,
    dryRun: true,
    jobPollIntervalMs: 15 * 60 * 1000,
    jobStuckAfterMs: 48 * 60 * 60 * 1000,
  };
  let parts: AppParts | null = null;
  try {
    parts = await buildApp({
      config,
      launcher: fixtureLauncher,
      downloader: async (url: string) => {
        const bytes = photoBytesByUrl.get(url);
        if (!bytes) {
          throw new Error(`CDN returned HTTP 404 for fixture url ${url}`);
        }
        return bytes;
      },
      jobOptions: { dryRun: false, pollIntervalMs: 100, stuckAfterMs: 48 * 60 * 60 * 1000 },
    });
    await parts.app.listen({ port: APP_PORT, host: "127.0.0.1" });
    console.log("backend listening (real Chromium, fixture facebook.com)");

    const api = async (
      method: string,
      pathName: string,
      cookie: string,
      body?: unknown,
    ): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> => {
      const response = await fetch(`${ORIGIN}${pathName}`, {
        method,
        headers: {
          Cookie: cookie,
          Origin: ORIGIN,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: response.status, json, headers: response.headers };
    };

    // -- Relist account ------------------------------------------------------
    const register = await fetch(`${ORIGIN}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ name: "E2E", email: "e2e@example.com", password: "e2e-password-1" }),
    });
    check("register", register.status === 201, `status ${register.status}`);
    const setCookie = register.headers.getSetCookie?.() ?? [];
    const cookie = setCookie.map((entry) => entry.split(";")[0]).join("; ");
    const me = (await (await fetch(`${ORIGIN}/api/auth/me`, { headers: { Cookie: cookie } })).json()) as {
      user: { id: string };
    };
    const userId = me.user.id;

    const before = await api("GET", "/api/facebook/status", cookie);
    check(
      "status before connect is not connected",
      (before.json as { status?: string }).status !== "connected",
      `status ${String((before.json as { status?: string }).status)}`,
    );

    // -- Login: full flow through the live view ------------------------------
    const connect = await api("POST", "/api/facebook/connect", cookie, {});
    check("connect starts login session", connect.status === 200, `status ${connect.status}`);
    const loginPage = parts.browser.getLoginPage(userId);
    check("login page target exists", Boolean(loginPage));
    if (!loginPage) throw new Error("no login page");

    const view = await openView(cookie);
    const welcome = await view.waitFor((m) => m.kind === "welcome");
    check("welcome received", typeof welcome.sessionId === "string");
    view.send({ kind: "resync", lastAck: 0, fingerprint: null });
    const resync0 = await view.waitFor((m) => m.kind === "resync_result");
    check("initial resync intact", resync0.verdict === "intact", `verdict ${String(resync0.verdict)}`);
    await view.waitFrames(1);
    check("screencast frames flow", view.frames >= 1, `${view.frames} frame(s)`);

    view.send({ kind: "tap", ...EMAIL_TAP });
    await view.waitFor((m) => m.kind === "focus" && m.fieldKind === "email");
    view.send({ kind: "op", seq: 1, op: { type: "insert", text: "qa@example.com" } });
    await view.waitFor((m) => m.kind === "ack" && m.seq === 1);
    const emailValue = await loginPage.evaluate("document.getElementById('email').value");
    check("email typed into Facebook's field", emailValue === "qa@example.com", `value=${String(emailValue)}`);

    view.send({ kind: "tap", ...PASS_TAP });
    await view.waitFor((m) => m.kind === "focus" && m.fieldKind === "password");
    // ONE bulk insert op — the paste/AutoFill path.
    view.send({ kind: "op", seq: 2, op: { type: "insert", text: "S3cretXYZ!" } });
    await view.waitFor((m) => m.kind === "ack" && m.seq === 2);
    const passValue = await loginPage.evaluate("document.getElementById('pass').value");
    check("paste lands as one bulk insert", passValue === "S3cretXYZ!", `value=${String(passValue)}`);

    view.send({ kind: "tap", ...LOGIN_TAP });
    const settled = await view.waitFor(
      (m) => m.kind === "state" && m.state === "connected",
      120000,
    );
    check("login settles to connected (§6 ceremony)", settled.state === "connected");
    view.close();

    const statusAfter = await api("GET", "/api/facebook/status", cookie);
    check(
      "status route reports connected",
      (statusAfter.json as { status?: string }).status === "connected",
      `status ${String((statusAfter.json as { status?: string }).status)}`,
    );
    check(
      "status response is no-store",
      (statusAfter.headers.get("cache-control") ?? "").includes("no-store"),
      `cache-control ${statusAfter.headers.get("cache-control") ?? "(none)"}`,
    );

    // -- Listings sync ---------------------------------------------------------
    const sync = await api("POST", "/api/listings/sync", cookie, {});
    check("sync succeeds", sync.status === 200, `status ${sync.status}`);
    const listResponse = await api("GET", "/api/listings", cookie);
    const synced = (listResponse.json.listings ?? []) as Array<{
      id: string;
      title: string;
      status: string;
    }>;
    check("two listings enumerated", synced.length === 2, `got ${synced.length}`);
    const chair = synced.find((entry) => entry.id === "700001");
    check(
      "chair synced with title + Available status",
      chair?.title === "Vintage Wooden Chair" && chair?.status === "Available",
      chair ? `${chair.title} / ${chair.status}` : "missing",
    );

    // -- Clone recovery into the vault -----------------------------------------
    const recover = await api("POST", "/api/listings/700001/clone/recover", cookie, {});
    check("clone recovery succeeds", recover.status === 200, `status ${recover.status}`);
    const clone = (recover.json.clone ?? {}) as {
      recovery?: {
        category?: { value?: string | null };
        condition?: { value?: string | null };
        location?: { value?: string | null };
        photos?: {
          files?: string[];
          vault?: Array<{
            position: number;
            sha256: string;
            contentType: string;
            width: number;
            height: number;
            bytes: number;
          } | null>;
        };
      };
    };
    const recovery = clone.recovery ?? {};
    check("category recovered from stored value", recovery.category?.value === "Furniture", String(recovery.category?.value));
    check("condition recovered", recovery.condition?.value === "Used - Good", String(recovery.condition?.value));
    check("location recovered", recovery.location?.value === "San Diego, California", String(recovery.location?.value));
    const vault = recovery.photos?.vault ?? [];
    check("vault holds all 3 photos", vault.length === 3 && vault.every(Boolean), `entries ${vault.length}`);
    const expectedHashes = chairPhotos.map((entry) =>
      sha256Of("sha256").update(entry.bytes).digest("hex"),
    );
    check(
      "vault sha256 matches photo bytes, in order",
      vault.every((entry, index) => entry?.sha256 === expectedHashes[index]),
    );
    check(
      "vault records type/dimensions/bytes",
      vault.every(
        (entry, index) =>
          entry?.contentType === "image/png" &&
          entry?.width === 64 &&
          entry?.height === 64 &&
          entry?.bytes === chairPhotos[index].bytes.length &&
          entry?.position === index,
      ),
    );

    // -- Recreate job: create -> gated watch -> delete --------------------------
    const jobCreate = await api("POST", "/api/listings/700001/jobs", cookie, {});
    const job = (jobCreate.json.job ?? {}) as { id?: string };
    check("job created", jobCreate.status === 201 || jobCreate.status === 200, `status ${jobCreate.status}`);
    if (!job.id) throw new Error("no job id");
    const jobId = job.id;

    const driveJob = async (maxMs: number): Promise<string> => {
      const started = Date.now();
      let status = "";
      let lastLog = 0;
      while (Date.now() - started < maxMs) {
        const current = await parts!.jobs.processJob(userId, jobId);
        status = current?.status ?? status;
        if (Date.now() - lastLog > 10000) {
          lastLog = Date.now();
          const audit = (current?.audit ?? []).slice(-3).map((entry) => `${entry.action}: ${entry.detail}`);
          console.log(`  [job ${status}] ${audit.join(" | ")}`);
        }
        if (status === "done" || status === "failed" || status === "stuck" || status === "needs_input") {
          break;
        }
        await sleep(150);
      }
      return status;
    };

    const afterCreate = await driveJob(120000);
    const created = listings.get("700003");
    check(
      "new listing created on fixture Facebook (in review)",
      Boolean(created) && created?.state === "in_review",
      `job status ${afterCreate}`,
    );
    check(
      "job recorded the new listing id",
      parts.jobs.getJob(userId, jobId)?.newListingId === "700003",
      `newListingId ${parts.jobs.getJob(userId, jobId)?.newListingId ?? "(none)"}`,
    );

    // Delete gating: while the copy is in review, no delete may happen.
    await driveJob(3000);
    const gatedJob = parts.jobs.getJob(userId, jobId);
    check(
      "job waits in review (delete gated)",
      gatedJob?.status === "in_review",
      `status ${gatedJob?.status ?? "(none)"}`,
    );
    check(
      "old listing untouched while in review",
      listings.get("700001")?.state === "live" && deleteConfirmClicks === 0,
      `delete clicks ${deleteConfirmClicks}`,
    );

    // Facebook approves the copy: the job may now verify + delete.
    if (created) {
      created.state = "live";
    }
    const finalStatus = await driveJob(120000);
    check("job completes", finalStatus === "done", `status ${finalStatus}`);
    check(
      "old listing deleted only after verification",
      listings.get("700001")?.state === "deleted" && deleteConfirmClicks === 1,
      `delete clicks ${deleteConfirmClicks}`,
    );
    const remaining = liveListings().map((entry) => entry.id).sort();
    check(
      "selling list ends with the copy + the other listing",
      JSON.stringify(remaining) === JSON.stringify(["700002", "700003"]),
      remaining.join(","),
    );
    const auditKinds = (parts.jobs.getJob(userId, jobId)?.audit ?? []).map((entry) => entry.action);
    console.log(`job audit: ${auditKinds.join(" -> ")}`);
  } finally {
    if (parts) {
      await parts.browser.closeAll().catch(() => undefined);
      await parts.app.close().catch(() => undefined);
    }
    await rm(dataDir, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "E2E RESULT: ALL CHECKS PASSED" : `E2E RESULT: ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
