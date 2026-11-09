import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { SNAPSHOT_SCRIPT } from "./snapshot.js";

function collect(html: string, url = "https://www.facebook.com/marketplace/edit/123") {
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

describe("snapshot collector form controls", () => {
  it("captures native and closed combobox values, wrapped labels and safe text without passwords", () => {
    const snapshot = collect(`<!doctype html><html><body><main role="main">
      <form>
        <label>Title <input value="Synthetic item"></label>
        <label for="category">Category</label><select id="category"><option>Other</option><option selected>Home Goods</option></select>
        <span id="delivery-label">Delivery</span><span id="delivery-kind">Type</span><div role="combobox" aria-labelledby="delivery-label delivery-kind" aria-expanded="false">Local pickup</div>
        <div role="checkbox" aria-label="Public meetup" aria-checked="true"></div>
        <label><input type="checkbox" checked> Shipping</label>
        <label for="color">Color</label><select id="color"><option selected>Green</option></select>
        <input type="password" value="must-not-escape">
        <div contenteditable="true" aria-label="Description">Description text</div>
      </form>
    </main></body></html>`);

    expect(snapshot.form.inputs).toContainEqual({ label: "Title", value: "Synthetic item" });
    expect(snapshot.form.inputs).toContainEqual({ label: "Description", value: "Description text" });
    expect(snapshot.form.inputs.some((field: { value: string }) => field.value.includes("must-not-escape"))).toBe(false);
    expect(snapshot.form.selects).toContainEqual({ label: "Category", value: "Home Goods" });
    expect(snapshot.form.selects).toContainEqual({ label: "Delivery Type", value: "Local pickup" });
    expect(snapshot.form.selects).toContainEqual({ label: "Color", value: "Green" });
    expect(snapshot.form.checkboxes).toContainEqual({ label: "Public meetup", checked: true });
    expect(snapshot.form.checkboxes).toContainEqual({ label: "Shipping", checked: true });
    expect(snapshot.surface).toEqual({ kind: "edit_form", listingId: "123", readiness: "ready" });
    expect(snapshot.form.attributesObserved).toBe(true);
  });

  it("scopes ordered media and selling cards to their explicit surfaces and requires positive counts", () => {
    const snapshot = collect(`<!doctype html><html><body>
      <img src="https://cdn.fixture.local/avatar.jpg">
      <main role="main">
        <section role="group" aria-label="Photo gallery, 2 of 2">
          <img data-media-id="photo-a" src="https://cdn.fixture.local/photo-a.jpg">
          <img data-media-id="photo-b" src="https://cdn.fixture.local/photo-b.jpg">
          <video poster="https://cdn.fixture.local/video-poster.jpg"></video>
        </section>
      </main>
    </body></html>`, "https://www.facebook.com/marketplace/item/123");
    expect(snapshot.surface).toMatchObject({ kind: "listing", listingId: "123", readiness: "ready" });
    expect(snapshot.images).toEqual([
      "https://cdn.fixture.local/photo-a.jpg",
      "https://cdn.fixture.local/photo-b.jpg",
    ]);
    expect(snapshot.gallery).toMatchObject({ state: "complete", expectedCount: 2, observedCount: 2, videoPresence: "unknown" });
    expect(snapshot.sellingCards).toEqual([]);
    expect(snapshot.completion.state).toBe("unknown");
  });

  it("marks login/checkpoint surfaces instead of reporting page readiness", () => {
    const snapshot = collect(`<!doctype html><html><body><main role="main">Confirm your identity</main></body></html>`);
    expect(snapshot.surface.readiness).toBe("checkpoint");
  });

  it("does not collect a recommendation Details section outside the listing main surface", () => {
    const snapshot = collect(`<!doctype html><html><body>
      <section><div><h2>Details</h2><div><span>Condition</span><span>New</span></div></div></section>
      <main role="main"><h1>Item</h1></main>
    </body></html>`, "https://www.facebook.com/marketplace/item/123");
    expect(snapshot.detailRows).toEqual([]);
  });
});
