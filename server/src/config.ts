import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

/**
 * Parse a proxy URL (http://user:pass@host:port) into Playwright's proxy
 * shape. Returns undefined for empty/invalid values and for "none".
 */
export function parseProxyEnv(raw: string | undefined): ProxyConfig | undefined {
  if (!raw || raw === "none") {
    return undefined;
  }
  try {
    const url = new URL(raw);
    const proxy: ProxyConfig = { server: `${url.protocol}//${url.host}` };
    if (url.username) {
      proxy.username = decodeURIComponent(url.username);
    }
    if (url.password) {
      proxy.password = decodeURIComponent(url.password);
    }
    return proxy;
  } catch {
    return undefined;
  }
}

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  corsOrigin: string;
  cookieSecure: boolean;
  /**
   * Proxy for the backend browser, from BROWSER_PROXY or the standard
   * HTTPS_PROXY env. Needed inside sandboxes with an egress proxy; on the
   * home server there is normally no proxy env and the browser connects
   * directly. Never logged (it can carry credentials).
   */
  browserProxy?: ProxyConfig;
  /**
   * Sandbox-only escape hatch: ignore TLS certificate errors in the
   * backend browser. Needed where an egress proxy MITMs TLS with a local
   * CA that Chromium does not trust. NEVER enable on the home server —
   * there the browser must verify Facebook's real certificates.
   */
  browserIgnoreCertErrors: boolean;
}

const serverDir = path.dirname(fileURLToPath(import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawDataDir = env.DATA_DIR ?? "./data";
  const dataDir = path.isAbsolute(rawDataDir)
    ? rawDataDir
    : path.resolve(serverDir, "..", rawDataDir);

  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "0.0.0.0",
    dataDir,
    corsOrigin: env.CORS_ORIGIN ?? "http://localhost:5173",
    cookieSecure: env.COOKIE_SECURE === "1",
    browserProxy: parseProxyEnv(env.BROWSER_PROXY ?? env.HTTPS_PROXY ?? env.https_proxy),
    browserIgnoreCertErrors: env.BROWSER_IGNORE_CERT_ERRORS === "1",
  };
}

export const SESSION_COOKIE_NAME = "relist_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
