// Facebook connection for the signed-in person only.
//
// Connect opens the person's own persistent browser with a dedicated
// login page on Facebook's login page. The /view WebSocket attaches to
// that user's LoginSession (CDP screencast frames down, CDP input ops
// up — see loginSession.ts); the credentials are typed into
// facebook.com itself. No endpoint here accepts a Facebook password,
// and every route acts on the session's own account: there is
// deliberately no account id parameter anywhere.

import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { makeRequireAuth, userFromRequest } from "./auth.js";
import type { BrowserManager } from "./browserManager.js";
import { isAllowedRequestOrigin } from "./config.js";
import { LoginSessionRegistry } from "./loginSession.js";
import { hashToken, type Store } from "./store.js";

export function registerFacebookRoutes(
  app: FastifyInstance,
  store: Store,
  browser: BrowserManager,
  configuredOrigin: string,
  loginSessions: LoginSessionRegistry = new LoginSessionRegistry(browser),
): void {
  const requireAuth = makeRequireAuth(store);

  app.get("/api/facebook/status", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      await reply.code(401).send({ error: "Not signed in" });
      return;
    }
    // reportedStatus, not the cheap refreshStatus: clients must never
    // be told "connected" on a single cookie signal (§6), and the
    // answer must never be cached by the PWA's service worker (§6.8).
    const status = await browser.withUserOperation(user.id, () => browser.reportedStatus(user.id));
    await reply.header("Cache-Control", "no-store").send({ status });
  });

  app.post("/api/facebook/connect", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      await reply.code(401).send({ error: "Not signed in" });
      return;
    }
    await loginSessions.start(user.id);
    await reply.send({ status: browser.statusOf(user.id) });
  });

  app.post("/api/facebook/disconnect", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      await reply.code(401).send({ error: "Not signed in" });
      return;
    }
    await loginSessions.end(user.id);
    await browser.disconnect(user.id);
    await reply.send({ status: "not_connected" });
  });

  // Diagnostics that could expose login fields or sensitive page details
  // are intentionally not registered.

  app.get("/api/facebook/view", { websocket: true }, (socket: WebSocket, request) => {
    const origin = request.headers.origin;
    const user = userFromRequest(store, request);
    const rawToken = request.cookies.relist_session;
    if (!origin || !isAllowedRequestOrigin(origin, configuredOrigin) || !user || !rawToken) {
      socket.close(4401, "Not authorized");
      return;
    }
    const userId = user.id;
    const socketOrigin = origin;
    // Re-checked before every inbound message is acted on: the session
    // cookie must still resolve and the socket's Origin must be the one
    // it connected with. (Socket revocation on logout also fires via
    // BrowserManager.trackSocket, registered inside attach.)
    const isAuthorized = () =>
      request.headers.origin === socketOrigin &&
      isAllowedRequestOrigin(socketOrigin, configuredOrigin) &&
      Boolean(store.findUserBySessionToken(rawToken));
    void loginSessions
      .attach(userId, socket, { tokenHash: hashToken(rawToken), isAuthorized })
      .catch(() => {
        if (socket.readyState === 1) {
          socket.close(1011, "Browser session unavailable");
        }
      });
  });
}
