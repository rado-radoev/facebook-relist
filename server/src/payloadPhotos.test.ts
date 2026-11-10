import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { SNAPSHOT_SCRIPT, type PageSnapshot } from "./snapshot.js";
import { effectiveGallery, parseGallery, parseGallerySlots } from "./facebookExtract.js";

function collect(html: string, url = "https://www.facebook.com/marketplace/item/123") {
  const dom = new JSDOM(html, {
    url,
    runScripts: "outside-only",
    beforeParse(window) {
      Object.defineProperty(window.document, "readyState", { configurable: true, value: "complete" });
    },
  });
  try {
    return dom.window.eval(SNAPSHOT_SCRIPT) as Record<string, any>;
  } finally {
    dom.window.close();
  }
}

function jsonScript(value: unknown): string {
  return `<script type="application/json">${JSON.stringify(value).replace(/</g, "\\u003c")}</script>`;
}

const baseSnapshot: PageSnapshot = {
  url: "https://www.facebook.com/marketplace/item/123",
  text: "Item",
  images: ["https://cdn.fixture.local/dom/photo-dom.jpg"],
  videos: [],
  surface: { kind: "listing", listingId: "123", readiness: "ready" },
  gallery: {
    state: "complete",
    expectedCount: 1,
    observedCount: 1,
    videoPresence: "absent",
    slots: [{ identity: "dom-1", url: "https://cdn.fixture.local/dom/photo-dom.jpg" }],
  },
};

describe("parseGallery — payload-first", () => {
  it("returns payload URLs in payload order, ignoring DOM images", () => {
    const snapshot: PageSnapshot = {
      ...baseSnapshot,
      payloadPhotos: [
        { id: "p1", url: "https://cdn.fixture.local/payload/1-large.jpg", width: 1600, height: 1200 },
        { id: "p2", url: "https://cdn.fixture.local/payload/2-large.jpg", width: 1024, height: 768 },
        { url: "https://cdn.fixture.local/payload/3-large.jpg?fbid=fbid-3", width: 800, height: 600 },
      ],
    };
    expect(parseGallery(snapshot)).toEqual([
      "https://cdn.fixture.local/payload/1-large.jpg",
      "https://cdn.fixture.local/payload/2-large.jpg",
      "https://cdn.fixture.local/payload/3-large.jpg?fbid=fbid-3",
    ]);
    // Identities derive from payload id, falling back to the URL fbid.
    expect(parseGallerySlots(snapshot)).toEqual([
      { identity: "p1", url: "https://cdn.fixture.local/payload/1-large.jpg" },
      { identity: "p2", url: "https://cdn.fixture.local/payload/2-large.jpg" },
      { identity: "fbid-3", url: "https://cdn.fixture.local/payload/3-large.jpg?fbid=fbid-3" },
    ]);
    // Payload present establishes completeness from the payload itself.
    expect(effectiveGallery(snapshot)).toMatchObject({
      state: "complete",
      expectedCount: 3,
      observedCount: 3,
    });
  });

  it("payloadPhotos [] means zero photos but opened — distinguishable from null", () => {
    const emptyPayload: PageSnapshot = { ...baseSnapshot, payloadPhotos: [] };
    expect(parseGallery(emptyPayload)).toEqual([]);
    expect(parseGallerySlots(emptyPayload)).toEqual([]);
    expect(effectiveGallery(emptyPayload)).toMatchObject({
      state: "complete",
      expectedCount: 0,
      observedCount: 0,
    });

    const nullPayload: PageSnapshot = { ...baseSnapshot, payloadPhotos: null };
    expect(parseGallery(nullPayload)).toEqual(["https://cdn.fixture.local/dom/photo-dom.jpg"]);
    expect(effectiveGallery(nullPayload)).toBe(baseSnapshot.gallery);
  });

  it("payloadPhotos null keeps the existing DOM-slot behavior exactly", () => {
    const snapshot: PageSnapshot = { ...baseSnapshot, payloadPhotos: null };
    expect(parseGallery(snapshot)).toEqual(["https://cdn.fixture.local/dom/photo-dom.jpg"]);

    const noSlots: PageSnapshot = {
      ...baseSnapshot,
      payloadPhotos: null,
      gallery: undefined,
      images: [
        "https://cdn.fixture.local/dom/a.jpg",
        "https://cdn.fixture.local/dom/a.jpg",
        "https://cdn.fixture.local/dom/b.jpg",
      ],
    };
    expect(parseGallery(noSlots)).toEqual([
      "https://cdn.fixture.local/dom/a.jpg",
      "https://cdn.fixture.local/dom/b.jpg",
    ]);
  });
});

describe("SNAPSHOT_SCRIPT — Relay/SSR payload harvest", () => {
  it("normalizes listing_photos variants to the highest resolution, in payload order, and never harvests a sidebar ad", () => {
    const payload = {
      data: {
        listing: {
          listing_photos: [
            {
              id: "photo-1",
              image_versions: [
                { uri: "https://scontent.fixture.local/1-small.jpg", width: 100, height: 100 },
                { uri: "https://scontent.fixture.local/1-large.jpg", width: 1600, height: 1200 },
                { uri: "https://scontent.fixture.local/1-med.jpg", width: 800, height: 600 },
              ],
            },
            { id: "photo-2", image: { uri: "https://scontent.fixture.local/2-only.jpg", width: 1024, height: 768 } },
            { id: "photo-3", uri: "https://scontent.fixture.local/3-direct.jpg", width: 640, height: 480 },
            {
              id: "photo-4",
              image_versions: [
                { uri: "https://scontent.fixture.local/4-a.jpg", height: 200 },
                { uri: "https://scontent.fixture.local/4-b.jpg", height: 900 },
              ],
            },
          ],
        },
      },
    };
    const snapshot = collect(`<!doctype html><html><head>
      ${jsonScript(payload)}
      <script type="application/json">{not valid json</script>
      </head><body>
      <aside><img src="https://scontent.fixture.local/sidebar-ad.jpg" alt="Advertisement"></aside>
      <main role="main">
        <section role="group" aria-label="Photo gallery, 1 of 1">
          <img data-media-id="dom-1" src="https://scontent.fixture.local/dom-only.jpg">
        </section>
      </main>
    </body></html>`);

    expect(snapshot.payloadPhotos).toEqual([
      { id: "photo-1", url: "https://scontent.fixture.local/1-large.jpg", width: 1600, height: 1200 },
      { id: "photo-2", url: "https://scontent.fixture.local/2-only.jpg", width: 1024, height: 768 },
      { id: "photo-3", url: "https://scontent.fixture.local/3-direct.jpg", width: 640, height: 480 },
      { id: "photo-4", url: "https://scontent.fixture.local/4-b.jpg", height: 900 },
    ]);
    // Payload wins for images/gallery, and the sidebar ad (same CDN)
    // appears in neither payloadPhotos nor images.
    expect(snapshot.images).toEqual([
      "https://scontent.fixture.local/1-large.jpg",
      "https://scontent.fixture.local/2-only.jpg",
      "https://scontent.fixture.local/3-direct.jpg",
      "https://scontent.fixture.local/4-b.jpg",
    ]);
    expect(snapshot.images).not.toContain("https://scontent.fixture.local/sidebar-ad.jpg");
    expect(JSON.stringify(snapshot.payloadPhotos)).not.toContain("sidebar-ad");
    expect(snapshot.gallery).toMatchObject({ state: "complete", expectedCount: 4, observedCount: 4 });
    expect(snapshot.gallery.slots.map((slot: { identity: string }) => slot.identity)).toEqual([
      "photo-1",
      "photo-2",
      "photo-3",
      "photo-4",
    ]);
  });

  it("distinguishes an empty listing_photos array ([]) from no payload at all (null)", () => {
    const empty = collect(`<!doctype html><html><head>${jsonScript({ listing_photos: [] })}</head><body><main role="main"><h1>Item</h1></main></body></html>`);
    expect(empty.payloadPhotos).toEqual([]);
    expect(empty.gallery).toMatchObject({ state: "complete", expectedCount: 0, observedCount: 0 });

    const none = collect(`<!doctype html><html><body><main role="main"><h1>Item</h1></main></body></html>`);
    expect(none.payloadPhotos).toBeNull();
  });

  it("DOM fallback prefers Product-photo imgs in the gallery/main region and never harvests outside it", () => {
    const snapshot = collect(`<!doctype html><html><body>
      <aside><img src="https://scontent.fixture.local/sidebar-ad.jpg" alt="Product photo of an ad outside the listing"></aside>
      <main role="main">
        <section role="group" aria-label="Photo gallery, 2 of 2">
          <img data-media-id="real-1" alt="Product photo of Widget" src="https://cdn.fixture.local/real-1.jpg">
          <img data-media-id="real-2" alt="Product photo of Widget" src="https://cdn.fixture.local/real-2.jpg">
          <img data-media-id="decoration" alt="Decorative" src="https://cdn.fixture.local/decoration.jpg">
        </section>
      </main>
    </body></html>`);
    expect(snapshot.payloadPhotos).toBeNull();
    expect(snapshot.images).toEqual([
      "https://cdn.fixture.local/real-1.jpg",
      "https://cdn.fixture.local/real-2.jpg",
    ]);
  });

  it("DOM fallback uses gallery imgs when no Product-photo alt exists, still scoped to the gallery", () => {
    const snapshot = collect(`<!doctype html><html><body>
      <img src="https://scontent.fixture.local/outside.jpg">
      <main role="main">
        <section role="group" aria-label="Photo gallery, 2 of 2">
          <img data-media-id="a" src="https://cdn.fixture.local/a.jpg">
          <img data-media-id="b" src="https://cdn.fixture.local/b.jpg">
        </section>
      </main>
    </body></html>`);
    expect(snapshot.images).toEqual([
      "https://cdn.fixture.local/a.jpg",
      "https://cdn.fixture.local/b.jpg",
    ]);
    expect(snapshot.gallery).toMatchObject({ state: "complete", expectedCount: 2, observedCount: 2 });
  });

  it("DOM fallback scopes to [role=main] Product-photo imgs when there is no gallery node", () => {
    const snapshot = collect(`<!doctype html><html><body>
      <aside><img src="https://scontent.fixture.local/sidebar-ad.jpg"></aside>
      <main role="main">
        <img alt="Product photo of Widget" data-media-id="main-1" src="https://cdn.fixture.local/main-1.jpg">
        <img alt="Unrelated" src="https://cdn.fixture.local/unrelated.jpg">
      </main>
    </body></html>`);
    expect(snapshot.images).toEqual(["https://cdn.fixture.local/main-1.jpg"]);
  });
});
