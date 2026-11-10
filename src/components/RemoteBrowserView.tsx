// Live remote view of the backend browser — replacement design.
//
// There is no separate type box and no on-screen key bar. A transparent
// capture <input> covers the streamed Facebook page and IS the tap
// target: tapping it focuses it synchronously (which is what raises the
// iOS keyboard) and forwards the tap to the remote page, and whatever
// the person then types into it is diffed (see lib/textDiff) and sent
// to the backend browser as sequenced ops. Password/code characters pass
// through this component's state and the backend's memory on their way
// to Facebook; nothing here persists them — unmount clears the capture.

import { useEffect, useRef, useState } from "react";
import type { SessionStatus } from "../types";
import { facebookViewSocketUrl } from "../lib/api";
import { diffCapture, type CaptureOp } from "../lib/textDiff";

export type LoginState = "streaming" | "connected" | "parked" | "ended";
export type ViewHint = "default" | "save_browser" | "push_2fa" | "code_entry" | "parked" | "passkey";
/** The server names this union LoginHint (server/src/loginSession.ts). */
export type LoginHint = ViewHint;

interface Props {
  onStatusChange: (status: SessionStatus) => void;
  onLoginState?: (state: LoginState, name?: string) => void;
  onExit?: () => void;
}

type FieldKind = "email" | "password" | "code" | "other" | null;

interface BufferedOp {
  seq: number;
  op: CaptureOp | { type: "key"; key: string };
}

const HINT_TEXT: Record<ViewHint, string> = {
  default: "Tap a field to type — use your keyboard like normal",
  save_browser: "Tap Save — so you don't have to do this again soon",
  push_2fa: "Approve the login in your Facebook app, or check your texts",
  code_entry: "Enter the code Facebook sent you",
  passkey:
    "Facebook is asking for a security key, which can't be used here — choose 'Try another way' on Facebook's page to get a code instead.",
  parked: "",
};

const RECONNECT_DELAYS_MS = [1000, 2000, 5000];
const TAP_MAX_MOVE_PX = 10;
const SCROLL_SEND_THRESHOLD_PX = 20;

async function fingerprintOf(salt: string, captureValue: string): Promise<string | null> {
  if (!captureValue) {
    return null;
  }
  try {
    if (!globalThis.crypto?.subtle?.digest) {
      return null;
    }
    const bytes = new TextEncoder().encode(`${salt}\n${captureValue}`);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return hex.slice(0, 16);
  } catch {
    return null;
  }
}

export default function RemoteBrowserView({ onStatusChange, onLoginState, onExit }: Props) {
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [captureValue, setCaptureValue] = useState("");
  const [hint, setHint] = useState<ViewHint>("default");
  const [loginState, setLoginState] = useState<LoginState | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const frameUrlRef = useRef<string | null>(null);
  const captureInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<HTMLElement | null>(null);

  const captureRef = useRef("");
  const seqRef = useRef(0);
  const lastAckRef = useRef(0);
  const opBufferRef = useRef<BufferedOp[]>([]);
  const saltRef = useRef<string | null>(null);
  const fieldKindRef = useRef<FieldKind>(null);
  const resyncInFlightRef = useRef(false);

  // Callbacks in refs so the socket effect runs exactly once per mount,
  // however often the parent re-renders with fresh prop identities.
  const onStatusChangeRef = useRef(onStatusChange);
  const onLoginStateRef = useRef(onLoginState);
  onStatusChangeRef.current = onStatusChange;
  onLoginStateRef.current = onLoginState;

  const touchRef = useRef<{
    x: number;
    y: number;
    lastY: number;
    at: number;
    dragging: boolean;
    scrollAcc: number;
  } | null>(null);
  const mouseRef = useRef<{
    down: boolean;
    x: number;
    y: number;
    lastY: number;
    dragging: boolean;
    scrollAcc: number;
  } | null>(null);
  // A touch tap is followed by a synthetic mouse click in real browsers;
  // remember the touch tap so the click does not send a second tap.
  const lastTouchTapRef = useRef<{ at: number; x: number; y: number } | null>(null);
  const suppressMouseClickRef = useRef(0);

  function setCapture(next: string) {
    captureRef.current = next;
    setCaptureValue(next);
  }

  function sendRaw(message: Record<string, unknown>) {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function sendOp(op: BufferedOp["op"]) {
    seqRef.current += 1;
    const entry: BufferedOp = { seq: seqRef.current, op };
    opBufferRef.current.push(entry);
    // During a socket outage the op stays buffered and flushes via the
    // resync handshake when the socket reconnects.
    sendRaw({ kind: "op", seq: entry.seq, op: entry.op });
  }

  function processCaptureChange(next: string) {
    const prev = captureRef.current;
    if (next === prev) {
      return;
    }
    // Update the ref before sending so a duplicate input+change pair for
    // the same keystroke diffs against the new value and no-ops.
    captureRef.current = next;
    setCaptureValue(next);
    for (const op of diffCapture(prev, next)) {
      sendOp(op);
    }
  }

  function streamRect(): DOMRect | null {
    const stream = streamRef.current;
    if (stream) {
      return stream.getBoundingClientRect();
    }
    return captureInputRef.current?.getBoundingClientRect() ?? null;
  }

  function handleTap(clientX: number, clientY: number) {
    // Focus synchronously inside the gesture handler — this is what
    // raises the iOS keyboard. The capture input is the tap target, so
    // do not preventDefault anything on this path.
    captureInputRef.current?.focus();
    const rect = streamRect();
    let nx = 0;
    let ny = 0;
    if (rect && rect.width > 0 && rect.height > 0) {
      nx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      ny = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    }
    sendRaw({ kind: "tap", nx, ny });
  }

  function flushScroll(acc: number) {
    if (acc !== 0) {
      sendRaw({ kind: "scroll", dy: Math.round(acc) });
    }
  }

  // --- Touch gestures: short + still = tap, movement = scroll. --------

  function pointFromTouch(event: React.TouchEvent): { x: number; y: number } | null {
    const touch = event.changedTouches?.[0] ?? event.touches?.[0];
    if (touch) {
      return { x: touch.clientX, y: touch.clientY };
    }
    const raw = event as unknown as { clientX?: number; clientY?: number };
    if (typeof raw.clientX === "number" && typeof raw.clientY === "number") {
      return { x: raw.clientX, y: raw.clientY };
    }
    return null;
  }

  function handleTouchStart(event: React.TouchEvent<HTMLInputElement>) {
    const point = pointFromTouch(event);
    if (!point) return;
    touchRef.current = {
      x: point.x,
      y: point.y,
      lastY: point.y,
      at: Date.now(),
      dragging: false,
      scrollAcc: 0,
    };
  }

  function handleTouchMove(event: React.TouchEvent<HTMLInputElement>) {
    const gesture = touchRef.current;
    const point = pointFromTouch(event);
    if (!gesture || !point) return;
    if (Math.abs(point.x - gesture.x) > TAP_MAX_MOVE_PX || Math.abs(point.y - gesture.y) > TAP_MAX_MOVE_PX) {
      gesture.dragging = true;
    }
    if (gesture.dragging) {
      // Finger moving up scrolls the page down, and vice versa.
      gesture.scrollAcc += gesture.lastY - point.y;
      if (Math.abs(gesture.scrollAcc) >= SCROLL_SEND_THRESHOLD_PX) {
        flushScroll(gesture.scrollAcc);
        gesture.scrollAcc = 0;
      }
    }
    gesture.lastY = point.y;
  }

  function handleTouchEnd(event: React.TouchEvent<HTMLInputElement>) {
    const gesture = touchRef.current;
    touchRef.current = null;
    const point = pointFromTouch(event) ?? (gesture ? { x: gesture.x, y: gesture.y } : null);
    if (!gesture || !point) return;
    if (gesture.dragging) {
      flushScroll(gesture.scrollAcc);
      return;
    }
    // Any touchend that never turned into a drag is a tap, however long
    // it lasted: a long press that never moved still taps the field,
    // matching how the remote page would treat it.
    lastTouchTapRef.current = { at: Date.now(), x: point.x, y: point.y };
    handleTap(point.x, point.y);
  }

  // --- Mouse: click = tap, drag = scroll (desktop testing). -----------

  function handleMouseDown(event: React.MouseEvent<HTMLInputElement>) {
    mouseRef.current = {
      down: true,
      x: event.clientX,
      y: event.clientY,
      lastY: event.clientY,
      dragging: false,
      scrollAcc: 0,
    };
  }

  function handleMouseMove(event: React.MouseEvent<HTMLInputElement>) {
    const gesture = mouseRef.current;
    if (!gesture?.down) return;
    if (Math.abs(event.clientX - gesture.x) > TAP_MAX_MOVE_PX || Math.abs(event.clientY - gesture.y) > TAP_MAX_MOVE_PX) {
      gesture.dragging = true;
    }
    if (gesture.dragging) {
      gesture.scrollAcc += gesture.lastY - event.clientY;
      if (Math.abs(gesture.scrollAcc) >= SCROLL_SEND_THRESHOLD_PX) {
        flushScroll(gesture.scrollAcc);
        gesture.scrollAcc = 0;
      }
    }
    gesture.lastY = event.clientY;
  }

  function handleMouseUp(event: React.MouseEvent<HTMLInputElement>) {
    const gesture = mouseRef.current;
    mouseRef.current = null;
    if (gesture?.dragging) {
      flushScroll(gesture.scrollAcc);
      // The click that follows a drag must not also become a tap.
      suppressMouseClickRef.current = Date.now();
    }
  }

  function handleClick(event: React.MouseEvent<HTMLInputElement>) {
    if (Date.now() - suppressMouseClickRef.current < 700 && suppressMouseClickRef.current !== 0) {
      return;
    }
    const lastTouch = lastTouchTapRef.current;
    if (
      lastTouch &&
      Date.now() - lastTouch.at < 700 &&
      Math.abs(event.clientX - lastTouch.x) <= TAP_MAX_MOVE_PX &&
      Math.abs(event.clientY - lastTouch.y) <= TAP_MAX_MOVE_PX
    ) {
      return;
    }
    handleTap(event.clientX, event.clientY);
  }

  // --- Text capture -----------------------------------------------------

  function handleCaptureInput(event: React.FormEvent<HTMLInputElement>) {
    processCaptureChange(event.currentTarget.value);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      sendOp({ type: "key", key: "Enter" });
    } else if (event.key === "Tab") {
      event.preventDefault();
      sendOp({ type: "key", key: "Tab" });
    }
  }

  function handleBeforeInput(event: React.FormEvent<HTMLInputElement>) {
    const inputType = (event as unknown as { inputType?: string }).inputType;
    const nativeType = (event.nativeEvent as InputEvent | undefined)?.inputType;
    if (inputType === "insertLineBreak" || nativeType === "insertLineBreak") {
      event.preventDefault();
      sendOp({ type: "key", key: "Enter" });
    }
  }

  // --- Socket lifecycle -------------------------------------------------

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let currentSocket: WebSocket | null = null;

    function pruneBuffer(appliedSeq: number) {
      if (appliedSeq > lastAckRef.current) {
        lastAckRef.current = appliedSeq;
      }
      opBufferRef.current = opBufferRef.current.filter((entry) => entry.seq > lastAckRef.current);
    }

    async function sendResync(socket: WebSocket) {
      resyncInFlightRef.current = true;
      const fingerprint = await fingerprintOf(saltRef.current ?? "", captureRef.current);
      if (disposed || socketRef.current !== socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(
        JSON.stringify({ kind: "resync", lastAck: lastAckRef.current, fingerprint }),
      );
    }

    function connect() {
      const socket = new WebSocket(facebookViewSocketUrl());
      socket.binaryType = "blob";
      currentSocket = socket;
      socketRef.current = socket;

      socket.onopen = () => {
        reconnectAttempt = 0;
      };

      socket.onmessage = (event: MessageEvent) => {
        if (disposed) {
          return;
        }
        if (event.data instanceof Blob) {
          const url = URL.createObjectURL(event.data);
          if (frameUrlRef.current) {
            URL.revokeObjectURL(frameUrlRef.current);
          }
          frameUrlRef.current = url;
          setFrameUrl(url);
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          const url = URL.createObjectURL(new Blob([event.data], { type: "image/jpeg" }));
          if (frameUrlRef.current) {
            URL.revokeObjectURL(frameUrlRef.current);
          }
          frameUrlRef.current = url;
          setFrameUrl(url);
          return;
        }
        if (typeof event.data !== "string") {
          return;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          // Ignore malformed frames; never let a bad packet break the UI.
          return;
        }

        switch (parsed.kind) {
          case "welcome": {
            if (typeof parsed.salt === "string") {
              saltRef.current = parsed.salt;
            }
            void sendResync(socket);
            break;
          }
          case "ack": {
            if (typeof parsed.seq === "number") {
              pruneBuffer(parsed.seq);
            }
            break;
          }
          case "focus": {
            const nextKind = (parsed.fieldKind ?? null) as FieldKind;
            const changed = nextKind !== fieldKindRef.current;
            fieldKindRef.current = nextKind;
            // Focus rule: a *different* field starts with a fresh, empty
            // capture — text typed into the email field must never replay
            // into the password field. The one exception is while a
            // resync is in flight: the resync_result (adopt/intact/reset)
            // is about to set the capture from the page's own value, and
            // clearing here would race it and wipe the field the verdict
            // just restored. In that case the verdict wins. Buffered ops
            // are dropped together with the capture: they were edits to
            // the old field and must not replay into the new one.
            if (changed && !resyncInFlightRef.current) {
              setCapture("");
              opBufferRef.current = [];
            }
            break;
          }
          case "resync_result": {
            resyncInFlightRef.current = false;
            const appliedSeq = typeof parsed.appliedSeq === "number" ? parsed.appliedSeq : 0;
            pruneBuffer(appliedSeq);
            if (parsed.verdict === "intact") {
              // Resend everything the server has not applied, keeping the
              // original sequence numbers so it can dedupe/ack them.
              for (const entry of [...opBufferRef.current]) {
                if (entry.seq > appliedSeq && socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({ kind: "op", seq: entry.seq, op: entry.op }));
                }
              }
            } else if (parsed.verdict === "adopt") {
              setCapture(typeof parsed.pageValue === "string" ? parsed.pageValue : "");
              opBufferRef.current = [];
            } else if (parsed.verdict === "reset") {
              setCapture("");
              opBufferRef.current = [];
            }
            break;
          }
          case "hint": {
            if (typeof parsed.hint === "string") {
              setHint(parsed.hint as ViewHint);
            }
            break;
          }
          case "state": {
            if (typeof parsed.state === "string") {
              const state = parsed.state as LoginState;
              setLoginState(state);
              onLoginStateRef.current?.(state, typeof parsed.name === "string" ? parsed.name : undefined);
            }
            break;
          }
          case "status": {
            if (typeof parsed.status === "string") {
              onStatusChangeRef.current(parsed.status as SessionStatus);
            }
            break;
          }
          default:
            break;
        }
      };

      socket.onclose = () => {
        if (disposed) {
          return;
        }
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
        // The login session lives server-side, so a dropped view socket
        // is never fatal and never needs a button: reconnect forever
        // (while mounted) with 1s → 2s → 5s-capped backoff. Text typed
        // during the outage keeps buffering locally and flushes via the
        // resync handshake on the next welcome.
        const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(() => {
          if (!disposed) {
            connect();
          }
        }, delay);
      };
      socket.onerror = () => {
        // Reconnect is driven by onclose; an error without a close has
        // nothing extra to do here.
      };
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      if (currentSocket && currentSocket.readyState < WebSocket.CLOSING) {
        currentSocket.close();
      }
      if (socketRef.current === currentSocket) {
        socketRef.current = null;
      }
      if (frameUrlRef.current) {
        URL.revokeObjectURL(frameUrlRef.current);
        frameUrlRef.current = null;
      }
      captureRef.current = "";
      opBufferRef.current = [];
    };
    // Mount-only: callbacks are read through refs (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hintText = loginState === "parked" || hint === "parked" ? "" : HINT_TEXT[hint] ?? HINT_TEXT.default;

  return (
    <section
      className="remote-live-view"
      style={{ position: "relative", width: "100%", overflow: "hidden", background: "#000" }}
    >
      {frameUrl ? (
        <img
          ref={(node) => {
            streamRef.current = node;
          }}
          className="remote-live-frame"
          src={frameUrl}
          alt="Facebook page in the Relist backend browser"
          style={{ display: "block", width: "100%", height: "auto" }}
          draggable={false}
        />
      ) : (
        <div
          ref={(node) => {
            streamRef.current = node;
          }}
          className="remote-live-placeholder"
          style={{ minHeight: 420, width: "100%" }}
        >
          Loading Facebook…
        </div>
      )}

      <input
        ref={captureInputRef}
        className="remote-capture-input"
        type="text"
        aria-label="Keyboard capture"
        // The capture input covers the whole stream and is the tap
        // target. It stays transparent and focusable at all times;
        // font-size ≥16px stops iOS zooming when it takes focus.
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          opacity: 0,
          color: "transparent",
          background: "transparent",
          border: "none",
          outline: "none",
          fontSize: 16,
          padding: 0,
          margin: 0,
        }}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={captureValue}
        onInput={handleCaptureInput}
        onChange={handleCaptureInput}
        onBeforeInput={handleBeforeInput}
        onKeyDown={handleKeyDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
      />

      <button
        type="button"
        className="remote-exit-button"
        aria-label="Close live view"
        onClick={onExit}
        style={{ position: "absolute", top: 10, left: 10, zIndex: 3 }}
      >
        ✕
      </button>
      <span
        className="remote-url-pill"
        style={{ position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", zIndex: 2 }}
      >
        🔒 facebook.com
      </span>
      <p className="remote-hint" style={{ position: "absolute", bottom: 10, left: 12, right: 12, zIndex: 2 }}>
        {hintText}
      </p>
    </section>
  );
}
