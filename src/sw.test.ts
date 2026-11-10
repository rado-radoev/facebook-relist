import { describe, expect, it } from "vitest";
// The service worker source, imported as raw text (Vite ?raw) so this
// test inspects the exact file the browser registers. The worker itself
// is never executed here, and this repo intentionally has no @types/node,
// so no fs imports are needed.
import swSource from "../public/sw.js?raw";

describe("public/sw.js service worker", () => {
  it("exists and is non-empty", () => {
    expect(typeof swSource).toBe("string");
    expect(swSource.length).toBeGreaterThan(0);
    expect(swSource).toContain("addEventListener");
  });

  it("special-cases /api/ requests as network-only", () => {
    // There is an explicit branch for API paths…
    expect(swSource).toContain('startsWith("/api/")');
    // …and that branch answers straight from the network.
    const apiBranchStart = swSource.indexOf('startsWith("/api/")');
    const apiBranch = swSource.slice(apiBranchStart, apiBranchStart + 300);
    expect(apiBranch).toContain("respondWith(fetch(");
  });

  it("never writes any response to a cache, so /api/ cannot become cache-first", () => {
    // The worker opens no cache and stores nothing at all. If someone
    // later adds caching for /api/ (caches.open + cache.put) or a
    // cacheFirst route, this test fails.
    expect(swSource).not.toContain("caches.open");
    expect(swSource).not.toContain("cache.put");
    expect(swSource).not.toContain(".put(");
    expect(swSource).not.toContain("cacheFirst");
    expect(swSource).not.toContain("CacheFirst");
  });
});
