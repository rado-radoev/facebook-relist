// Connect Facebook, live-login replacement: CDP screencast + CDP input
// against the dedicated login page (see BrowserManager.openLoginPage).
//
// One active login session per Relist user. The session owns the login
// page, the screencast, the input lane's sequence state, and the
// settle/hint polling. It deliberately does NOT own the socket: sockets
// attach and detach (phone navigates away, connection drops) while the
// session — page, appliedSeq, focus state — persists, and a later
// attach + resync reconciles whatever the client missed.
//
// Two independent lanes:
//   frame lane — CDP Page screencast frames are forwarded to the socket
//     the moment they arrive and acked back to CDP. Frames never wait
//     on input, and input never waits on frames (except during a popup
//     switch, where input is locked until the new page's first frame).
//   input lane — client ops apply strictly in seq order on a serialized
//     promise chain, via CDP Input on the login page only. An op whose
//     seq is already applied is acked again but never re-applied, so a
//     client resending unacked ops after a resync is safe.
//
// Payload honesty: nothing on this path logs message payloads, and ack
// messages carry a seq number only — never text, never a hash of text.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  LOGIN_VIEWPORT,
  type BrowserManager,
  type CdpSessionLike,
  type PageLike,
} from "./browserManager.js";
import type { FacebookStatus } from "./facebookStatus.js";

export type FieldKind = "email" | "password" | "code" | "other" | null;
export type LoginHint = "default" | "save_browser" | "push_2fa" | "code_entry" | "parked";
export type LoginStateName = "streaming" | "connected" | "parked" | "ended";
export type ResyncVerdict = "intact" | "adopt" | "reset";

export type LoginOp =
  | { type: "insert"; text: string }
  | { type: "deleteBackward"; count: number }
  | { type: "key"; key: string };

/** The slice of a WebSocket this module needs (ws satisfies it). */
export interface LoginSocketLike {
  send(data: string | Buffer): void;
  on(event: string, listener: (...args: never[]) => void): void;
  close?(code?: number, reason?: string): void;
  readyState?: number;
}

export interface AttachOptions {
  /** Session-token hash for BrowserManager.trackSocket revocation. */
  tokenHash?: string;
  /** Re-checked before every inbound message is acted on. */
  isAuthorized?: () => boolean;
}

/**
 * Fingerprint of a field value for the resync handshake: sha256 hex of
 * salt + "\n" + value, first 16 chars. Null when the value is empty —
 * an empty capture has no fingerprint.
 */
export function computeFingerprint(salt: string, value: string): string | null {
  if (value === "") {
    return null;
  }
  return createHash("sha256").update(`${salt}\n${value}`).digest("hex").slice(0, 16);
}

/** Read the focused field of the login page: its kind and its value.
 *  The marker comment lets test fakes recognise this call. */
export const FOCUS_SCRIPT = `/* relist-focus */ (() => {
  const el = document.activeElement;
  if (!el) return { kind: null, value: "" };
  const tag = (el.tagName || "").toLowerCase();
  const editable = tag === "input" || tag === "textarea" || el.isContentEditable === true;
  if (!editable) return { kind: null, value: "" };
  const attr = (name) => {
    try { return (el.getAttribute(name) || "").toLowerCase(); } catch { return ""; }
  };
  const type = attr("type");
  const haystack = [attr("name"), attr("autocomplete"), attr("inputmode"), (el.id || "").toLowerCase()].join(" ");
  let kind = "other";
  if (type === "password") {
    kind = "password";
  } else if (
    type === "email" || type === "tel" ||
    haystack.indexOf("email") !== -1 || haystack.indexOf("username") !== -1 ||
    haystack.indexOf("tel") !== -1 || haystack.indexOf("phone") !== -1
  ) {
    kind = "email";
  } else if (
    haystack.indexOf("one-time-code") !== -1 || haystack.indexOf("numeric") !== -1 ||
    haystack.indexOf("code") !== -1
  ) {
    kind = "code";
  }
  const value = typeof el.value === "string" ? el.value : (el.innerText || el.textContent || "");
  return { kind: kind, value: value };
})()`;

/** Read the login page's visible text + whether a code field is present
 *  (the settle/hint poll). The marker comment lets test fakes recognise
 *  this call. */
export const PAGE_STATE_SCRIPT = `/* relist-page-state */ (() => {
  const text = document.body ? (document.body.innerText || document.body.textContent || "") : "";
  let hasCodeField = false;
  for (const el of document.querySelectorAll("input")) {
    const hay = [
      el.getAttribute("autocomplete") || "",
      el.getAttribute("inputmode") || "",
      el.getAttribute("name") || "",
      el.id || "",
    ].join(" ").toLowerCase();
    if (hay.indexOf("one-time-code") !== -1 || hay.indexOf("numeric") !== -1 || hay.indexOf("code") !== -1) {
      hasCodeField = true;
      break;
    }
  }
  return { text: text, hasCodeField: hasCodeField };
})()`;

/** Clear the focused field without CDP (fallback path only). */
export const CLEAR_FIELD_SCRIPT = `/* relist-clear-field */ (() => {
  const el = document.activeElement;
  if (!el) return false;
  if (typeof el.select === "function") el.select();
  try { document.execCommand("delete"); } catch { /* best effort */ }
  if (typeof el.value === "string") {
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = "";
  }
  return true;
})()`;

const KEY_EVENTS: Record<string, { key: string; code: string; virtualKey: number }> = {
  Enter: { key: "Enter", code: "Enter", virtualKey: 13 },
  Tab: { key: "Tab", code: "Tab", virtualKey: 9 },
  Escape: { key: "Escape", code: "Escape", virtualKey: 27 },
};
const BACKSPACE_EVENT = { key: "Backspace", code: "Backspace", virtualKey: 8 };
const SELECT_ALL_EVENT = { key: "a", code: "KeyA", virtualKey: 65 };
const CTRL_MODIFIER = 2;
const ALLOWED_OP_KEYS = new Set(Object.keys(KEY_EVENTS));
const MAX_INSERT_LENGTH = 5000;
const MAX_DELETE_COUNT = 1000;
const CONNECTED_POLLS_REQUIRED = 3;
const NEEDS_CHECK_POLLS_REQUIRED = 3;

interface SessionState {
  userId: string;
  sessionId: string;
  salt: string;
  page: PageLike;
  cdp: CdpSessionLike | null;
  /** Bumped on every popup switch; stale screencast handlers check it. */
  generation: number;
  socket: LoginSocketLike | null;
  detachSocket: (() => void) | undefined;
  isAuthorized: (() => boolean) | undefined;
  appliedSeq: number;
  chain: Promise<void>;
  inputLocked: boolean;
  unlockResolvers: Array<() => void>;
  poller: NodeJS.Timeout | null;
  connectedStreak: number;
  needsCheckStreak: number;
  /** True once an Enter op has been applied (a login submit signal). */
  submitted: boolean;
  parked: boolean;
  ended: boolean;
  focusKind: FieldKind;
  lastHint: LoginHint | null;
  lastStateSent: LoginStateName | null;
  lastStatusSent: FacebookStatus | null;
}

function parseOp(raw: unknown): LoginOp | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record.type === "insert") {
    if (typeof record.text !== "string" || record.text.length > MAX_INSERT_LENGTH) {
      return null;
    }
    return { type: "insert", text: record.text };
  }
  if (record.type === "deleteBackward") {
    if (typeof record.count !== "number" || !Number.isFinite(record.count)) {
      return null;
    }
    const count = Math.max(0, Math.min(MAX_DELETE_COUNT, Math.floor(record.count)));
    return { type: "deleteBackward", count };
  }
  if (record.type === "key") {
    if (typeof record.key !== "string" || !ALLOWED_OP_KEYS.has(record.key)) {
      return null;
    }
    return { type: "key", key: record.key };
  }
  return null;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

export class LoginSessionRegistry {
  private readonly sessions = new Map<string, SessionState>();
  private readonly pollIntervalMs: number;

  constructor(
    private readonly browser: BrowserManager,
    options: { pollIntervalMs?: number } = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
  }

  hasSession(userId: string): boolean {
    const state = this.sessions.get(userId);
    return Boolean(state && !state.ended);
  }

  appliedSeqOf(userId: string): number | null {
    return this.sessions.get(userId)?.appliedSeq ?? null;
  }

  /** Start (or reuse) the user's login session: open the dedicated
   *  login page, start its screencast, supervise popups, and poll for
   *  settle/hint changes every 2s. */
  async start(userId: string): Promise<void> {
    const existing = this.sessions.get(userId);
    if (existing && !existing.ended) {
      return;
    }
    const page = await this.browser.openLoginPage(userId);
    const state: SessionState = {
      userId,
      sessionId: randomUUID(),
      salt: randomBytes(16).toString("hex"),
      page,
      cdp: null,
      generation: 0,
      socket: null,
      detachSocket: undefined,
      isAuthorized: undefined,
      appliedSeq: 0,
      chain: Promise.resolve(),
      inputLocked: false,
      unlockResolvers: [],
      poller: null,
      connectedStreak: 0,
      needsCheckStreak: 0,
      submitted: false,
      parked: false,
      ended: false,
      focusKind: null,
      lastHint: null,
      lastStateSent: null,
      lastStatusSent: null,
    };
    this.sessions.set(userId, state);
    try {
      await this.browser.onNewPage(userId, (newPage) => {
        void this.handleNewPage(state, newPage).catch(() => undefined);
      });
    } catch {
      // No popup supervision available (fake contexts may omit onPage);
      // the session still works for the primary login page.
    }
    await this.setupScreencast(state, page);
    const poller = setInterval(() => {
      void this.pollTick(state).catch(() => undefined);
    }, this.pollIntervalMs);
    poller.unref();
    state.poller = poller;
  }

  /**
   * Attach a socket to the user's session (starting one if needed) and
   * wire the frozen WS protocol. On socket close only the attachment
   * ends — the session itself persists.
   */
  async attach(
    userId: string,
    socket: LoginSocketLike,
    options: AttachOptions = {},
  ): Promise<void> {
    // Register the socket for revocation BEFORE the first await: a
    // logout that lands while the session is still starting must still
    // close this socket. (An async function body runs synchronously up
    // to its first await, so this registration is immediate.)
    const detachSocket = options.tokenHash
      ? this.browser.trackSocket(userId, options.tokenHash, socket as unknown as WebSocket)
      : undefined;
    try {
      await this.start(userId);
    } catch (error) {
      detachSocket?.();
      throw error;
    }
    const state = this.sessions.get(userId);
    if (!state) {
      detachSocket?.();
      return;
    }
    if (state.socket && state.socket !== socket) {
      state.detachSocket?.();
      state.detachSocket = undefined;
    }
    state.socket = socket;
    state.isAuthorized = options.isAuthorized;
    state.detachSocket = detachSocket;
    this.sendJson(state, { kind: "welcome", sessionId: state.sessionId, salt: state.salt });
    const currentState: LoginStateName = state.parked ? "parked" : "streaming";
    state.lastStateSent = currentState;
    this.sendJson(state, { kind: "state", state: currentState });

    socket.on("message", (data: unknown) => {
      if (state.socket !== socket) {
        return;
      }
      if (state.isAuthorized && !state.isAuthorized()) {
        try {
          socket.close?.(4401, "Session expired or revoked");
        } catch {
          // Already closing.
        }
        return;
      }
      const text = typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : "";
      if (text) {
        this.handleMessage(state, text);
      }
    });
    socket.on("close", () => {
      if (state.socket === socket) {
        state.socket = null;
      }
      state.detachSocket?.();
      state.detachSocket = undefined;
    });
    if (socket.readyState === 3) {
      // The socket closed while the session was starting; the close
      // event already fired and will not fire again for our handler.
      state.socket = null;
      state.detachSocket?.();
      state.detachSocket = undefined;
    }
  }

  /** End the user's login session entirely (disconnect): stop polling
   *  and the screencast, close the login page. The browser profile —
   *  and any Facebook session in it — is the caller's to keep or drop. */
  async end(userId: string): Promise<void> {
    const state = this.sessions.get(userId);
    if (!state) {
      await this.browser.closeLoginPage(userId).catch(() => undefined);
      return;
    }
    this.sessions.delete(userId);
    state.ended = true;
    this.unlock(state);
    if (state.poller) {
      clearInterval(state.poller);
      state.poller = null;
    }
    this.sendJson(state, { kind: "state", state: "ended" });
    await this.stopScreencast(state);
    await this.browser.closeLoginPage(userId).catch(() => undefined);
  }

  async endAll(): Promise<void> {
    for (const userId of [...this.sessions.keys()]) {
      await this.end(userId);
    }
  }

  /** One settle/hint poll. Public so tests can drive it deterministically
   *  instead of waiting on the 2s interval. */
  async pollOnce(userId: string): Promise<void> {
    const state = this.sessions.get(userId);
    if (state) {
      await this.pollTick(state);
    }
  }

  // -- screencast (frame lane) -------------------------------------------

  private async setupScreencast(state: SessionState, page: PageLike): Promise<void> {
    state.cdp = null;
    if (!page.cdp) {
      return;
    }
    let cdp: CdpSessionLike;
    try {
      cdp = await page.cdp();
    } catch {
      return;
    }
    state.cdp = cdp;
    const generation = state.generation;
    cdp.on("Page.screencastFrame", (params: unknown) => {
      void this.handleFrame(state, cdp, generation, params).catch(() => undefined);
    });
    try {
      await cdp.send("Page.enable");
    } catch {
      // Some sessions have the Page domain live already.
    }
    try {
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 55,
        maxWidth: 780,
        maxHeight: 1688,
        everyNthFrame: 1,
      });
    } catch {
      // Without a screencast the session still takes input; frames
      // simply never arrive.
    }
  }

  private async stopScreencast(state: SessionState): Promise<void> {
    if (!state.cdp) {
      return;
    }
    try {
      await state.cdp.send("Page.stopScreencast");
    } catch {
      // The page may already be gone.
    }
  }

  private async handleFrame(
    state: SessionState,
    cdp: CdpSessionLike,
    generation: number,
    params: unknown,
  ): Promise<void> {
    if (state.ended || cdp !== state.cdp || generation !== state.generation) {
      return;
    }
    if (typeof params !== "object" || params === null) {
      return;
    }
    const record = params as Record<string, unknown>;
    if (typeof record.data !== "string") {
      return;
    }
    const frame = Buffer.from(record.data, "base64");
    if (state.socket && (state.socket.readyState === undefined || state.socket.readyState === 1)) {
      try {
        state.socket.send(frame);
      } catch {
        // A closing socket drops this frame; the next one retries.
      }
    }
    try {
      await cdp.send("Page.screencastFrameAck", { sessionId: record.sessionId });
    } catch {
      // Ack failure means the screencast is gone; nothing to salvage.
    }
    if (state.inputLocked && generation === state.generation && !state.ended) {
      // First frame of the popup page: input may flow again, and the
      // focused field may have changed across the switch.
      this.unlock(state);
      await this.inspectFocus(state);
      this.sendFocus(state);
    }
  }

  // -- popup supervision ---------------------------------------------------

  private async handleNewPage(state: SessionState, newPage: PageLike): Promise<void> {
    if (state.ended || newPage === state.page) {
      return;
    }
    // Lock input BEFORE switching so no op can land on the old page or
    // race the move; the first screencast frame of the new page unlocks.
    state.inputLocked = true;
    state.generation += 1;
    await this.stopScreencast(state);
    state.page = newPage;
    await this.browser.setLoginPage(state.userId, newPage).catch(() => undefined);
    await this.setupScreencast(state, newPage);
  }

  private unlock(state: SessionState): void {
    state.inputLocked = false;
    const resolvers = state.unlockResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve();
    }
  }

  private async waitForUnlock(state: SessionState): Promise<void> {
    while (state.inputLocked && !state.ended) {
      await new Promise<void>((resolve) => {
        state.unlockResolvers.push(resolve);
      });
    }
  }

  // -- inbound messages (input lane) ---------------------------------------

  private handleMessage(state: SessionState, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      return;
    }
    const record = parsed as Record<string, unknown>;
    if (record.kind === "resync") {
      const fingerprint = typeof record.fingerprint === "string" ? record.fingerprint : null;
      this.enqueue(state, () => this.doResync(state, fingerprint));
      return;
    }
    if (record.kind === "op") {
      const op = parseOp(record.op);
      if (typeof record.seq !== "number" || !Number.isFinite(record.seq) || !op) {
        return;
      }
      const seq = record.seq;
      this.enqueue(state, () => this.applyOpTask(state, seq, op));
      return;
    }
    if (record.kind === "tap") {
      if (
        typeof record.nx !== "number" || !Number.isFinite(record.nx) ||
        typeof record.ny !== "number" || !Number.isFinite(record.ny)
      ) {
        return;
      }
      const { nx, ny } = record;
      this.enqueue(state, () => this.applyTapTask(state, nx, ny));
      return;
    }
    if (record.kind === "scroll") {
      if (typeof record.dy !== "number" || !Number.isFinite(record.dy)) {
        return;
      }
      const dy = Math.max(-2000, Math.min(2000, record.dy));
      this.enqueue(state, () => this.applyScrollTask(state, dy));
    }
    // Unknown kinds (including the retired screenshot-era protocol) are
    // ignored by design.
  }

  private enqueue(state: SessionState, task: () => Promise<void>): void {
    const run = state.chain.then(() => task());
    state.chain = run.catch(() => undefined);
  }

  private async applyOpTask(state: SessionState, seq: number, op: LoginOp): Promise<void> {
    if (state.ended) {
      return;
    }
    await this.waitForUnlock(state);
    if (state.ended) {
      return;
    }
    if (seq <= state.appliedSeq) {
      // Already applied (the client is resending after a resync): ack
      // again so it can advance, but never apply twice.
      this.sendJson(state, { kind: "ack", seq });
      return;
    }
    try {
      await this.applyOp(state, op);
    } catch {
      // Not applied: no ack, no seq advance. The client's resync/resend
      // cycle is the recovery path.
      return;
    }
    state.appliedSeq = seq;
    if (op.type === "key" && op.key === "Enter") {
      state.submitted = true;
    }
    this.sendJson(state, { kind: "ack", seq });
    if (op.type === "key" && (op.key === "Enter" || op.key === "Tab")) {
      await this.inspectFocus(state);
      this.sendFocus(state);
    }
  }

  private async cdpKey(
    cdp: CdpSessionLike,
    event: { key: string; code: string; virtualKey: number },
    modifiers = 0,
  ): Promise<void> {
    const base = {
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: event.virtualKey,
      nativeVirtualKeyCode: event.virtualKey,
      modifiers,
    };
    await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
    await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  }

  private async applyOp(state: SessionState, op: LoginOp): Promise<void> {
    const cdp = state.cdp;
    if (op.type === "insert") {
      if (op.text.length === 0) {
        return;
      }
      if (cdp) {
        await cdp.send("Input.insertText", { text: op.text });
      } else {
        await state.page.keyboard.type(op.text);
      }
      return;
    }
    if (op.type === "deleteBackward") {
      for (let index = 0; index < op.count; index += 1) {
        if (cdp) {
          await this.cdpKey(cdp, BACKSPACE_EVENT);
        } else {
          await state.page.keyboard.press("Backspace");
        }
      }
      return;
    }
    const event = KEY_EVENTS[op.key];
    if (!event) {
      return;
    }
    if (cdp) {
      await this.cdpKey(cdp, event);
    } else {
      await state.page.keyboard.press(op.key);
    }
  }

  private async applyTapTask(state: SessionState, nx: number, ny: number): Promise<void> {
    if (state.ended) {
      return;
    }
    await this.waitForUnlock(state);
    if (state.ended) {
      return;
    }
    const x = clamp01(nx) * LOGIN_VIEWPORT.width;
    const y = clamp01(ny) * LOGIN_VIEWPORT.height;
    try {
      if (state.cdp) {
        await state.cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y, id: 1 }],
        });
        await state.cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      } else {
        await state.page.mouse.click(x, y);
      }
    } catch {
      return;
    }
    await this.inspectFocus(state);
    this.sendFocus(state);
  }

  private async applyScrollTask(state: SessionState, dy: number): Promise<void> {
    if (state.ended) {
      return;
    }
    await this.waitForUnlock(state);
    if (state.ended) {
      return;
    }
    try {
      if (state.cdp) {
        await state.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: LOGIN_VIEWPORT.width / 2,
          y: LOGIN_VIEWPORT.height / 2,
          deltaX: 0,
          deltaY: dy,
        });
      } else {
        await state.page.mouse.wheel(0, dy);
      }
    } catch {
      // Scroll is cosmetic; a failed wheel changes nothing.
    }
  }

  // -- focus + resync ------------------------------------------------------

  private async inspectFocus(state: SessionState): Promise<{ kind: FieldKind; value: string }> {
    try {
      const raw = await state.page.evaluate(FOCUS_SCRIPT);
      if (typeof raw === "object" && raw !== null) {
        const record = raw as Record<string, unknown>;
        const kind = record.kind === "email" || record.kind === "password" ||
          record.kind === "code" || record.kind === "other"
          ? record.kind
          : null;
        const value = typeof record.value === "string" ? record.value : "";
        state.focusKind = kind;
        return { kind, value };
      }
    } catch {
      // A page mid-navigation rejects evaluation; keep the last kind.
    }
    return { kind: state.focusKind, value: "" };
  }

  private sendFocus(state: SessionState): void {
    this.sendJson(state, { kind: "focus", fieldKind: state.focusKind });
  }

  private async clearFocusedField(state: SessionState): Promise<void> {
    if (state.cdp) {
      await this.cdpKey(state.cdp, SELECT_ALL_EVENT, CTRL_MODIFIER);
      await this.cdpKey(state.cdp, BACKSPACE_EVENT);
      return;
    }
    try {
      await state.page.evaluate(CLEAR_FIELD_SCRIPT);
    } catch {
      try {
        await state.page.keyboard.press("Backspace");
      } catch {
        // Nothing more the fallback can do.
      }
    }
  }

  private async doResync(state: SessionState, clientFingerprint: string | null): Promise<void> {
    if (state.ended) {
      return;
    }
    const info = await this.inspectFocus(state);
    const pageFingerprint = computeFingerprint(state.salt, info.value);
    let verdict: ResyncVerdict;
    let pageValue: string | undefined;
    if (clientFingerprint === pageFingerprint) {
      // Both empty (both null) or the same fingerprint: the client's
      // capture and the page agree.
      verdict = "intact";
    } else if (info.kind !== "password") {
      // The page holds the truth for a non-secret field: hand it back
      // so the client adopts it. Unacked ops are never replayed here —
      // the client resends them as normal ops if it still wants them.
      verdict = "adopt";
      pageValue = info.value;
    } else {
      // A password field that disagrees is never echoed back. Clear
      // the page field and let the client retype from scratch.
      verdict = "reset";
      try {
        await this.clearFocusedField(state);
      } catch {
        // The verdict stands even if the clear raced a navigation.
      }
    }
    const message: Record<string, unknown> = {
      kind: "resync_result",
      verdict,
      appliedSeq: state.appliedSeq,
    };
    if (verdict === "adopt") {
      message.pageValue = pageValue ?? "";
    }
    this.sendJson(state, message);
  }

  // -- settle / hint polling -------------------------------------------------

  private async pollTick(state: SessionState): Promise<void> {
    if (state.ended) {
      return;
    }
    let status: FacebookStatus;
    try {
      status = await this.browser.refreshStatus(state.userId);
    } catch {
      return;
    }
    if (state.ended) {
      return;
    }
    if (status !== state.lastStatusSent) {
      state.lastStatusSent = status;
      this.sendJson(state, { kind: "status", status });
    }

    let url = "";
    try {
      url = state.page.url();
    } catch {
      url = "";
    }
    let text = "";
    let hasCodeField = false;
    try {
      const raw = await state.page.evaluate(PAGE_STATE_SCRIPT);
      if (typeof raw === "string") {
        text = raw;
      } else if (typeof raw === "object" && raw !== null) {
        const record = raw as Record<string, unknown>;
        if (typeof record.text === "string") {
          text = record.text;
        }
        hasCodeField = record.hasCodeField === true;
      }
    } catch {
      // A page mid-navigation rejects evaluation; hints wait a poll.
    }
    const lowerText = text.toLowerCase().replace(/’/g, "'");
    const lowerUrl = url.toLowerCase();

    let hint: LoginHint = "default";
    if (
      lowerText.includes("save this browser") ||
      lowerText.includes("save browser") ||
      lowerText.includes("remember this browser") ||
      lowerText.includes("remember browser")
    ) {
      hint = "save_browser";
    } else if (
      (lowerUrl.includes("two_factor") || lowerUrl.includes("checkpoint")) && hasCodeField
    ) {
      hint = "code_entry";
    } else if (lowerText.includes("check your phone") || lowerText.includes("approve")) {
      hint = "push_2fa";
    }
    if (hint !== state.lastHint) {
      state.lastHint = hint;
      this.sendJson(state, { kind: "hint", hint });
    }

    if (status === "needs_check") {
      state.needsCheckStreak += 1;
    } else {
      state.needsCheckStreak = 0;
    }
    const reviewText =
      lowerText.includes("we'll review") ||
      lowerText.includes("we will review") ||
      lowerText.includes("24 hours") ||
      lowerText.includes("confirm your identity");
    const parkedNow =
      (lowerUrl.includes("checkpoint") && reviewText) ||
      (state.needsCheckStreak >= NEEDS_CHECK_POLLS_REQUIRED && state.submitted);
    if (parkedNow && !state.parked) {
      state.parked = true;
      if (state.lastStateSent !== "parked") {
        state.lastStateSent = "parked";
        this.sendJson(state, { kind: "state", state: "parked" });
      }
    }
    // Parked has NO timeout and nothing here ever retries: the poll
    // simply keeps watching until Facebook settles or the user leaves.

    if (status === "connected") {
      state.connectedStreak += 1;
    } else {
      state.connectedStreak = 0;
    }
    if (state.connectedStreak >= CONNECTED_POLLS_REQUIRED) {
      // Connected across 3 consecutive polls: the login is settled.
      // (No display name is sent: the store's identity is a hash only,
      // so there is no clean name to report.)
      state.lastStateSent = "connected";
      this.sendJson(state, { kind: "state", state: "connected" });
      await this.finishStreaming(state);
    }
  }

  /** End streaming after a settled login: stop the poller and the
   *  screencast and close the login page, but keep the browser profile
   *  (the Facebook session lives there). No "ended" state is sent —
   *  "connected" was the terminal message. */
  private async finishStreaming(state: SessionState): Promise<void> {
    this.sessions.delete(state.userId);
    state.ended = true;
    this.unlock(state);
    if (state.poller) {
      clearInterval(state.poller);
      state.poller = null;
    }
    await this.stopScreencast(state);
    await this.browser.closeLoginPage(state.userId).catch(() => undefined);
  }

  // -- socket plumbing -------------------------------------------------------

  private sendJson(state: SessionState, message: Record<string, unknown>): void {
    const socket = state.socket;
    if (!socket) {
      return;
    }
    if (socket.readyState !== undefined && socket.readyState !== 1) {
      return;
    }
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A closing socket drops the message; state stays server-side.
    }
  }
}
