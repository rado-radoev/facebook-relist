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
  /** True only when the collector positively saw and read the attribute section. */
  attributesObserved?: boolean;
}

export interface PayloadPhoto {
  id?: string;
  url: string;
  width?: number;
  height?: number;
}

export interface PageSnapshot {
  url: string;
  /** document.body.innerText — used for prompts and fallbacks. */
  text: string;
  /** Image URLs in DOM order (gallery order on a listing page). */
  images: string[];
  /**
   * Photos harvested from the listing detail page's Relay/SSR payload
   * (`listing_photos`), normalized to the highest-resolution variant per
   * photo, in payload order. `null` when NO `listing_photos` array exists
   * anywhere in the payload (payload never captured / gallery never
   * opened); `[]` when an array exists and is empty (listing genuinely
   * has no photos). The collector always sets this field.
   */
  payloadPhotos?: PayloadPhoto[] | null;
  /** Video URLs the page exposes (video src / source src). */
  videos: string[];
  /** Positive evidence about the page surface; missing metadata is unknown. */
  surface?: {
    kind: "selling_list" | "edit_form" | "listing" | "unknown";
    listingId: string | null;
    readiness: "ready" | "loading" | "checkpoint" | "unknown";
  };
  /** Selling-list completion; counts must be positively observed. */
  completion?: {
    state: "complete" | "incomplete" | "unknown";
    expectedCount: number | null;
    observedCount: number;
  };
  /** Listing gallery completion and explicit video evidence. */
  gallery?: {
    state: "complete" | "incomplete" | "unknown";
    expectedCount: number | null;
    observedCount: number;
    videoPresence: "present" | "absent" | "unknown";
    slots?: Array<{ identity: string; url: string }>;
  };
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
  const text = document.body ? (document.body.innerText || document.body.textContent || "") : "";

  const pagePath = location.pathname;
  const pathParts = pagePath.split("/").filter(Boolean);
  const requestedId = pathParts[0] === "marketplace" && (pathParts[1] === "edit" || pathParts[1] === "item") ? pathParts[2] || null : null;
  const isSellingPath = pagePath.replace(/\\/$/, "") === "/marketplace/you/selling";
  const isEditPath = pathParts[0] === "marketplace" && pathParts[1] === "edit" && Boolean(requestedId);
  const isListingPath = pathParts[0] === "marketplace" && pathParts[1] === "item" && Boolean(requestedId);
  const pageTextLower = text.toLowerCase();
  const checkpoint = /checkpoint|confirm your identity|security check|log in to facebook/.test(pageTextLower) || pathParts.includes("login") || pathParts.includes("checkpoint");
  const surface = {
    kind: isSellingPath ? "selling_list" : isEditPath ? "edit_form" : isListingPath ? "listing" : "unknown",
    listingId: requestedId,
    readiness: checkpoint ? "checkpoint" : document.readyState === "complete" && (text.trim() || document.querySelector('[role="main"]')) ? "ready" : "loading",
  };

  let payloadPhotos = null;
  try {
    const payloadList = [];
    let payloadFound = false;
    const collectVariants = (node, out) => {
      if (!node || typeof node !== "object") return;
      const uri = typeof node.uri === "string" && node.uri ? node.uri : typeof node.url === "string" && node.url ? node.url : null;
      if (uri) out.push({ uri, width: typeof node.width === "number" ? node.width : null, height: typeof node.height === "number" ? node.height : null });
      if (node.image && typeof node.image === "object") collectVariants(node.image, out);
      const listKeys = ["image_versions", "image_versions2", "versions", "variants", "candidates"];
      for (const key of listKeys) {
        const list = node[key];
        if (Array.isArray(list)) {
          for (const item of list) collectVariants(item, out);
        } else if (list && typeof list === "object" && Array.isArray(list.candidates)) {
          for (const item of list.candidates) collectVariants(item, out);
        }
      }
    };
    const normalizePayloadPhoto = (entry) => {
      if (typeof entry === "string") return entry ? { url: entry } : null;
      if (!entry || typeof entry !== "object") return null;
      const variants = [];
      collectVariants(entry, variants);
      const seenUris = new Set();
      const uniq = [];
      for (const variant of variants) {
        if (!seenUris.has(variant.uri)) { seenUris.add(variant.uri); uniq.push(variant); }
      }
      if (!uniq.length) return null;
      let chosen = uniq[0];
      const withWidth = uniq.filter((variant) => typeof variant.width === "number");
      if (withWidth.length) {
        chosen = withWidth.reduce((best, variant) => (variant.width > best.width ? variant : best), withWidth[0]);
      } else {
        const withHeight = uniq.filter((variant) => typeof variant.height === "number");
        if (withHeight.length) chosen = withHeight.reduce((best, variant) => (variant.height > best.height ? variant : best), withHeight[0]);
      }
      const imageObject = entry.image && typeof entry.image === "object" ? entry.image : null;
      const rawId = entry.id ?? entry.pk ?? entry.fbid ?? entry.photo_id ?? (imageObject ? (imageObject.id ?? imageObject.pk ?? imageObject.fbid ?? null) : null);
      const result = { url: chosen.uri };
      if (rawId !== null && rawId !== undefined && rawId !== "") result.id = String(rawId);
      if (typeof chosen.width === "number") result.width = chosen.width;
      if (typeof chosen.height === "number") result.height = chosen.height;
      return result;
    };
    const walkPayload = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const item of node) walkPayload(item); return; }
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (key === "listing_photos" && Array.isArray(value)) {
          payloadFound = true;
          for (const entry of value) {
            const normalized = normalizePayloadPhoto(entry);
            if (normalized) payloadList.push(normalized);
          }
        } else {
          walkPayload(value);
        }
      }
    };
    for (const scriptEl of document.querySelectorAll('script[type="application/json"]')) {
      const rawText = scriptEl.textContent || "";
      if (!rawText.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(rawText); } catch { continue; }
      walkPayload(parsed);
    }
    if (payloadFound) payloadPhotos = payloadList;
  } catch {
    payloadPhotos = null;
  }

  const videos = [];
  const galleryNodes = [...document.querySelectorAll('[role="main"] [role="group"][aria-label], [role="main"] [role="region"][aria-label]')]
    .filter((node) => /photo|gallery|listing images/i.test(node.getAttribute("aria-label") || ""));
  const galleryNode = galleryNodes.length === 1 ? galleryNodes[0] : null;
  const images = [];
  const identities = [];
  const galleryScope = galleryNode || document.querySelector('[role="main"]');
  if (galleryScope) {
    let scopedImgs = [...galleryScope.querySelectorAll('img[alt^="Product photo of"]')];
    if (!scopedImgs.length && galleryNode) scopedImgs = [...galleryNode.querySelectorAll("img")];
    for (const img of scopedImgs) {
      const src = img.currentSrc || img.src || "";
      if (!src) continue;
      const parsed = new URL(src, location.href);
      const stable = parsed.searchParams.get("fbid") || parsed.searchParams.get("id") || parsed.pathname;
      const identity = img.getAttribute("data-media-id") || img.getAttribute("data-photo-id") || stable;
      if (identities.includes(identity)) continue;
      identities.push(identity);
      images.push(src);
    }
  }
  if (galleryNode) {
    for (const video of galleryNode.querySelectorAll("video")) {
      const src = video.currentSrc || video.src || "";
      if (src) videos.push(src);
      for (const source of video.querySelectorAll("source")) {
        if (source.src) videos.push(source.src);
      }
    }
  }
  const galleryLabel = galleryNode ? galleryNode.getAttribute("aria-label") || "" : "";
  const galleryText = galleryNode ? galleryNode.innerText || "" : "";
  const galleryCountMatch = /\\bof\\s+(\\d+)\\b/i.exec(galleryLabel + " " + galleryText);
  const galleryCountAttribute = galleryNode ? galleryNode.getAttribute("data-count") : null;
  const galleryExpected = galleryCountMatch ? Number(galleryCountMatch[1]) : galleryCountAttribute && /^\\d+$/.test(galleryCountAttribute) ? Number(galleryCountAttribute) : null;
  let gallery = {
    state: galleryNode && galleryExpected !== null && galleryExpected === images.length ? "complete" : galleryNode && galleryExpected !== null ? "incomplete" : "unknown",
    expectedCount: galleryExpected,
    observedCount: images.length,
    videoPresence: videos.length > 0 ? "present" : /0 videos?|no videos?/i.test(galleryLabel + " " + galleryText) ? "absent" : "unknown",
    slots: images.map((url, index) => ({ identity: identities[index], url })),
  };
  if (payloadPhotos !== null) {
    const payloadUrls = payloadPhotos.map((photo) => photo.url);
    const payloadIdentities = payloadPhotos.map((photo) => {
      if (photo.id) return photo.id;
      try {
        const parsed = new URL(photo.url, location.href);
        return parsed.searchParams.get("fbid") || parsed.searchParams.get("id") || parsed.pathname || photo.url;
      } catch {
        return photo.url;
      }
    });
    images.length = 0;
    for (const url of payloadUrls) images.push(url);
    identities.length = 0;
    for (const identity of payloadIdentities) identities.push(identity);
    gallery = {
      state: "complete",
      expectedCount: payloadPhotos.length,
      observedCount: payloadPhotos.length,
      videoPresence: gallery.videoPresence,
      slots: payloadUrls.map((url, index) => ({ identity: payloadIdentities[index], url })),
    };
  }

  const sellingCards = [];
  const seenCards = new Set();
  for (const link of (isSellingPath ? document.querySelectorAll('[role="main"] a[href*="/marketplace/item/"]') : [])) {
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
      const labels = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((labelEl) => (labelEl.textContent || "").trim()).filter(Boolean);
      if (labels.length) return labels.join(" ");
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
    const wrapping = el.closest("label");
    if (wrapping) return (wrapping.textContent || "").replace(el.value || "", "").trim();
    return "";
  };

  const inputs = [];
  for (const el of document.querySelectorAll("input, textarea")) {
    if (["checkbox", "radio", "hidden", "password", "submit", "button", "file"].includes((el.type || "").toLowerCase())) {
      continue;
    }
    inputs.push({ label: labelFor(el), value: el.value || "" });
  }
  for (const el of document.querySelectorAll('[contenteditable="true"]')) {
    const value = (el.innerText || el.textContent || "").trim();
    if (value) inputs.push({ label: labelFor(el), value });
  }
  const selects = [];
  for (const el of document.querySelectorAll("select")) {
    const value = el.selectedOptions && el.selectedOptions.length ? (el.selectedOptions[0].textContent || "").trim() : "";
    if (value) selects.push({ label: labelFor(el), value });
  }
  for (const el of document.querySelectorAll('[role="combobox"]')) {
    const expanded = el.getAttribute("aria-expanded") === "true";
    const value = (el.innerText || el.textContent || "").trim();
    if (!expanded && value && !selects.some((item) => item.label === labelFor(el) && item.value === value)) selects.push({ label: labelFor(el), value });
  }
  for (const el of document.querySelectorAll('[aria-selected="true"], [role="option"][aria-checked="true"]')) {
    const value = (el.textContent || "").trim();
    if (value) {
      selects.push({ label: labelFor(el), value });
    }
  }
  const checkboxes = [];
  for (const el of document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) {
    checkboxes.push({ label: labelFor(el), checked: el.getAttribute("role") === "checkbox" ? el.getAttribute("aria-checked") === "true" : Boolean(el.checked) });
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

  const attributesObserved = Boolean(document.querySelector('[data-section="attributes"], [aria-label="Attributes"]')) ||
    [...inputs, ...selects].some((field) => field.label && !/^(title|price|description|category|condition|location|delivery|shipping|public meetup|door pickup|door dropoff)$/i.test(field.label));
  const main = document.querySelector('[role="main"]');
  const completionText = main ? (main.innerText || main.textContent || "") : "";
  const completionMatch = /\\b(\\d+)\\s+(?:active\\s+)?listings?\\b/i.exec(completionText) || /\\b(\\d+)\\s+results?\\b/i.exec(completionText);
  const expectedCount = completionMatch ? Number(completionMatch[1]) : null;
  const completion = {
    state: !isSellingPath ? "unknown" : expectedCount === null ? "unknown" : expectedCount === sellingCards.length ? "complete" : "incomplete",
    expectedCount,
    observedCount: sellingCards.length,
  };

  return {
    url: location.href,
    text,
    images,
    payloadPhotos,
    videos,
    surface,
    completion,
    gallery,
    sellingCards,
    detailRows,
    form: { inputs, selects, checkboxes, switches, buttons, attributesObserved },
  };
})()`;
