import { describe, expect, it } from "vitest";
import { isAllowedRequestOrigin, loadConfig, parseProxyEnv } from "./config.js";

describe("loadConfig host default", () => {
  it("binds dual-stack by default", () => {
    expect(loadConfig({}).host).toBe("::");
    expect(loadConfig({}).cookieSecure).toBe(false);
  });

  it("keeps the explicit HOST override and boots network hosts plainly", () => {
    expect(loadConfig({ HOST: "127.0.0.1" }).host).toBe("127.0.0.1");
    // No secure-cookie / https-origin / TLS demands for network binds:
    // this is a home-LAN app (the phone test binds a LAN address) and
    // TLS stays optional.
    expect(loadConfig({ HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    expect(loadConfig({ HOST: "0.0.0.0" }).tls).toBeUndefined();
    expect(loadConfig({ HOST: "192.168.1.20", COOKIE_SECURE: "1" }).cookieSecure).toBe(true);
  });

  it("serves TLS only when both files are configured, and requires them as a pair", () => {
    expect(loadConfig({
      TLS_CERT_FILE: "/tmp/relist-test-cert.pem",
      TLS_KEY_FILE: "/tmp/relist-test-key.pem",
    }).tls).toEqual({ certFile: "/tmp/relist-test-cert.pem", keyFile: "/tmp/relist-test-key.pem" });
    expect(() => loadConfig({ TLS_CERT_FILE: "/tmp/relist-test-cert.pem" })).toThrow(/configured together/);
    expect(() => loadConfig({ TLS_KEY_FILE: "/tmp/relist-test-key.pem" })).toThrow(/configured together/);
  });
});

describe("same-origin request validation", () => {
  it("allows the configured origin and any loopback origin on any port", () => {
    expect(isAllowedRequestOrigin("http://localhost:5173", "http://localhost:5173")).toBe(true);
    expect(isAllowedRequestOrigin("http://127.0.0.1:5173", "http://localhost:5173")).toBe(true);
    expect(isAllowedRequestOrigin("http://localhost:9999", "http://localhost:5173")).toBe(true);
    expect(isAllowedRequestOrigin("http://[::1]:4173", "http://localhost:5173")).toBe(true);
    // Loopback stays allowed even when the configured origin is not
    // loopback (e.g. a LAN address configured for the phone test).
    expect(isAllowedRequestOrigin("http://127.0.0.1:5173", "http://192.168.1.20:5173")).toBe(true);
    expect(isAllowedRequestOrigin("http://192.168.1.20:5173", "http://192.168.1.20:5173")).toBe(true);
  });

  it("rejects non-loopback origins that are not the configured one", () => {
    expect(isAllowedRequestOrigin("https://evil.example", "http://localhost:5173")).toBe(false);
    expect(isAllowedRequestOrigin("https://alias.example", "https://relist.example")).toBe(false);
    expect(isAllowedRequestOrigin("http://localhost.evil.example:5173", "http://localhost:5173")).toBe(false);
    expect(isAllowedRequestOrigin("ftp://localhost:5173", "http://localhost:5173")).toBe(false);
    expect(isAllowedRequestOrigin("not an origin", "http://localhost:5173")).toBe(false);
  });
});

describe("owner dry-run switch", () => {
  it("defaults to dry-run and only RELIST_DRY_RUN=0 enables real writes", () => {
    expect(loadConfig({}).dryRun).toBe(true);
    expect(loadConfig({ RELIST_DRY_RUN: "1" }).dryRun).toBe(true);
    expect(loadConfig({ RELIST_DRY_RUN: "0" }).dryRun).toBe(false);
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

  it("refuses the certificate-validation bypass", () => {
    expect(() => loadConfig({ BROWSER_IGNORE_CERT_ERRORS: "1" })).toThrow(/certificate/i);
  });
});
