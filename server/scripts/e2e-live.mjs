// Live end-to-end check for Sprint 1, run against a REAL running server
// (real Playwright Chromium, real facebook.com). It registers throwaway
// Relist app users only — it never logs into Facebook with real
// credentials; it stops at Facebook's login form.
//
// Usage:
//   1. Start the server on a scratch data dir:
//        PORT=8899 DATA_DIR=./data-e2e npm run start
//   2. In server/:  node scripts/e2e-live.mjs
// Screenshots land in scripts/e2e-frame-*.jpg for visual proof.
// Click coordinates for Facebook's email field can be tuned with
// E2E_CLICK_NX / E2E_CLICK_NY (defaults fit the desktop login page at
// the server's 1280x800 viewport).

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const BASE = process.env.RELIST_API ?? "http://127.0.0.1:8899";
const CLICK_NX = Number(process.env.E2E_CLICK_NX ?? 0.75);
const CLICK_NY = Number(process.env.E2E_CLICK_NY ?? 0.28);
const DUMMY_EMAIL = "relist-e2e-dummy@example.invalid";
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(label, condition, detail = "") {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) {
    failures += 1;
  }
  console.log(`[${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function api(pathName, { method = "GET", body, cookie } = {}) {
  const headers = {};
  if (body) {
    headers["Content-Type"] = "application/json";
  }
  if (cookie) {
    headers.cookie = cookie;
  }
  const response = await fetch(`${BASE}${pathName}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookies = response.headers.getSetCookie();
  const sessionCookie = setCookies
    .map((value) => value.split(";")[0])
    .find((value) => value.startsWith("relist_session="));
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json, sessionCookie };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const health = await api("/api/health");
  check("health endpoint", health.status === 200 && health.json.ok === true);

  // (d) Unauthenticated requests are rejected.
  const meAnon = await api("/api/auth/me");
  check("(d) unauthenticated /api/auth/me rejected", meAnon.status === 401, `got ${meAnon.status}`);
  const statusAnon = await api("/api/facebook/status");
  check("(d) unauthenticated /api/facebook/status rejected", statusAnon.status === 401, `got ${statusAnon.status}`);
  const connectAnon = await api("/api/facebook/connect", { method: "POST", body: {} });
  check("(d) unauthenticated /api/facebook/connect rejected", connectAnon.status === 401, `got ${connectAnon.status}`);

  // Register user 1.
  const stamp = Date.now();
  const reg1 = await api("/api/auth/register", {
    method: "POST",
    body: { name: "E2E One", email: `e2e-one-${stamp}@example.com`, password: "password-123" },
  });
  check("register user 1", reg1.status === 201 && Boolean(reg1.sessionCookie), `status ${reg1.status}`);
  const cookie1 = reg1.sessionCookie;

  const me1 = await api("/api/auth/me", { cookie: cookie1 });
  check("me returns user 1", me1.status === 200 && me1.json.user.name === "E2E One");

  const statusBefore = await api("/api/facebook/status", { cookie: cookie1 });
  check("status starts not_connected", statusBefore.json.status === "not_connected", statusBefore.json.status);

  // Start Facebook connect — real browser launches on facebook.com/login.
  const connect = await api("/api/facebook/connect", { method: "POST", body: {}, cookie: cookie1 });
  check(
    "(c) status transitions not_connected -> login_in_progress",
    connect.json.status === "login_in_progress",
    `connect returned ${connect.json.status}`,
  );
  const statusDuring = await api("/api/facebook/status", { cookie: cookie1 });
  check("(c) status endpoint shows login_in_progress", statusDuring.json.status === "login_in_progress");

  // (a) Remote view delivers real screenshots.
  const wsUrl = `${BASE.replace(/^http/, "ws")}/api/facebook/view`;
  const socket = new WebSocket(wsUrl, { headers: { cookie: cookie1 } });
  const frames = [];
  const statuses = [];
  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      frames.push(Buffer.from(data));
      return;
    }
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.kind === "status") {
        statuses.push(parsed.status);
      }
    } catch {
      // Non-JSON text frame; ignore.
    }
  });
  await new Promise((resolve, reject) => {
    socket.on("open", resolve);
    socket.on("error", reject);
    setTimeout(() => reject(new Error("WS open timeout")), 15000);
  });
  check("remote view WebSocket opens with session cookie", true);

  const deadline = Date.now() + 45000;
  while (frames.length === 0 && Date.now() < deadline) {
    await sleep(500);
  }
  check("(a) screenshot frame received", frames.length > 0, `${frames.length} frame(s)`);
  if (frames.length > 0) {
    const framePath = path.join(scriptsDir, "e2e-frame-1.jpg");
    await writeFile(framePath, frames[frames.length - 1]);
    const sizeKb = Math.round(frames[frames.length - 1].length / 1024);
    check("(a) frame is a non-trivial JPEG", frames[frames.length - 1].length > 5000, `${sizeKb} KB saved to ${framePath}`);
    const header = frames[frames.length - 1].subarray(0, 2).toString("hex");
    check("(a) frame has JPEG magic bytes", header === "ffd8", header);
  }

  const debug1 = await api("/api/facebook/debug", { cookie: cookie1 });
  check(
    "(a) browser is on facebook.com",
    debug1.status === 200 && String(debug1.json.url).includes("facebook.com"),
    `url=${debug1.json.url} title=${JSON.stringify(debug1.json.title)}`,
  );

  // (b) Input forwarding: click the email field, type a dummy string.
  socket.send(JSON.stringify({ type: "click", nx: CLICK_NX, ny: CLICK_NY }));
  await sleep(600);
  socket.send(JSON.stringify({ type: "type", text: DUMMY_EMAIL }));
  await sleep(1200);
  const debug2 = await api("/api/facebook/debug", { cookie: cookie1 });
  check(
    "(b) typed text landed in Facebook's email field",
    debug2.json.emailValue === DUMMY_EMAIL,
    `email field now ${JSON.stringify(debug2.json.emailValue)}`,
  );
  await sleep(1500);
  if (frames.length > 0) {
    const framePath = path.join(scriptsDir, "e2e-frame-2.jpg");
    await writeFile(framePath, frames[frames.length - 1]);
    console.log(`       frame after typing saved to ${framePath} (${frames.length} frames total)`);
  }
  console.log(`       status frames seen over WS: ${JSON.stringify(statuses)}`);

  socket.close();

  // (e) Isolation: user 2 cannot see user 1's session.
  const reg2 = await api("/api/auth/register", {
    method: "POST",
    body: { name: "E2E Two", email: `e2e-two-${stamp}@example.com`, password: "password-123" },
  });
  const cookie2 = reg2.sessionCookie;
  const statusUser2 = await api("/api/facebook/status", { cookie: cookie2 });
  check(
    "(e) second user sees own status (not_connected), not user 1's login_in_progress",
    statusUser2.json.status === "not_connected",
    `user2 status=${statusUser2.json.status}`,
  );
  const debugUser2 = await api("/api/facebook/debug", { cookie: cookie2 });
  check("(e) second user has no browser session to inspect", debugUser2.status === 409, `got ${debugUser2.status}`);
  const statusUser1Again = await api("/api/facebook/status", { cookie: cookie1 });
  check("(e) user 1 session untouched by user 2", statusUser1Again.json.status === "login_in_progress");

  // Disconnect user 1 ends that session only.
  const disconnect = await api("/api/facebook/disconnect", { method: "POST", body: {}, cookie: cookie1 });
  check("disconnect returns not_connected", disconnect.json.status === "not_connected");
  const statusAfter = await api("/api/facebook/status", { cookie: cookie1 });
  check("status after disconnect is not_connected", statusAfter.json.status === "not_connected");

  console.log(failures === 0 ? "\nE2E RESULT: ALL CHECKS PASSED" : `\nE2E RESULT: ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("E2E crashed:", error);
  process.exit(1);
});
