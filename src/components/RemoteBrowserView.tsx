// Live remote view of the backend browser: the server streams screenshots
// of Facebook's own page, and taps/keystrokes are forwarded straight into
// that page. The type box below forwards each character the moment it is
// typed and immediately clears itself — it never holds or submits a
// credential anywhere; our API has no endpoint that accepts one.

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
  const socketRef = useRef<WebSocket | null>(null);
  const frameUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const socket = new WebSocket(facebookViewSocketUrl());
    socket.binaryType = "blob";
    socketRef.current = socket;

    socket.onopen = () => setSocketState("open");
    socket.onclose = () => setSocketState("closed");
    socket.onmessage = (event: MessageEvent) => {
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
        const parsed = JSON.parse(event.data) as { kind?: string; status?: SessionStatus };
        if (parsed.kind === "status" && parsed.status) {
          onStatusChange(parsed.status);
        }
      }
    };

    return () => {
      socket.close();
      socketRef.current = null;
      if (frameUrlRef.current) {
        URL.revokeObjectURL(frameUrlRef.current);
        frameUrlRef.current = null;
      }
    };
  }, [onStatusChange]);

  function send(message: Record<string, unknown>) {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
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
      <p className="remote-view-status">{statusLine}</p>
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
      <label className="remote-view-type-label" htmlFor="remote-type-box">
        Tap the page to click, then type here — keystrokes go straight into Facebook's page:
      </label>
      <input
        id="remote-type-box"
        className="remote-view-type"
        type="text"
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
