// End-to-end proof of the Connect Facebook live-login path against a REAL
// Chromium in this sandbox. The login page target is redirected to a LOCAL
// fixture login form (never facebook.com) served by this script; everything
// else is the production path: Fastify app, session cookie auth, the real
// /api/facebook/view WebSocket, CDP screencast, sequenced input ops, and a
// drop + reconnect + resync cycle.
//
// Run: npx tsx scripts/e2e-live-login.ts   (exit 0 = all checks passed)

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { buildApp, type AppParts } from "../src/app.js";
import type { Config } from "../src/config.js";

const APP_PORT = 8977;
const ORIGIN = `http://127.0.0.1:${APP_PORT}`;

const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Fixture login</title></head>
<body style="margin:0;font-family:sans-serif;background:#fff">
  <h1 style="position:absolute;top:40px;left:20px;font-size:20px">Log in</h1>
  <input id="email" type="email" name="email" autocomplete="username"
    style="position:absolute;top:120px;left:20px;width:350px;height:44px;font-size:16px">
  <input id="pass" type="password" name="pass" autocomplete="current-password"
    style="position:absolute;top:220px;left:20px;width:350px;height:44px;font-size:16px">
</body></html>`;

// Login page is emulated at 390x844 CSS px: field centres in normalized coords.
const EMAIL_TAP = { nx: 195 / 390, ny: 142 / 844 };
const PASS_TAP = { nx: 195 / 390, ny: 242 / 844 };

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function fingerprint(salt: string, value: string): string {
  return createHash("sha256").update(salt + "\n" + value).digest("hex").slice(0, 16);
}

interface View {
  ws: WebSocket;
  frames: number;
  messages: Array<Record<string, unknown>>;
  waitFor: (pred: (m: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
  waitFrames: (n: number, timeoutMs?: number) => Promise<void>;
  send: (m: Record<string, unknown>) => void;
  close: () => void;
}

function openView(cookie: string): Promise<View> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${APP_PORT}/api/facebook/view`, {
      headers: { Cookie: cookie, Origin: ORIGIN },
    });
    const view: View = {
      ws,
      frames: 0,
      messages: [],
      send: (m) => ws.send(JSON.stringify(m)),
      close: () => ws.close(),
      waitFor: (pred, timeoutMs = 15000) =>
        new Promise((res, rej) => {
          const existing = view.messages.find(pred);
          if (existing) return res(existing);
          const started = Date.now();
          const timer = setInterval(() => {
            const found = view.messages.find(pred);
            if (found) {
              clearInterval(timer);
              res(found);
            } else if (Date.now() - started > timeoutMs) {
              clearInterval(timer);
              rej(new Error("waitFor timed out"));
            }
          }, 25);
        }),
      waitFrames: (n, timeoutMs = 15000) =>
        new Promise((res, rej) => {
          const started = Date.now();
          const timer = setInterval(() => {
            if (view.frames >= n) {
              clearInterval(timer);
              res();
            } else if (Date.now() - started > timeoutMs) {
              clearInterval(timer);
              rej(new Error(`waitFrames timed out (got ${view.frames})`));
            }
          }, 25);
        }),
    };
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        view.frames += 1;
        return;
      }
      try {
        view.messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch {
        // Non-JSON text frames are ignored by the client too.
      }
    });
    ws.on("open", () => resolve(view));
    ws.on("error", reject);
  });
}

async function main(): Promise<void> {
  const fixture = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(FIXTURE_HTML);
  });
  await new Promise<void>((res) => fixture.listen(0, "127.0.0.1", res));
  const fixturePort = (fixture.address() as { port: number }).port;
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/login`;
  console.log(`fixture login page: ${fixtureUrl}`);

  const dataDir = await mkdtemp(path.join(os.tmpdir(), "relist-e2e-"));
  const config: Config = {
    port: APP_PORT,
    host: "127.0.0.1",
    dataDir,
    corsOrigin: ORIGIN,
    cookieSecure: false,
    browserIgnoreCertErrors: false,
    dryRun: true,
    jobPollIntervalMs: 15 * 60 * 1000,
    jobStuckAfterMs: 48 * 60 * 60 * 1000,
  };
  let parts: AppParts | null = null;
  try {
    parts = await buildApp({ config });
    await parts.app.listen({ port: APP_PORT, host: "127.0.0.1" });
    console.log("backend listening (real Chromium launcher)");

    // Register a user and capture the session cookie.
    const register = await fetch(`${ORIGIN}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ name: "E2E", email: "e2e@example.com", password: "e2e-password-1" }),
    });
    check("register", register.status === 201, `status ${register.status}`);
    const setCookie = register.headers.getSetCookie?.() ?? [];
    const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    const me = await (await fetch(`${ORIGIN}/api/auth/me`, { headers: { Cookie: cookie } })).json() as {
      user: { id: string };
    };
    const userId = me.user.id;
    console.log(`user id: ${userId}`);

    // Connect: starts the LoginSession and opens the dedicated login page.
    const connect = await fetch(`${ORIGIN}/api/facebook/connect`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: ORIGIN },
    });
    check("connect starts login session", connect.status === 200, `status ${connect.status}`);

    const loginPage = parts.browser.getLoginPage(userId);
    check("login page target exists", Boolean(loginPage));
    if (!loginPage) throw new Error("no login page");
    await loginPage.goto(fixtureUrl);
    console.log("login page redirected to fixture");

    // Attach the view socket: welcome + screencast frames must flow.
    const view = await openView(cookie);
    const welcome = await view.waitFor((m) => m.kind === "welcome");
    check("welcome received", typeof welcome.sessionId === "string" && typeof welcome.salt === "string");
    const salt = String(welcome.salt);
    view.send({ kind: "resync", lastAck: 0, fingerprint: null });
    const resync0 = await view.waitFor((m) => m.kind === "resync_result");
    check("initial resync intact", resync0.verdict === "intact", `verdict ${String(resync0.verdict)}`);
    await view.waitFrames(1);
    check("screencast frames flow", view.frames >= 1, `${view.frames} frame(s)`);

    // Tap the email field -> focus kind email; type the address.
    view.send({ kind: "tap", ...EMAIL_TAP });
    const focus1 = await view.waitFor((m) => m.kind === "focus" && m.fieldKind === "email");
    check("tap focuses email field", focus1.fieldKind === "email");
    view.send({ kind: "op", seq: 1, op: { type: "insert", text: "qa@example.com" } });
    await view.waitFor((m) => m.kind === "ack" && m.seq === 1);
    const emailValue = await loginPage.evaluate("document.getElementById('email').value");
    check("insert lands in email field", emailValue === "qa@example.com", `value=${String(emailValue)}`);

    // Password: type, backspace once, bulk-insert (paste path).
    view.send({ kind: "tap", ...PASS_TAP });
    await view.waitFor((m) => m.kind === "focus" && m.fieldKind === "password");
    check("tap focuses password field", true);
    view.send({ kind: "op", seq: 2, op: { type: "insert", text: "S3cret!" } });
    await view.waitFor((m) => m.kind === "ack" && m.seq === 2);
    view.send({ kind: "op", seq: 3, op: { type: "deleteBackward", count: 1 } });
    await view.waitFor((m) => m.kind === "ack" && m.seq === 3);
    view.send({ kind: "op", seq: 4, op: { type: "insert", text: "XYZ" } });
    await view.waitFor((m) => m.kind === "ack" && m.seq === 4);
    const passValue = await loginPage.evaluate("document.getElementById('pass').value");
    check("type + delete + paste lands correctly", passValue === "S3cretXYZ", `value=${String(passValue)}`);

    // Drop the socket; reconnect; session must persist and resync intact.
    view.close();
    await new Promise((res) => setTimeout(res, 300));
    const view2 = await openView(cookie);
    const welcome2 = await view2.waitFor((m) => m.kind === "welcome");
    check("session survives socket drop", welcome2.sessionId === welcome.sessionId,
      `session ${String(welcome2.sessionId)}`);
    view2.send({ kind: "resync", lastAck: 4, fingerprint: fingerprint(salt, "S3cretXYZ") });
    const resync2 = await view2.waitFor((m) => m.kind === "resync_result");
    check("resync after drop is intact", resync2.verdict === "intact" && resync2.appliedSeq === 4,
      `verdict=${String(resync2.verdict)} appliedSeq=${String(resync2.appliedSeq)}`);

    // Diverge the password field behind the client's back -> resync must
    // verdict "reset" and clear the page field (never leak, never replay).
    await loginPage.evaluate("document.getElementById('pass').value = 'tampered-value'");
    view2.close();
    await new Promise((res) => setTimeout(res, 300));
    const view3 = await openView(cookie);
    await view3.waitFor((m) => m.kind === "welcome");
    view3.send({ kind: "resync", lastAck: 4, fingerprint: fingerprint(salt, "S3cretXYZ") });
    const resync3 = await view3.waitFor((m) => m.kind === "resync_result");
    check("diverged password resync is reset", resync3.verdict === "reset", `verdict=${String(resync3.verdict)}`);
    check("reset leaks no page value", !("pageValue" in resync3));
    const cleared = await loginPage.evaluate("document.getElementById('pass').value");
    check("page password field cleared on reset", cleared === "", `value=${String(cleared)}`);
    view3.close();
  } finally {
    if (parts) {
      await parts.browser.closeAll().catch(() => undefined);
      await parts.app.close().catch(() => undefined);
    }
    fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "E2E RESULT: ALL CHECKS PASSED" : `E2E RESULT: ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
