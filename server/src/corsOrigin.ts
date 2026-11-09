/**
 * CORS origin policy for the backend.
 *
 * The configured CORS_ORIGIN is always allowed. In addition, any origin
 * whose host is a loopback name (localhost, 127.0.0.1, [::1]) is allowed
 * on ANY port: a local run can be opened through several loopback
 * spellings, and which one the browser uses depends on its resolver, so
 * pinning local access to one exact origin string made sign-in fail
 * with "could not reach the backend" on otherwise-correct setups.
 * Loopback origins can only come from the same machine, so this does
 * not widen access for anyone off the box. Every other non-configured
 * origin is rejected.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function isLoopbackOrigin(origin: string): boolean {
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
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTS.has(host);
}

export function isOriginAllowed(origin: string, configuredOrigin: string): boolean {
  if (origin === configuredOrigin) {
    return true;
  }
  return isLoopbackOrigin(origin);
}

// The value/callback shapes @fastify/cors expects from an origin
// function (mirrors its own OriginType / OriginCallback types so this
// module needs no type import from the plugin).
type OriginValue = string | boolean | RegExp;
type OriginValueOrArray = OriginValue | OriginValueArray;
interface OriginValueArray extends Array<OriginValueOrArray> {}
type OriginCallback = (error: Error | null, allow: OriginValueOrArray) => void;

/**
 * The `origin` option for @fastify/cors: a function that decides per
 * request. Requests with no Origin header (curl, health checks,
 * server-to-server) are not CORS requests and are let through.
 */
export function buildCorsOrigin(configuredOrigin: string) {
  return (origin: string | undefined, callback: OriginCallback): void => {
    if (!origin) {
      callback(null, true);
      return;
    }
    callback(null, isOriginAllowed(origin, configuredOrigin));
  };
}
