import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RemoteBrowserView from "./RemoteBrowserView";

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = 0;
  binaryType = "";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  finishClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  message(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  jsonMessage(payload: Record<string, unknown>): void {
    this.message(JSON.stringify(payload));
  }

  sentJson(): Array<Record<string, unknown>> {
    return this.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }
}

let blobCounter = 0;

beforeEach(() => {
  vi.stubGlobal("WebSocket", MockWebSocket);
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(
    () => `blob:mock-${(blobCounter += 1)}`,
  );
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 200,
    height: 100,
    right: 200,
    bottom: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  cleanup();
  MockWebSocket.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderAndWelcome() {
  const onStatusChange = vi.fn();
  const onLoginState = vi.fn();
  const onExit = vi.fn();
  const utils = render(
    <RemoteBrowserView onStatusChange={onStatusChange} onLoginState={onLoginState} onExit={onExit} />,
  );
  await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.jsonMessage({ kind: "welcome", sessionId: "s1", salt: "salty" });
  // Resync is sent after the (async) fingerprint is computed.
  await waitFor(() =>
    expect(socket.sentJson().some((message) => message.kind === "resync")).toBe(true),
  );
  return { ...utils, socket, onStatusChange, onLoginState, onExit };
}

function captureInput(): HTMLInputElement {
  return screen.getByLabelText("Keyboard capture") as HTMLInputElement;
}

describe("RemoteBrowserView", () => {
  it("sends a resync with a null fingerprint when the capture is empty on welcome", async () => {
    const { socket } = await renderAndWelcome();
    const resync = socket.sentJson().find((message) => message.kind === "resync");
    expect(resync).toEqual({ kind: "resync", lastAck: 0, fingerprint: null });
  });

  it("renders an incoming JPEG frame", async () => {
    const { socket } = await renderAndWelcome();
    socket.message(new Blob(["jpeg-bytes"], { type: "image/jpeg" }));
    const img = (await screen.findByAltText(
      "Facebook page in the Relist backend browser",
    )) as HTMLImageElement;
    expect(img.src).toContain("blob:mock-");
  });

  it("tap sends a normalized tap message and focuses the capture input", async () => {
    const { socket } = await renderAndWelcome();
    const input = captureInput();
    fireEvent.click(input, { clientX: 50, clientY: 25 });
    expect(document.activeElement).toBe(input);
    expect(socket.sentJson()).toContainEqual({ kind: "tap", nx: 0.25, ny: 0.25 });
  });

  it("touch tap also sends a tap message and focuses the capture input", async () => {
    const { socket } = await renderAndWelcome();
    const input = captureInput();
    fireEvent.touchStart(input, { touches: [{ clientX: 100, clientY: 50 }] });
    fireEvent.touchEnd(input, { changedTouches: [{ clientX: 100, clientY: 50 }] });
    expect(document.activeElement).toBe(input);
    expect(socket.sentJson()).toContainEqual({ kind: "tap", nx: 0.5, ny: 0.5 });
  });

  it("typing produces an insert op with a sequence number", async () => {
    const { socket } = await renderAndWelcome();
    fireEvent.change(captureInput(), { target: { value: "a" } });
    expect(socket.sentJson()).toContainEqual({
      kind: "op",
      seq: 1,
      op: { type: "insert", text: "a" },
    });
    expect(captureInput().value).toBe("a");
  });

  it("backspace produces a deleteBackward op", async () => {
    const { socket } = await renderAndWelcome();
    const input = captureInput();
    fireEvent.change(input, { target: { value: "ab" } });
    fireEvent.change(input, { target: { value: "a" } });
    expect(socket.sentJson()).toContainEqual({
      kind: "op",
      seq: 2,
      op: { type: "deleteBackward", count: 1 },
    });
  });

  it("Enter sends a key op and does not enter the capture", async () => {
    const { socket } = await renderAndWelcome();
    const input = captureInput();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(socket.sentJson()).toContainEqual({
      kind: "op",
      seq: 1,
      op: { type: "key", key: "Enter" },
    });
    expect(input.value).toBe("");
  });

  it("tracks acks and resends unacked ops after an intact resync verdict on reconnect", async () => {
    const { socket } = await renderAndWelcome();
    const input = captureInput();
    fireEvent.change(input, { target: { value: "hi" } });
    expect(socket.sentJson()).toContainEqual({
      kind: "op",
      seq: 1,
      op: { type: "insert", text: "hi" },
    });
    // Ack only part of the stream conceptually: no ack for seq 1 at all.
    socket.finishClose();

    // Backoff is 1s for the first reconnect.
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2), { timeout: 3000 });
    const socket2 = MockWebSocket.instances[1];
    socket2.open();
    socket2.jsonMessage({ kind: "welcome", sessionId: "s1", salt: "salty" });
    await waitFor(() =>
      expect(socket2.sentJson().some((message) => message.kind === "resync")).toBe(true),
    );
    const resync = socket2.sentJson().find((message) => message.kind === "resync");
    expect(resync?.lastAck).toBe(0);
    // Fingerprint of "hi" under the salt: 16 hex chars, never null here.
    expect(typeof resync?.fingerprint === "string" ? resync.fingerprint : null).toMatch(
      /^[0-9a-f]{16}$/,
    );

    socket2.jsonMessage({ kind: "resync_result", verdict: "intact", appliedSeq: 0 });
    expect(socket2.sentJson()).toContainEqual({
      kind: "op",
      seq: 1,
      op: { type: "insert", text: "hi" },
    });
  });

  it("an ack prunes the buffer so an intact verdict does not resend acked ops", async () => {
    const { socket } = await renderAndWelcome();
    fireEvent.change(captureInput(), { target: { value: "x" } });
    socket.jsonMessage({ kind: "ack", seq: 1 });
    socket.jsonMessage({ kind: "resync_result", verdict: "intact", appliedSeq: 1 });
    const opCount = socket.sentJson().filter((message) => message.kind === "op").length;
    expect(opCount).toBe(1);
  });

  it("a reset verdict clears the capture", async () => {
    const { socket } = await renderAndWelcome();
    const input = captureInput();
    fireEvent.change(input, { target: { value: "secret" } });
    expect(input.value).toBe("secret");
    socket.jsonMessage({ kind: "resync_result", verdict: "reset", appliedSeq: 0 });
    await waitFor(() => expect(captureInput().value).toBe(""));
  });

  it("an adopt verdict replaces the capture with the page value", async () => {
    const { socket } = await renderAndWelcome();
    fireEvent.change(captureInput(), { target: { value: "partial" } });
    socket.jsonMessage({
      kind: "resync_result",
      verdict: "adopt",
      appliedSeq: 1,
      pageValue: "full@example.com",
    });
    await waitFor(() => expect(captureInput().value).toBe("full@example.com"));
  });

  it("forwards status and login-state messages and shows the hint text", async () => {
    const { socket, onStatusChange, onLoginState } = await renderAndWelcome();
    socket.jsonMessage({ kind: "status", status: "needs_check" });
    expect(onStatusChange).toHaveBeenCalledWith("needs_check");
    socket.jsonMessage({ kind: "hint", hint: "code_entry" });
    expect(await screen.findByText("Enter the code Facebook sent you")).toBeTruthy();
    socket.jsonMessage({ kind: "state", state: "connected", name: "Test Person" });
    expect(onLoginState).toHaveBeenCalledWith("connected", "Test Person");
  });

  it("has no type box, no key buttons, and no reconnect button", async () => {
    await renderAndWelcome();
    expect(screen.queryByPlaceholderText(/Tap a field above/)).toBeNull();
    expect(screen.queryByText(/Tap the page to click, then type here/)).toBeNull();
    for (const name of ["Backspace", "Enter", "Tab", "Scroll down", "Scroll up", "Reconnect view"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByText("🔒 facebook.com")).toBeTruthy();
    expect(screen.getByText("Tap a field to type — use your keyboard like normal")).toBeTruthy();
  });
});
