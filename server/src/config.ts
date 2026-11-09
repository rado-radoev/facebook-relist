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
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("BROWSER_PROXY must be a valid explicit proxy URL");
  }
  if (url.protocol !== "http:") {
    throw new Error("BROWSER_PROXY supports only http:// proxies; TLS proxying is not implemented");
  }
  const proxyHost = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (url.username && !["localhost", "127.0.0.1", "::1"].includes(proxyHost)) {
    throw new Error("Credentials are allowed only for a loopback BROWSER_PROXY because the shim uses plaintext HTTP");
  }
  const proxy: ProxyConfig = { server: `${url.protocol}//${url.host}` };
  if (url.username) {
    proxy.username = decodeURIComponent(url.username);
  }
  if (url.password) {
    proxy.password = decodeURIComponent(url.password);
  }
  return proxy;
}

const LOCAL_ORIGIN_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function isAllowedRequestOrigin(origin: string, configuredOrigin: string): boolean {
  try {
    const actual = new URL(origin);
    const configured = new URL(configuredOrigin);
    const isSerializedOrigin = (value: string, parsed: URL): boolean =>
      parsed.origin === value && !parsed.username && !parsed.password &&
      (parsed.pathname === "" || parsed.pathname === "/") && !parsed.search && !parsed.hash;
    if (!isSerializedOrigin(origin, actual) || !isSerializedOrigin(configuredOrigin, configured)) return false;
    if (origin === configuredOrigin) return true;
    const actualHost = actual.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
    const configuredHost = configured.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
    return actual.protocol === configured.protocol && actual.port === configured.port &&
      LOCAL_ORIGIN_HOSTS.has(actualHost) && LOCAL_ORIGIN_HOSTS.has(configuredHost);
  } catch {
    return false;
  }
}

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  corsOrigin: string;
  cookieSecure: boolean;
  tls?: { keyFile: string; certFile: string };
  /** Explicit browser proxy from BROWSER_PROXY; ambient proxy variables are ignored. */
  browserProxy?: ProxyConfig;
  /** Always false: Facebook TLS certificate validation cannot be bypassed. */
  browserIgnoreCertErrors: boolean;
  /**
   * Sprint 3 safety switch: dry-run jobs. DEFAULT ON — a dry-run job
   * walks every step against the browser but stops before the create
   * submit and before the delete confirm, so it can never change
   * anything on Facebook. Real writes happen only when RELIST_DRY_RUN
   * is explicitly set to "0".
   */
  dryRun: boolean;
  /** Sprint 3: how often the recreate job polls a new listing that is
   *  in review (requirements §3: about every 15 minutes). */
  jobPollIntervalMs: number;
  /** Sprint 3: review is "stuck" after this long (requirements §3: 48h)
   *  — the job stops and alerts; the old listing is NOT deleted. */
  jobStuckAfterMs: number;
}

function parsePositiveMs(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

const serverDir = path.dirname(fileURLToPath(import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawDataDir = env.DATA_DIR ?? "./data";
  const dataDir = path.isAbsolute(rawDataDir)
    ? rawDataDir
    : path.resolve(serverDir, "..", rawDataDir);

  const rawHost = env.HOST ?? "127.0.0.1";
  const normalizedHost = rawHost.replace(/^\[(.*)\]$/, "$1");
  const explicitlyRemote = !["localhost", "127.0.0.1", "::1"].includes(normalizedHost);
  const remote = explicitlyRemote;
  const configuredSecureCookie = env.COOKIE_SECURE === "1";
  if (remote && !configuredSecureCookie) {
    throw new Error("COOKIE_SECURE=1 is required when HOST exposes Relist beyond loopback");
  }
  if (remote && !env.CORS_ORIGIN?.startsWith("https://")) {
    throw new Error("CORS_ORIGIN must be an explicit https:// origin for network deployments");
  }
  if (Boolean(env.TLS_CERT_FILE) !== Boolean(env.TLS_KEY_FILE)) {
    throw new Error("TLS_CERT_FILE and TLS_KEY_FILE must be configured together");
  }
  if (remote && (!env.TLS_CERT_FILE || !env.TLS_KEY_FILE)) {
    throw new Error("TLS_CERT_FILE and TLS_KEY_FILE are required for network deployments");
  }
  if (env.BROWSER_IGNORE_CERT_ERRORS === "1") {
    throw new Error("BROWSER_IGNORE_CERT_ERRORS is prohibited; Facebook certificate validation must remain enabled");
  }

  return {
    port: Number(env.PORT ?? 8787),
    // Bind to loopback by default. A non-loopback HOST requires explicit TLS posture.
    host: rawHost,
    dataDir,
    corsOrigin: env.CORS_ORIGIN ?? "http://localhost:5173",
    cookieSecure: configuredSecureCookie,
    tls: env.TLS_CERT_FILE && env.TLS_KEY_FILE
      ? { certFile: path.resolve(env.TLS_CERT_FILE), keyFile: path.resolve(env.TLS_KEY_FILE) }
      : undefined,
    browserProxy: parseProxyEnv(env.BROWSER_PROXY),
    browserIgnoreCertErrors: false,
    // Live create/delete stays closed pending an owner-approved release gate.
    dryRun: true,
    jobPollIntervalMs: parsePositiveMs(env.RELIST_POLL_INTERVAL_MS, 15 * 60 * 1000),
    jobStuckAfterMs: parsePositiveMs(env.RELIST_STUCK_AFTER_MS, 48 * 60 * 60 * 1000),
  };
}

export const SESSION_COOKIE_NAME = "relist_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
