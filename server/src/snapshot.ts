// Page snapshots: the contract between the backend browser and the pure
// extraction logic.
//
// The browser side runs ONE collector script (SNAPSHOT_SCRIPT below) via
// page.evaluate and returns a PageSnapshot — raw, structured observations
// of the page (visible text, image/video URLs, selling-list cards, the
// listing page's Details rows, and the edit form's current state). All
// interpretation — which field a value belongs to, what is missing and
// why — lives in facebookExtract.ts as pure functions over this shape,
// so the mapping logic is unit-testable against saved fixture snapshots
// (see src/fixtures/) without a browser.
//
// Honesty note: the collector script's DOM selectors are written from the
// verified spike observations (requirements §4-C) but are themselves
// LIVE-UNVERIFIED — no real Facebook login exists in a backend profile
// yet. They get their first real run at the owner's first Connect
// (Sprint 4). The snapshot → data mapping is what the fixtures verify.

export interface SellingCard {
  /** Link to the listing, e.g. https://www.facebook.com/marketplace/item/123 */
  href: string;
  title: string;
  priceText: string;
  /** e.g. "Active · Listed on 10/11" or "Sold". */
  statusText: string;
  imageUrl: string;
}

export interface DetailRow {
  label: string;
  value: string;
}

export interface FormFieldState {
  label: string;
  value: string;
}

export interface FormToggleState {
  label: string;
  checked: boolean;
}

export interface FormButtonState {
  label: string;
  disabled: boolean;
}

export interface FormSnapshot {
  /** Labelled text inputs / textareas: Title, Price, Description, Location… */
  inputs: FormFieldState[];
  /** Labelled chosen values (category picker, condition selector…). */
  selects: FormFieldState[];
  checkboxes: FormToggleState[];
  switches: FormToggleState[];
  buttons: FormButtonState[];
}

export interface PageSnapshot {
  url: string;
  /** document.body.innerText — used for prompts and fallbacks. */
  text: string;
  /** Image URLs in DOM order (gallery order on a listing page). */
  images: string[];
  /** Video URLs the page exposes (video src / source src). */
  videos: string[];
  /** Present on the selling-list page. */
  sellingCards?: SellingCard[];
  /** Present on a listing page: its Details section as label/value rows. */
  detailRows?: DetailRow[];
  /** Present on the edit-listing pages. */
  form?: FormSnapshot;
}

export const SELLING_LIST_URL = "https://www.facebook.com/marketplace/you/selling";

export function listingPageUrl(listingId: string): string {
  return `https://www.facebook.com/marketplace/item/${listingId}`;
}

/**
 * The edit-listing page for a listing. LIVE-UNVERIFIED: this URL pattern
 * is the standard Marketplace edit route, but it has not yet been driven
 * by the backend browser against a real login (Sprint 4). If Facebook
 * serves a different route, only this constant changes — recovery treats
 * an edit page that yields no form as "edit form unavailable" and falls
 * back to the listing page, never to invented values.
 */
export function editListingUrl(listingId: string): string {
  return `https://www.facebook.com/marketplace/edit/${listingId}`;
}

/**
 * The in-page collector. Runs in Facebook's page via page.evaluate and
 * returns a PageSnapshot. Best-effort DOM work only: labelled form
 * controls, the Details rows, selling cards, media URLs, visible text.
 * It clicks nothing and submits nothing — read-only by construction.
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const text = document.body ? document.body.innerText : "";

  const images = [];
  const seenImages = new Set();
  for (const img of document.querySelectorAll("img")) {
    const src = img.currentSrc || img.src || "";
    if (src && !seenImages.has(src)) {
      seenImages.add(src);
      images.push(src);
    }
  }

  const videos = [];
  for (const video of document.querySelectorAll("video")) {
    const src = video.currentSrc || video.src || "";
    if (src) {
      videos.push(src);
    }
    for (const source of video.querySelectorAll("source")) {
      if (source.src) {
        videos.push(source.src);
      }
    }
  }

  const sellingCards = [];
  const seenCards = new Set();
  for (const link of document.querySelectorAll('a[href*="/marketplace/item/"]')) {
    const href = link.href || "";
    if (!href || seenCards.has(href)) {
      continue;
    }
    const card = link.closest("div");
    if (!card) {
      continue;
    }
    const cardText = (card.innerText || "").trim();
    const img = card.querySelector("img");
    seenCards.add(href);
    sellingCards.push({
      href,
      title: (link.getAttribute("aria-label") || cardText.split("\\n")[0] || "").trim(),
      priceText: (cardText.match(/\\$[0-9][0-9,]*(\\.[0-9]{2})?/) || [""])[0],
      statusText: cardText,
      imageUrl: img ? img.currentSrc || img.src || "" : "",
    });
  }

  const detailRows = [];
  const headings = document.querySelectorAll("h2, span");
  for (const heading of headings) {
    if ((heading.textContent || "").trim() !== "Details") {
      continue;
    }
    const section = heading.closest("div");
    if (!section) {
      continue;
    }
    const lines = (section.innerText || "")
      .split("\\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (let i = 1; i + 1 < lines.length + 1 && i < lines.length; i += 2) {
      if (i + 1 < lines.length) {
        detailRows.push({ label: lines[i], value: lines[i + 1] });
      }
    }
    break;
  }

  const labelFor = (el) => {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) {
        return (labelEl.textContent || "").trim();
      }
    }
    const aria = el.getAttribute("aria-label");
    if (aria) {
      return aria.trim();
    }
    if (el.id) {
      const byFor = document.querySelector('label[for="' + el.id + '"]');
      if (byFor) {
        return (byFor.textContent || "").trim();
      }
    }
    return "";
  };

  const inputs = [];
  for (const el of document.querySelectorAll("input, textarea")) {
    if (el.type === "checkbox" || el.type === "radio" || el.type === "hidden" || el.type === "password") {
      continue;
    }
    inputs.push({ label: labelFor(el), value: el.value || "" });
  }
  const selects = [];
  for (const el of document.querySelectorAll('[aria-selected="true"], [role="option"][aria-checked="true"]')) {
    const value = (el.textContent || "").trim();
    if (value) {
      selects.push({ label: labelFor(el), value });
    }
  }
  const checkboxes = [];
  for (const el of document.querySelectorAll('input[type="checkbox"]')) {
    checkboxes.push({ label: labelFor(el), checked: Boolean(el.checked) });
  }
  const switches = [];
  for (const el of document.querySelectorAll('[role="switch"]')) {
    switches.push({
      label: labelFor(el),
      checked: el.getAttribute("aria-checked") === "true",
    });
  }
  const buttons = [];
  for (const el of document.querySelectorAll('[role="button"], button')) {
    const label = (el.textContent || el.getAttribute("aria-label") || "").trim();
    if (label) {
      buttons.push({
        label,
        disabled: el.getAttribute("aria-disabled") === "true" || Boolean(el.disabled),
      });
    }
  }

  return {
    url: location.href,
    text,
    images,
    videos,
    sellingCards,
    detailRows,
    form: { inputs, selects, checkboxes, switches, buttons },
  };
})()`;
