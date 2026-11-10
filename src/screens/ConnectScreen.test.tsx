import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConnectScreen from "./ConnectScreen";
import { connectFacebook } from "../lib/api";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  connectFacebook: vi.fn(async () => "login_in_progress"),
}));

vi.mock("../components/RemoteBrowserView", async () => {
  const React = await import("react");
  return {
    default: (props: {
      onLoginState?: (state: string, name?: string) => void;
      onExit?: () => void;
    }) =>
      React.createElement(
        "div",
        null,
        React.createElement("span", null, "Mock remote view"),
        React.createElement(
          "button",
          { type: "button", onClick: () => props.onLoginState?.("parked") },
          "Trigger parked",
        ),
        React.createElement(
          "button",
          { type: "button", onClick: () => props.onLoginState?.("connected", "Test Person") },
          "Trigger connected",
        ),
        React.createElement(
          "button",
          { type: "button", onClick: () => props.onLoginState?.("connected") },
          "Trigger connected unnamed",
        ),
      ),
  };
});

const DISCLOSURE =
  "When you sign in here, your Facebook password passes briefly through this app's memory on your own home server before Facebook receives it — it is never saved or logged, but if that server were compromised at that exact moment, the password could be captured, so use a password you don't reuse anywhere else.";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderScreen(facebookStatus: "not_connected" | "connected" | "login_in_progress" = "not_connected") {
  const onStatusChange = vi.fn();
  const onBack = vi.fn();
  const utils = render(
    <ConnectScreen facebookStatus={facebookStatus} onStatusChange={onStatusChange} onBack={onBack} />,
  );
  return { ...utils, onStatusChange, onBack };
}

describe("ConnectScreen", () => {
  it("shows the disclosure sentence verbatim in its own card", () => {
    renderScreen();
    expect(screen.getByText(DISCLOSURE)).toBeTruthy();
    expect(screen.queryByText(/relist never sees your password/i)).toBeNull();
  });

  it("keeps the Start button disabled until a sign-in method is chosen, and the code choice enables it", () => {
    renderScreen();
    const start = screen.getByRole("button", { name: "Open Facebook login" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "A code (text message or authenticator app)" }));
    expect(start.disabled).toBe(false);
  });

  it("the passkey choice blocks start and shows the explanation", () => {
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "A security key or passkey" }));
    expect(
      screen.getByText(
        "That kind of sign-in can't be completed in Relist's browser. In Facebook Settings → Password and security, add a text-message or authenticator code option first, then come back.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Facebook login" })).toBeNull();
  });

  it("starting with the code choice calls connectFacebook and shows the live view", async () => {
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "A code (text message or authenticator app)" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Facebook login" }));
    expect(connectFacebook).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Mock remote view")).toBeTruthy();
  });

  it("resumes an in-flight login on mount", () => {
    renderScreen("login_in_progress");
    expect(screen.getByText("Mock remote view")).toBeTruthy();
  });

  it("renders the parked screen when the login parks", async () => {
    const { onBack } = renderScreen("login_in_progress");
    fireEvent.click(screen.getByRole("button", { name: "Trigger parked" }));
    expect(
      await screen.findByText(
        "Facebook is checking this login. Nothing is wrong, and there is nothing for you to do",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("renders the success screen with the account name when the login connects", async () => {
    const { onStatusChange, onBack } = renderScreen("login_in_progress");
    fireEvent.click(screen.getByRole("button", { name: "Trigger connected" }));
    expect(await screen.findByText("You're in — Connected as Test Person")).toBeTruthy();
    expect(onStatusChange).toHaveBeenCalledWith("connected");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("renders the success screen without a name when none is provided", async () => {
    renderScreen("login_in_progress");
    fireEvent.click(screen.getByRole("button", { name: "Trigger connected unnamed" }));
    expect(await screen.findByText("You're in — Connected")).toBeTruthy();
  });

  it("an already-connected status shows the simple connected note, not the success screen", () => {
    renderScreen("connected");
    expect(screen.getByText("Facebook is connected ✓")).toBeTruthy();
    expect(screen.queryByText(/You're in/)).toBeNull();
  });
});
