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

/**
 * Request-origin policy for state-changing HTTP requests and the
 * browser WebSocket (the @fastify/cors plugin uses the matching policy
 * in corsOrigin.ts). The configured CORS_ORIGIN is always allowed. In
 * addition, any origin whose host is a loopback name (localhost,
 * 127.0.0.1, [::1]) is allowed on ANY port: a local run can be opened
 * through several loopback spellings, and which one the browser uses
 * depends on its resolver, so pinning local access to one exact origin
 * string made sign-in fail with "could not reach the backend" on
 * otherwise-correct setups. Loopback origins can only come from the
 * same machine, so this does not widen access for anyone off the box.
 * Every other non-configured origin is rejected.
 */
export function isAllowedRequestOrigin(origin: string, configuredOrigin: string): boolean {
  if (origin === configuredOrigin) {
    return true;
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  // WHATWG URL keeps the brackets on IPv6 hostnames ("[::1]"); strip
  // them so the comparison matches both spellings.
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return LOCAL_ORIGIN_HOSTS.has(host);
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

  if (Boolean(env.TLS_CERT_FILE) !== Boolean(env.TLS_KEY_FILE)) {
    throw new Error("TLS_CERT_FILE and TLS_KEY_FILE must be configured together");
  }
  if (env.BROWSER_IGNORE_CERT_ERRORS === "1") {
    throw new Error("BROWSER_IGNORE_CERT_ERRORS is prohibited; Facebook certificate validation must remain enabled");
  }

  return {
    port: Number(env.PORT ?? 8787),
    // Dual-stack bind by default: "::" answers on both IPv6 (::1) and
    // IPv4 (127.0.0.1) and on the machine's LAN addresses, so the phone
    // on the home network can reach the backend. Some browsers resolve
    // "localhost" to ::1 first, so an IPv4-only bind makes the backend
    // unreachable depending on which loopback spelling the browser
    // picks. HOST overrides; binding a LAN/wildcard host boots plainly
    // (this is a home-LAN app — TLS below stays optional).
    host: env.HOST ?? "::",
    dataDir,
    corsOrigin: env.CORS_ORIGIN ?? "http://localhost:5173",
    cookieSecure: env.COOKIE_SECURE === "1",
    // TLS is optional: served only when both files are configured.
    tls: env.TLS_CERT_FILE && env.TLS_KEY_FILE
      ? { certFile: path.resolve(env.TLS_CERT_FILE), keyFile: path.resolve(env.TLS_KEY_FILE) }
      : undefined,
    browserProxy: parseProxyEnv(env.BROWSER_PROXY),
    browserIgnoreCertErrors: false,
    // Owner's safety switch: dry-run unless RELIST_DRY_RUN is exactly
    // "0". Captured onto each job at creation (see jobService).
    dryRun: env.RELIST_DRY_RUN !== "0",
    jobPollIntervalMs: parsePositiveMs(env.RELIST_POLL_INTERVAL_MS, 15 * 60 * 1000),
    jobStuckAfterMs: parsePositiveMs(env.RELIST_STUCK_AFTER_MS, 48 * 60 * 60 * 1000),
  };
}

export const SESSION_COOKIE_NAME = "relist_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
