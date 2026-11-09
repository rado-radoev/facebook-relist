import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RemoteBrowserView from "./RemoteBrowserView";

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  finishClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

afterEach(() => {
  cleanup();
  MockWebSocket.instances = [];
  vi.unstubAllGlobals();
});

describe("RemoteBrowserView", () => {
  it("offers an in-place retry after the remote browser socket closes", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    render(<RemoteBrowserView onStatusChange={vi.fn()} />);

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    MockWebSocket.instances[0].finishClose();

    fireEvent.click(await screen.findByRole("button", { name: "Reconnect view" }));

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    expect(screen.getByText("Connecting to the backend browser…")).toBeTruthy();
  });
});
