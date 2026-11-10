import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConnectionCard from "./ConnectionCard";
import type { CurrentUser, SessionStatus } from "../types";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderCard(facebookStatus: SessionStatus) {
  const user: CurrentUser = {
    id: "user-1",
    displayName: "Test Person",
    initials: "TP",
    facebookStatus,
  };
  const onConnect = vi.fn();
  const onDisconnect = vi.fn();
  render(<ConnectionCard user={user} onConnect={onConnect} onDisconnect={onDisconnect} />);
  return { onConnect, onDisconnect };
}

describe("ConnectionCard", () => {
  it("verifying shows a verifying card with no working Connect button", () => {
    const { onConnect } = renderCard("verifying");
    expect(screen.getByText("Verifying your Facebook session")).toBeTruthy();
    expect(screen.getByText("Confirming with Facebook — this can take a moment")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Verifying…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("profile_busy shows a busy card whose button calls onConnect", () => {
    const { onConnect } = renderCard("profile_busy");
    expect(screen.getByText("The browser is busy")).toBeTruthy();
    expect(screen.getByText("Finishing another task — try again in a moment")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("not_connected still offers Connect Facebook (existing behavior)", () => {
    const { onConnect } = renderCard("not_connected");
    fireEvent.click(screen.getByRole("button", { name: "Connect Facebook" }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("connected still shows the account and Disconnect (existing behavior)", () => {
    const { onDisconnect } = renderCard("connected");
    expect(screen.getByText("Connected as Test Person")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});
