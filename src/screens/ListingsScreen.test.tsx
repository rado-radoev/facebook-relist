import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "../types";
import ListingsScreen from "./ListingsScreen";

const user: CurrentUser = {
  id: "synthetic-user",
  displayName: "Test Person",
  initials: "TP",
  facebookStatus: "connected",
};

function mockApi(response: { listings: unknown[]; syncedAt: string | null }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.origin !== window.location.origin) {
        throw new Error(`Unexpected network request: ${url.href}`);
      }
      if (url.pathname === "/api/listings") {
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected API request: ${url.pathname}`);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ListingsScreen", () => {
  it("keeps an empty successful sync empty instead of showing shared sample listings", async () => {
    mockApi({ listings: [], syncedAt: null });
    render(
      <ListingsScreen
        user={user}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        onOpen={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("No listings with this status.")).toBeTruthy());
    expect(screen.queryByText(/sample listings standing in/i)).toBeNull();
    expect(screen.queryByText("Nintendo Switch Hot Wheels Unleashed 2 Turbocharged")).toBeNull();
  });

  it("does not label unavailable backend data as sample listings", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("synthetic backend unavailable");
    }));
    render(
      <ListingsScreen
        user={user}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        onOpen={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText(/couldn't load your listings/i)).toBeTruthy());
    expect(screen.queryByText(/showing sample listings/i)).toBeNull();
  });
});
