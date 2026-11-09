// Live remote view of the backend browser. Login text is forwarded to the
// backend browser, so password and code characters pass through Relist's
// frontend and backend memory before being sent to Facebook. The UI does
// not intentionally persist typed text.

import { useEffect, useRef, useState } from "react";
import type { SessionStatus } from "../types";
import { facebookViewSocketUrl } from "../lib/api";

interface Props {
  onStatusChange: (status: SessionStatus) => void;
}

type SocketState = "connecting" | "open" | "closed";

const SPECIAL_KEYS = ["Backspace", "Enter", "Tab"] as const;

export default function RemoteBrowserView({ onStatusChange }: Props) {
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [socketState, setSocketState] = useState<SocketState>("connecting");
  const [typeValue, setTypeValue] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const frameUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const socket = new WebSocket(facebookViewSocketUrl());
    socket.binaryType = "blob";
    socketRef.current = socket;
    setSocketState("connecting");

    socket.onopen = () => {
      if (!disposed) {
        setSocketState("open");
        setTypeValue("");
      }
    };
    socket.onclose = () => {
      if (!disposed) {
        setSocketState("closed");
        setTypeValue("");
      }
    };
    socket.onerror = () => {
      if (!disposed) {
        setSocketState("closed");
        setTypeValue("");
      }
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
      if (typeof event.data === "string") {
        try {
          const parsed = JSON.parse(event.data) as { kind?: string; status?: SessionStatus };
          if (parsed.kind === "status" && parsed.status) {
            onStatusChange(parsed.status);
          }
        } catch {
          // Ignore malformed status frames; never let an invalid packet break the UI.
        }
      }
    };

    return () => {
      disposed = true;
      if (socket.readyState < WebSocket.CLOSING) {
        socket.close();
      }
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      setTypeValue("");
      if (frameUrlRef.current) {
        URL.revokeObjectURL(frameUrlRef.current);
        frameUrlRef.current = null;
      }
    };
  }, [onStatusChange, retryKey]);

  function send(message: Record<string, unknown>) {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function reconnectView() {
    setFrameUrl(null);
    setTypeValue("");
    setSocketState("connecting");
    setRetryKey((attempt) => attempt + 1);
  }

  function handleFrameClick(event: React.MouseEvent<HTMLImageElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const nx = (event.clientX - rect.left) / rect.width;
    const ny = (event.clientY - rect.top) / rect.height;
    send({ type: "click", nx, ny });
  }

  function handleTypeChange(event: React.ChangeEvent<HTMLInputElement>) {
    const next = event.target.value;
    if (next.length > typeValue.length) {
      send({ type: "type", text: next.slice(typeValue.length) });
      setTypeValue("");
      return;
    }
    setTypeValue(next);
  }

  function handleTypeKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      send({ type: "key", key: event.key });
    }
    if (event.key === "Backspace" && typeValue.length === 0) {
      send({ type: "key", key: "Backspace" });
    }
  }

  let statusLine = "Connecting to the backend browser…";
  if (socketState === "open") {
    statusLine = frameUrl ? "Live — this is Facebook's own page, running on your home server." : "Waiting for the first frame…";
  }
  if (socketState === "closed") {
    statusLine = "Connection to the backend browser closed. Go back and try Connect again.";
  }

  return (
    <section className="card remote-view-card">
      <p className="remote-view-status">
        {socketState === "closed"
          ? "Connection to the backend browser closed. Typed text was cleared; no credentials were saved by this UI."
          : statusLine}
      </p>
      {socketState === "closed" ? (
        <button type="button" className="secondary-button" onClick={reconnectView}>
          Reconnect view
        </button>
      ) : null}
      {frameUrl ? (
        <img
          className="remote-view-frame"
          src={frameUrl}
          alt="Facebook page in the Relist backend browser"
          onClick={handleFrameClick}
        />
      ) : (
        <div className="remote-view-placeholder">Loading Facebook…</div>
      )}
      <p className="remote-view-type-label" id="remote-type-help">
        Tap the page to click, then type here. Passwords and codes pass through Relist's frontend and backend memory before being sent to Facebook; this UI clears typed text and does not intentionally save it.
      </p>
      <input
        id="remote-type-box"
        className="remote-view-type"
        type="text"
        aria-describedby="remote-type-help"
        disabled={socketState !== "open"}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={typeValue}
        onChange={handleTypeChange}
        onKeyDown={handleTypeKeyDown}
        placeholder="Tap a field above, then type"
      />
      <div className="remote-view-keys">
        {SPECIAL_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className="remote-key-button"
            onClick={() => send({ type: "key", key })}
          >
            {key}
          </button>
        ))}
        <button
          type="button"
          className="remote-key-button"
          onClick={() => send({ type: "scroll", dy: 600 })}
        >
          Scroll down
        </button>
        <button
          type="button"
          className="remote-key-button"
          onClick={() => send({ type: "scroll", dy: -600 })}
        >
          Scroll up
        </button>
      </div>
    </section>
  );
}
