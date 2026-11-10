import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const api = vi.hoisted(() => ({
  disconnectFacebook: vi.fn(),
  fetchFacebookStatus: vi.fn(),
  fetchListings: vi.fn(),
  fetchMe: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  register: vi.fn(),
  syncListings: vi.fn(),
}));

vi.mock("./lib/api", () => api);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("App session controls", () => {
  it("shows no sign-out control to the signed-in user (owner ruling)", async () => {
    api.fetchMe.mockResolvedValue({ id: "user-1", name: "Test Person", email: "test@example.invalid" });
    api.fetchFacebookStatus.mockResolvedValue("not_connected");
    api.fetchListings.mockResolvedValue({ listings: [], syncedAt: null });

    render(<App />);

    // The signed-in shell renders (tab bar is only shown when signed in)…
    expect(await screen.findByRole("button", { name: /listings/i })).toBeTruthy();
    // …and there is no sign-out button anywhere on the screen. The
    // backend logout endpoint still exists; the UI intentionally has
    // no sign-out control.
    expect(screen.queryByRole("button", { name: "Sign out of Relist" })).toBeNull();
    expect(api.logout).not.toHaveBeenCalled();
  });

  it("refetches the Facebook status when the app returns to the foreground", async () => {
    api.fetchMe.mockResolvedValue({ id: "user-1", name: "Test Person", email: "test@example.invalid" });
    api.fetchFacebookStatus.mockResolvedValue("not_connected");
    api.fetchListings.mockResolvedValue({ listings: [], syncedAt: null });

    render(<App />);
    expect(await screen.findByRole("button", { name: /listings/i })).toBeTruthy();
    await waitFor(() => expect(api.fetchFacebookStatus).toHaveBeenCalledTimes(1));

    // A visibilitychange while hidden must NOT refetch…
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    expect(api.fetchFacebookStatus).toHaveBeenCalledTimes(1);

    // …but becoming visible again refetches the server's current truth,
    // and so does a plain window focus.
    api.fetchFacebookStatus.mockResolvedValue("connected");
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(api.fetchFacebookStatus).toHaveBeenCalledTimes(2));

    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(api.fetchFacebookStatus).toHaveBeenCalledTimes(3));
  });

  it("shows the sign-in screen when there is no session", async () => {
    api.fetchMe.mockRejectedValue(new Error("not signed in"));

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Sign in to Relist" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out of Relist" })).toBeNull();
  });
});
