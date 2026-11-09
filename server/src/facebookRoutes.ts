// Facebook connection for the signed-in person only.
//
// Connect launches the person's own persistent browser on Facebook's login
// page. The /view WebSocket streams screenshots of that browser to their
// phone and forwards their taps/keystrokes back into Facebook's page — the
// credentials are typed into facebook.com itself. No endpoint here accepts
// a Facebook password, and every route acts on the session's own account:
// there is deliberately no account id parameter anywhere.

import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { makeRequireAuth, userFromRequest } from "./auth.js";
import type { BrowserInput, BrowserManager } from "./browserManager.js";
import { isAllowedRequestOrigin } from "./config.js";
import { hashToken, type Store } from "./store.js";

const ALLOWED_KEYS = new Set([
  "Enter",
  "Backspace",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Delete",
]);

const FRAME_INTERVAL_MS = 700;

function parseBrowserInput(raw: string): BrowserInput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.type === "click") {
    if (typeof record.nx !== "number" || typeof record.ny !== "number") {
      return null;
    }
    if (!Number.isFinite(record.nx) || !Number.isFinite(record.ny)) {
      return null;
    }
    return { type: "click", nx: record.nx, ny: record.ny };
  }
  if (record.type === "type") {
    if (typeof record.text !== "string" || record.text.length > 500) {
      return null;
    }
    return { type: "type", text: record.text };
  }
  if (record.type === "key") {
    if (typeof record.key !== "string" || !ALLOWED_KEYS.has(record.key)) {
      return null;
    }
    return { type: "key", key: record.key };
  }
  if (record.type === "scroll") {
    if (typeof record.dy !== "number" || !Number.isFinite(record.dy)) {
      return null;
    }
    return { type: "scroll", dy: Math.max(-2000, Math.min(2000, record.dy)) };
  }
  return null;
}

export function registerFacebookRoutes(
  app: FastifyInstance,
  store: Store,
  browser: BrowserManager,
  configuredOrigin: string,
): void {
  const requireAuth = makeRequireAuth(store);

  app.get("/api/facebook/status", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      await reply.code(401).send({ error: "Not signed in" });
      return;
    }
    const status = await browser.withUserOperation(user.id, () => browser.refreshStatus(user.id));
    await reply.send({ status });
  });

  app.post("/api/facebook/connect", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      await reply.code(401).send({ error: "Not signed in" });
      return;
    }
    const status = await browser.startLogin(user.id);
    await reply.send({ status });
  });

  app.post("/api/facebook/disconnect", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      await reply.code(401).send({ error: "Not signed in" });
      return;
    }
    await browser.disconnect(user.id);
    await reply.send({ status: "not_connected" });
  });

  // Diagnostics that could expose login fields or sensitive page details
  // are intentionally not registered.

  app.get("/api/facebook/view", { websocket: true }, (socket: WebSocket, request) => {
    const origin = request.headers.origin;
    const token = userFromRequest(store, request);
    const rawToken = request.cookies.relist_session;
    if (!origin || !isAllowedRequestOrigin(origin, configuredOrigin) || !token || !rawToken) {
      socket.close(4401, "Not authorized");
      return;
    }
    const userId = token.id;
    const socketOrigin = origin;
    const unregisterSocket = browser.trackSocket(userId, hashToken(rawToken), socket);
    let lastFrameHash = "";
    let tickRunning = false;
    let closed = false;
    let queuedInputs = 0;
    const MAX_QUEUED_INPUTS = 32;
    const isOpen = () => !closed && socket.readyState === 1 &&
      request.headers.origin === socketOrigin && isAllowedRequestOrigin(socketOrigin, configuredOrigin) &&
      Boolean(store.findUserBySessionToken(rawToken));
    const send = (data: Buffer | string) => {
      if (isOpen()) socket.send(data);
    };
    const timer = setInterval(() => {
      if (tickRunning || !isOpen()) {
        if (!isOpen()) socket.close(4401, "Session expired or revoked");
        return;
      }
      tickRunning = true;
      void (async () => {
        await browser.withUserOperation(userId, async () => {
          if (!isOpen()) return;
          const frame = await browser.screenshot(userId);
          if (frame && isOpen()) {
            const hash = createHash("sha256").update(frame).digest("hex");
            if (hash !== lastFrameHash) {
              lastFrameHash = hash;
              send(frame);
            }
          }
          if (!isOpen()) return;
          const status = await browser.refreshStatus(userId);
          send(JSON.stringify({ kind: "status", status }));
        });
      })().catch(() => {
        if (!closed && socket.readyState === 1) socket.close(1011, "Browser session unavailable");
      }).finally(() => {
        tickRunning = false;
      });
    }, FRAME_INTERVAL_MS);
    timer.unref();

    socket.on("message", (data: Buffer) => {
      if (!isOpen()) {
        socket.close(4401, "Session expired or revoked");
        return;
      }
      if (queuedInputs >= MAX_QUEUED_INPUTS) {
        socket.close(4429, "Input queue is full");
        return;
      }
      const input = parseBrowserInput(data.toString());
      if (!input) return;
      queuedInputs += 1;
      void browser.withUserOperation(userId, async () => {
        if (isOpen()) await browser.sendInput(userId, input);
        else socket.close(4401, "Session expired or revoked");
      }).catch(() => {
        if (!closed && socket.readyState === 1) socket.close(1011, "Browser input failed");
      }).finally(() => {
        queuedInputs -= 1;
      });
    });

    socket.on("close", () => {
      closed = true;
      clearInterval(timer);
      unregisterSocket();
    });
  });
}
