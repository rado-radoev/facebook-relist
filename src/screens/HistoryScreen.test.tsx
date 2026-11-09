import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HistoryScreen from "./HistoryScreen";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HistoryScreen", () => {
  it("does not show sample history when the signed-in user's history is empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("synthetic backend unavailable");
    }));
    render(<HistoryScreen />);

    await waitFor(() => expect(screen.getByText(/couldn't reach the backend/i)).toBeTruthy());
    expect(screen.queryByText(/Oct 12, 2026/)).toBeNull();
    expect(screen.queryByText(/sample from the preview/i)).toBeNull();
  });
});
