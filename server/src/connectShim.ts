// A local CONNECT shim between Chromium and an upstream HTTP proxy.
//
// Why this exists: some egress proxies silently drop CONNECT requests
// that arrive without a User-Agent header or with Proxy-Connection: close
// — and Chromium sends neither header the way those proxies expect, so its
// tunnels never establish (net::ERR_TUNNEL_CONNECTION_FAILED) even though
// curl works fine. When Relist is configured with an upstream proxy (via
// BROWSER_PROXY / HTTPS_PROXY), Chromium instead points at this shim on
// 127.0.0.1; the shim forwards each CONNECT upstream with preemptive Basic
// auth, a User-Agent, and Keep-Alive. With no proxy configured the shim
// never starts and the browser connects directly.

import http from "node:http";
import net from "node:net";
import type { ProxyConfig } from "./config.js";

export interface ConnectShim {
  /** Proxy URL to hand to Chromium, e.g. http://127.0.0.1:54321 */
  url: string;
  close: () => Promise<void>;
}

const SHIM_USER_AGENT = "curl/8.5.0";

export async function startConnectShim(upstream: ProxyConfig): Promise<ConnectShim> {
  const upstreamUrl = new URL(upstream.server);
  const upstreamHost = upstreamUrl.hostname;
  const upstreamPort = Number(upstreamUrl.port || 80);
  const hasCreds = Boolean(upstream.username);
  const authHeader = hasCreds
    ? `Basic ${Buffer.from(
        `${upstream.username ?? ""}:${upstream.password ?? ""}`,
      ).toString("base64")}`
    : null;

  const server = http.createServer((request, response) => {
    // Plain-HTTP proxying: forward the absolute-URI request upstream with
    // the same injected headers.
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === "string" && key.toLowerCase() !== "proxy-authorization") {
        headers[key] = value;
      }
    }
    headers["user-agent"] = SHIM_USER_AGENT;
    if (authHeader) {
      headers["proxy-authorization"] = authHeader;
    }
    const forward = http.request(
      {
        host: upstreamHost,
        port: upstreamPort,
        method: request.method,
        path: request.url,
        headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    forward.on("error", () => {
      response.writeHead(502);
      response.end();
    });
    request.pipe(forward);
  });

  server.on("connect", (request, clientSocket, head) => {
    const target = request.url ?? "";
    const upstreamSocket = net.connect(upstreamPort, upstreamHost, () => {
      const lines = [
        `CONNECT ${target} HTTP/1.1`,
        `Host: ${target}`,
        ...(authHeader ? [`Proxy-Authorization: ${authHeader}`] : []),
        `User-Agent: ${SHIM_USER_AGENT}`,
        "Proxy-Connection: Keep-Alive",
        "",
        "",
      ];
      upstreamSocket.write(lines.join("\r\n"));
    });

    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      upstreamSocket.removeListener("data", onData);
      const statusLine = buffer.subarray(0, buffer.indexOf("\r\n")).toString("latin1");
      const rest = buffer.subarray(headerEnd + 4);
      if (!statusLine.includes(" 200")) {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        upstreamSocket.destroy();
        return;
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length > 0) {
        clientSocket.write(rest);
      }
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    };
    upstreamSocket.on("data", onData);
    upstreamSocket.on("error", () => {
      clientSocket.destroy();
    });
    clientSocket.on("error", () => {
      upstreamSocket.destroy();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
