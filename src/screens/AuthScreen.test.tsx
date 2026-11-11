import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthScreen from "./AuthScreen";
import { fetchAuthConfig, loginWithFacebookCode } from "../lib/api";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    details: Record<string, unknown>;
    constructor(status: number, message: string, details: Record<string, unknown> = {}) {
      super(message);
      this.status = status;
      this.details = details;
    }
  },
  fetchAuthConfig: vi.fn(async () => ({ facebookLoginEnabled: false })),
  facebookLoginStartUrl: vi.fn(() => "/api/auth/facebook/start"),
  login: vi.fn(async () => ({ id: "u1", name: "Test User", email: "test@example.invalid" })),
  register: vi.fn(async () => ({ id: "u1", name: "Test User", email: "test@example.invalid" })),
  loginWithFacebookCode: vi.fn(async () => ({
    id: "u9",
    name: "Code User",
    email: "code@example.invalid",
  })),
}));

const fetchAuthConfigMock = vi.mocked(fetchAuthConfig);
const loginWithFacebookCodeMock = vi.mocked(loginWithFacebookCode);

beforeEach(() => {
  vi.clearAllMocks();
  fetchAuthConfigMock.mockResolvedValue({ facebookLoginEnabled: false });
  loginWithFacebookCodeMock.mockResolvedValue({
    id: "u9",
    name: "Code User",
    email: "code@example.invalid",
  });
});

afterEach(() => {
  cleanup();
});

describe("AuthScreen Facebook sign-in", () => {
  it("hides the Facebook button when the backend has it disabled", async () => {
    render(<AuthScreen onSignedIn={vi.fn()} />);
    // The password form is there immediately…
    expect(screen.getByText("Sign in to Relist")).toBeTruthy();
    // …and stays the only way in once the config answer arrives.
    await waitFor(() => expect(fetchAuthConfigMock).toHaveBeenCalled());
    expect(screen.queryByText("Continue with Facebook")).toBeNull();
    expect(screen.queryByText("I have a sign-in code")).toBeNull();
  });

  it("hides the Facebook button when the config fetch fails", async () => {
    fetchAuthConfigMock.mockRejectedValue(new Error("backend unreachable"));
    render(<AuthScreen onSignedIn={vi.fn()} />);
    await waitFor(() => expect(fetchAuthConfigMock).toHaveBeenCalled());
    expect(screen.queryByText("Continue with Facebook")).toBeNull();
  });

  it("shows the Facebook button and the 'or' divider when enabled", async () => {
    fetchAuthConfigMock.mockResolvedValue({ facebookLoginEnabled: true });
    render(<AuthScreen onSignedIn={vi.fn()} />);
    const link = await screen.findByRole("link", { name: "Continue with Facebook" });
    expect(link.getAttribute("href")).toBe("/api/auth/facebook/start");
    expect(screen.getByText("or")).toBeTruthy();
    // The password form is still there, below the divider.
    expect(screen.getByText("Sign in to Relist")).toBeTruthy();
  });

  it("signs in through the one-time code form", async () => {
    fetchAuthConfigMock.mockResolvedValue({ facebookLoginEnabled: true });
    const onSignedIn = vi.fn();
    render(<AuthScreen onSignedIn={onSignedIn} />);
    fireEvent.click(await screen.findByText("I have a sign-in code"));
    const input = await screen.findByLabelText("One-time sign-in code");
    fireEvent.change(input, { target: { value: " abcd2345 " } });
    fireEvent.click(screen.getByText("Use this code"));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(loginWithFacebookCodeMock).toHaveBeenCalledWith("abcd2345");
    expect(onSignedIn).toHaveBeenCalledWith({
      id: "u9",
      name: "Code User",
      email: "code@example.invalid",
    });
  });

  it("shows the error and stays signed out when the code is rejected", async () => {
    fetchAuthConfigMock.mockResolvedValue({ facebookLoginEnabled: true });
    const { ApiError } = await import("../lib/api");
    loginWithFacebookCodeMock.mockRejectedValue(
      new ApiError(401, "That code isn't valid — it may have expired or already been used."),
    );
    const onSignedIn = vi.fn();
    render(<AuthScreen onSignedIn={onSignedIn} />);
    fireEvent.click(await screen.findByText("I have a sign-in code"));
    const input = await screen.findByLabelText("One-time sign-in code");
    fireEvent.change(input, { target: { value: "ZZZZZZZZ" } });
    fireEvent.click(screen.getByText("Use this code"));
    expect(await screen.findByText(/That code isn't valid/)).toBeTruthy();
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});
