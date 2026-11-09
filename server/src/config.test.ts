import { describe, expect, it } from "vitest";
import { loadConfig, parseProxyEnv } from "./config.js";

describe("loadConfig host default", () => {
  it("binds dual-stack by default so both loopback spellings answer", () => {
    expect(loadConfig({}).host).toBe("::");
  });

  it("keeps the HOST env override", () => {
    expect(loadConfig({ HOST: "127.0.0.1" }).host).toBe("127.0.0.1");
    expect(loadConfig({ HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });
});

describe("parseProxyEnv", () => {
  it("parses a full proxy URL", () => {
    const parsed = parseProxyEnv("http://user:p%40ss@proxy.local:3128");
    expect(parsed).toEqual({ server: "http://proxy.local:3128", username: "user", password: "p@ss" });
  });

  it("parses a proxy URL without credentials", () => {
    expect(parseProxyEnv("http://proxy.local:8080")).toEqual({ server: "http://proxy.local:8080" });
  });

  it("returns undefined for empty, none, and garbage values", () => {
    expect(parseProxyEnv(undefined)).toBeUndefined();
    expect(parseProxyEnv("")).toBeUndefined();
    expect(parseProxyEnv("none")).toBeUndefined();
    expect(parseProxyEnv("://not a url")).toBeUndefined();
  });
});
