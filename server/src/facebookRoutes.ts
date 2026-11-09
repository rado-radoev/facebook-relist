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
import type { Store } from "./store.js";

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
): void {
  const requireAuth = makeRequireAuth(store);

  app.get("/api/facebook/status", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      await reply.code(401).send({ error: "Not signed in" });
      return;
    }
    const status = await browser.refreshStatus(user.id);
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

  // Diagnostics for the person's OWN browser session (used by the live
  // end-to-end check): current URL/title and the value currently in
  // Facebook's email field. Removed once the connect flow is proven.
  app.get("/api/facebook/debug", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      await reply.code(401).send({ error: "Not signed in" });
      return;
    }
    const info = await browser.debugInfo(user.id);
    if (!info) {
      await reply.code(409).send({ error: "No active browser session" });
      return;
    }
    await reply.send(info);
  });

  app.get("/api/facebook/view", { websocket: true }, (socket: WebSocket, request) => {
    const user = userFromRequest(store, request);
    if (!user) {
      socket.close(4401, "Not signed in");
      return;
    }
    const userId = user.id;
    let lastFrameHash = "";
    let tick = 0;
    let closed = false;

    const timer = setInterval(() => {
      void (async () => {
        if (closed) {
          return;
        }
        const frame = await browser.screenshot(userId);
        if (frame && !closed) {
          const hash = createHash("md5").update(frame).digest("hex");
          if (hash !== lastFrameHash) {
            lastFrameHash = hash;
            socket.send(frame);
          }
        }
        tick += 1;
        if (tick % 3 === 0 && !closed) {
          const status = await browser.refreshStatus(userId);
          socket.send(JSON.stringify({ kind: "status", status }));
        }
      })();
    }, FRAME_INTERVAL_MS);
    timer.unref();

    socket.on("message", (data: Buffer) => {
      void (async () => {
        const input = parseBrowserInput(data.toString());
        if (input) {
          await browser.sendInput(userId, input);
        }
      })();
    });

    socket.on("close", () => {
      closed = true;
      clearInterval(timer);
    });
  });
}
