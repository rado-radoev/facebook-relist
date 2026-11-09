import { describe, expect, it } from "vitest";
import { isAllowedRequestOrigin, loadConfig, parseProxyEnv } from "./config.js";

describe("loadConfig host default", () => {
  it("binds only to loopback by default", () => {
    expect(loadConfig({}).host).toBe("127.0.0.1");
    expect(loadConfig({}).cookieSecure).toBe(false);
  });

  it("requires explicit secure posture for wildcard IPv6 binds", () => {
    expect(() => loadConfig({ HOST: "::" })).toThrow(/COOKIE_SECURE/);
  });

  it("keeps the explicit HOST override when secure network posture is declared", () => {
    expect(loadConfig({
      HOST: "127.0.0.1",
      COOKIE_SECURE: "0",
    }).host).toBe("127.0.0.1");
    expect(() => loadConfig({
      HOST: "0.0.0.0",
      CORS_ORIGIN: "https://relist.example",
      COOKIE_SECURE: "1",
    })).toThrow(/TLS_CERT_FILE/);
    expect(loadConfig({
      HOST: "0.0.0.0",
      CORS_ORIGIN: "https://relist.example",
      COOKIE_SECURE: "1",
      TLS_CERT_FILE: "/tmp/relist-test-cert.pem",
      TLS_KEY_FILE: "/tmp/relist-test-key.pem",
    }).host).toBe("0.0.0.0");
  });
});

describe("same-origin request validation", () => {
  it("allows only exact origins and same-port loopback aliases for local development", () => {
    expect(isAllowedRequestOrigin("http://localhost:5173", "http://localhost:5173")).toBe(true);
    expect(isAllowedRequestOrigin("http://127.0.0.1:5173", "http://localhost:5173")).toBe(true);
    expect(isAllowedRequestOrigin("http://localhost:9999", "http://localhost:5173")).toBe(false);
    expect(isAllowedRequestOrigin("http://localhost:5173/attacker", "http://localhost:5173")).toBe(false);
    expect(isAllowedRequestOrigin("http://user@localhost:5173", "http://localhost:5173")).toBe(false);
    expect(isAllowedRequestOrigin("https://evil.example", "http://localhost:5173")).toBe(false);
    expect(isAllowedRequestOrigin("https://alias.example", "https://relist.example")).toBe(false);
  });
});

describe("live-write posture", () => {
  it("keeps live mutations disabled even when the legacy dry-run toggle is false", () => {
    expect(loadConfig({ RELIST_DRY_RUN: "0" }).dryRun).toBe(true);
  });
});

describe("parseProxyEnv", () => {
  it("parses a full proxy URL for a local credential-terminating shim", () => {
    const parsed = parseProxyEnv("http://user:p%40ss@127.0.0.1:3128");
    expect(parsed).toEqual({ server: "http://127.0.0.1:3128", username: "user", password: "p@ss" });
  });

  it("parses a proxy URL without credentials", () => {
    expect(parseProxyEnv("http://proxy.local:8080")).toEqual({ server: "http://proxy.local:8080" });
  });

  it("ignores ambient proxy variables and accepts only explicit HTTP proxies", () => {
    expect(loadConfig({ HTTPS_PROXY: "http://ambient-proxy:8080" }).browserProxy).toBeUndefined();
    expect(loadConfig({ BROWSER_PROXY: "http://proxy.local:8080" }).browserProxy)
      .toEqual({ server: "http://proxy.local:8080" });
    expect(() => loadConfig({ BROWSER_PROXY: "https://proxy.local:443" })).toThrow(/proxy/i);
  });

  it("requires an explicit secure-cookie and TLS-termination posture off loopback", () => {
    expect(() => loadConfig({ HOST: "0.0.0.0", CORS_ORIGIN: "https://relist.example" }))
      .toThrow(/COOKIE_SECURE/);
    expect(loadConfig({
      HOST: "0.0.0.0",
      CORS_ORIGIN: "https://relist.example",
      COOKIE_SECURE: "1",
      TLS_CERT_FILE: "/tmp/relist-test-cert.pem",
      TLS_KEY_FILE: "/tmp/relist-test-key.pem",
    })).toMatchObject({ cookieSecure: true, tls: { certFile: "/tmp/relist-test-cert.pem", keyFile: "/tmp/relist-test-key.pem" } });
  });

  it("refuses the certificate-validation bypass", () => {
    expect(() => loadConfig({ BROWSER_IGNORE_CERT_ERRORS: "1" })).toThrow(/certificate/i);
  });
});
