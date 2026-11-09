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
  it("lets the signed-in user sign out without a settings screen", async () => {
    api.fetchMe.mockResolvedValue({ id: "user-1", name: "Test Person", email: "test@example.invalid" });
    api.fetchFacebookStatus.mockResolvedValue("not_connected");
    api.fetchListings.mockResolvedValue({ listings: [], syncedAt: null });
    api.logout.mockResolvedValue(undefined);

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign out of Relist" }));
    await waitFor(() => expect(api.logout).toHaveBeenCalledOnce());
    expect(await screen.findByRole("heading", { name: "Sign in to Relist" })).toBeTruthy();
  });

  it("keeps the session visible and offers retry when sign out fails", async () => {
    api.fetchMe.mockResolvedValue({ id: "user-1", name: "Test Person", email: "test@example.invalid" });
    api.fetchFacebookStatus.mockResolvedValue("not_connected");
    api.fetchListings.mockResolvedValue({ listings: [], syncedAt: null });
    api.logout.mockRejectedValueOnce(new Error("synthetic revoke failure"));

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign out of Relist" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/synthetic revoke failure/i);
    expect(screen.queryByRole("heading", { name: "Sign in to Relist" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out of Relist" })).toBeTruthy();
  });
});
