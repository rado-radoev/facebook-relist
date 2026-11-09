import { describe, expect, it } from "vitest";
import { buildCorsOrigin, isLoopbackOrigin, isOriginAllowed } from "./corsOrigin.js";

const CONFIGURED = "http://localhost:5173";

describe("isLoopbackOrigin", () => {
  it("accepts localhost on any port", () => {
    expect(isLoopbackOrigin("http://localhost:5173")).toBe(true);
    expect(isLoopbackOrigin("http://localhost:4173")).toBe(true);
    expect(isLoopbackOrigin("https://localhost:9999")).toBe(true);
  });

  it("accepts 127.0.0.1 on any port", () => {
    expect(isLoopbackOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isLoopbackOrigin("http://127.0.0.1:12345")).toBe(true);
  });

  it("accepts the IPv6 loopback spelling", () => {
    expect(isLoopbackOrigin("http://[::1]:5173")).toBe(true);
    expect(isLoopbackOrigin("http://[::1]:8787")).toBe(true);
  });

  it("rejects non-loopback hosts, including lookalikes", () => {
    expect(isLoopbackOrigin("http://example.com:5173")).toBe(false);
    expect(isLoopbackOrigin("http://localhost.evil.com")).toBe(false);
    expect(isLoopbackOrigin("http://192.168.1.20:5173")).toBe(false);
    expect(isLoopbackOrigin("http://127.0.0.2:5173")).toBe(false);
  });

  it("rejects junk and non-http(s) origins", () => {
    expect(isLoopbackOrigin("null")).toBe(false);
    expect(isLoopbackOrigin("")).toBe(false);
    expect(isLoopbackOrigin("not a url")).toBe(false);
    expect(isLoopbackOrigin("file://localhost/etc")).toBe(false);
  });
});

describe("isOriginAllowed", () => {
  it("accepts the configured origin", () => {
    expect(isOriginAllowed(CONFIGURED, CONFIGURED)).toBe(true);
    expect(isOriginAllowed("https://relist.example.ts.net", "https://relist.example.ts.net")).toBe(true);
  });

  it("accepts loopback spellings beyond the configured one", () => {
    expect(isOriginAllowed("http://127.0.0.1:5173", CONFIGURED)).toBe(true);
    expect(isOriginAllowed("http://[::1]:5173", CONFIGURED)).toBe(true);
    expect(isOriginAllowed("http://localhost:4173", CONFIGURED)).toBe(true);
  });

  it("rejects external origins that are not configured", () => {
    expect(isOriginAllowed("http://example.com", CONFIGURED)).toBe(false);
    expect(isOriginAllowed("https://facebook.com", CONFIGURED)).toBe(false);
  });
});

describe("buildCorsOrigin (the @fastify/cors option)", () => {
  function decide(origin: string | undefined): Promise<boolean> {
    return new Promise((resolve, reject) => {
      buildCorsOrigin(CONFIGURED)(origin, (error, allow) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(allow === true);
      });
    });
  }

  it("lets requests without an Origin header through", async () => {
    await expect(decide(undefined)).resolves.toBe(true);
  });

  it("allows loopback and configured origins, rejects external ones", async () => {
    await expect(decide("http://127.0.0.1:5173")).resolves.toBe(true);
    await expect(decide("http://[::1]:4000")).resolves.toBe(true);
    await expect(decide(CONFIGURED)).resolves.toBe(true);
    await expect(decide("http://example.com")).resolves.toBe(false);
  });
});
