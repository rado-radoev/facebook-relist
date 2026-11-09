import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMe, facebookViewSocketUrl } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("same-origin API defaults", () => {
  it("uses the current app origin for API and remote-view requests", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ user: { id: "u", name: "Test", email: "test@example.invalid" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    await fetchMe();

    expect(requests).toEqual(["/api/auth/me"]);
    expect(facebookViewSocketUrl()).toBe("ws://localhost:3000/api/facebook/view");
  });
});
