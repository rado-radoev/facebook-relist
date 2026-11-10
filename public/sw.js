// Relist service worker — deliberately minimal and honest.
//
// Why this exists: a stale cached API response once left the app showing
// "Connect Facebook" after the owner had already logged in. The rule that
// prevents that class of bug is absolute:
//
//   * Any request whose URL pathname starts with "/api/" is NETWORK-ONLY.
//     It is always fetched from the network via respondWith(fetch(...))
//     and is NEVER read from or written to any cache. There is no
//     cache-first, stale-while-revalidate, or fallback route for /api/.
//
//   * Non-API requests are also network-only in practice: they go
//     straight to the network and nothing is stored in a cache. There is
//     deliberately no cache-first app shell — a stale shell is the same
//     failure mode as a stale status, just one layer down.
//
// This worker caches nothing at all. If offline support is ever wanted,
// it must be added for static assets only, and /api/ must stay
// network-only.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const { pathname } = new URL(event.request.url);

  if (pathname.startsWith("/api/")) {
    // NETWORK-ONLY for API requests: live server truth, never a cache.
    event.respondWith(fetch(event.request));
    return;
  }

  // Everything else: network-first by simply going to the network.
  // No cache is opened, read, or written on this path either.
  event.respondWith(fetch(event.request));
});
