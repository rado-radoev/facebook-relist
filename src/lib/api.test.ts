import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, facebookViewSocketUrl, fetchJobHistory, fetchMe, login, register } from "./api";

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

const VALID_USER = { id: "u1", name: "Test User", email: "test@example.invalid" };

function stubFetch(response: Response) {
  vi.stubGlobal("fetch", vi.fn(async () => response));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("auth payload validation", () => {
  it("fetchMe rejects a 200 with a non-JSON (HTML fallback) body", async () => {
    stubFetch(new Response("<!doctype html><title>Relist</title>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    }));

    await expect(fetchMe()).rejects.toBeInstanceOf(ApiError);
  });

  it("fetchMe rejects a 200 JSON body with no user", async () => {
    stubFetch(jsonResponse({}));

    await expect(fetchMe()).rejects.toBeInstanceOf(ApiError);
  });

  it("fetchMe rejects a 200 user with non-string fields", async () => {
    stubFetch(jsonResponse({ user: { id: 42, name: "Test User", email: "test@example.invalid" } }));

    await expect(fetchMe()).rejects.toBeInstanceOf(ApiError);
  });

  it("fetchMe resolves a well-formed user", async () => {
    stubFetch(jsonResponse({ user: VALID_USER }));

    await expect(fetchMe()).resolves.toEqual(VALID_USER);
  });

  it("login rejects a user-less 200", async () => {
    stubFetch(jsonResponse({}));

    await expect(login("test@example.invalid", "password-123")).rejects.toBeInstanceOf(ApiError);
  });

  it("login resolves a well-formed user", async () => {
    stubFetch(jsonResponse({ user: VALID_USER }));

    await expect(login("test@example.invalid", "password-123")).resolves.toEqual(VALID_USER);
  });

  it("register rejects a user-less 200", async () => {
    stubFetch(jsonResponse({}, 201));

    await expect(register("Test User", "test@example.invalid", "password-123")).rejects.toBeInstanceOf(ApiError);
  });

  it("register resolves a well-formed user", async () => {
    stubFetch(jsonResponse({ user: VALID_USER }, 201));

    await expect(register("Test User", "test@example.invalid", "password-123")).resolves.toEqual(VALID_USER);
  });
});

describe("history payload validation", () => {
  it("fetchJobHistory rejects a 200 body whose history is not a list", async () => {
    stubFetch(jsonResponse({}));

    await expect(fetchJobHistory()).rejects.toBeInstanceOf(ApiError);
  });

  it("fetchJobHistory resolves a list payload", async () => {
    stubFetch(jsonResponse({ history: [] }));

    await expect(fetchJobHistory()).resolves.toEqual([]);
  });
});
