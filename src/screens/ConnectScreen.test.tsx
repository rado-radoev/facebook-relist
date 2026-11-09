import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConnectScreen from "./ConnectScreen";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  connectFacebook: vi.fn(),
}));

afterEach(cleanup);

describe("ConnectScreen", () => {
  it("discloses that Facebook login characters pass through Relist", () => {
    render(
      <ConnectScreen
        facebookStatus="not_connected"
        onStatusChange={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByText(/characters pass through relist's frontend and backend memory/i)).toBeTruthy();
    expect(screen.queryByText(/relist never sees your password/i)).toBeNull();
  });
});
