import { readFileSync } from "node:fs";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes } from "./auth.js";
import { BrowserManager, type BrowserLauncher } from "./browserManager.js";
import { isAllowedRequestOrigin, type Config } from "./config.js";
import { buildCorsOrigin } from "./corsOrigin.js";
import { startConnectShim, type ConnectShim } from "./connectShim.js";
import {
  FacebookDriver,
  type MarketplaceDriver,
} from "./facebookDriver.js";
import { registerFacebookRoutes } from "./facebookRoutes.js";
import { registerJobRoutes } from "./jobRoutes.js";
import { JobService, type JobServiceOptions } from "./jobService.js";
import { registerListingsRoutes } from "./listingsRoutes.js";
import type { FileDownloader } from "./recovery.js";
import { ScrapeService } from "./scrapeService.js";
import { Store } from "./store.js";

export interface AppParts {
  app: FastifyInstance;
  store: Store;
  browser: BrowserManager;
  scraper: ScrapeService;
  driver: MarketplaceDriver;
  jobs: JobService;
  shim?: ConnectShim;
}

export interface BuildOptions {
  config: Config;
  store?: Store;
  launcher?: BrowserLauncher;
  /** Injectable media downloader (tests substitute a fake CDN). */
  downloader?: FileDownloader;
  /** Injectable Marketplace driver (tests substitute a fake driver so
   *  no test ever writes to Facebook). Defaults to the real driver over
   *  the app's BrowserManager. */
  driver?: MarketplaceDriver;
  /** Overrides for the job service (tests inject a fake clock and turn
   *  dry-run off); defaults come from the server config. */
  jobOptions?: Partial<JobServiceOptions>;
}

export async function buildApp(options: BuildOptions): Promise<AppParts> {
  const { config } = options;
  const store = options.store ?? new Store(config.dataDir);
  await store.load();

  // When an upstream proxy is configured, Chromium talks to a local shim
  // that speaks to the proxy the way it expects (see connectShim.ts).
  let browserProxy = config.browserProxy;
  let shim: ConnectShim | undefined;
  if (browserProxy) {
    shim = await startConnectShim(browserProxy);
    browserProxy = { server: shim.url };
  }
  const browser = new BrowserManager(store, config.dataDir, options.launcher, {
    proxy: browserProxy,
    ignoreCertErrors: config.browserIgnoreCertErrors,
  });
  const scraper = new ScrapeService(store, browser, config.dataDir, options.downloader);
  const driver = options.driver ?? new FacebookDriver(browser);
  const jobs = new JobService(store, driver, config.dataDir, {
    dryRun: config.dryRun,
    pollIntervalMs: config.jobPollIntervalMs,
    stuckAfterMs: config.jobStuckAfterMs,
    ...options.jobOptions,
    withUserOperation: (userId, operation) => browser.withUserOperation(userId, operation),
  });

  const app = Fastify({
    logger: false,
    ...(config.tls ? {
      https: {
        key: readFileSync(config.tls.keyFile),
        cert: readFileSync(config.tls.certFile),
      },
    } : {}),
  });

  // The API client sends body-less action POSTs (connect, disconnect,
  // sync, recover, job create, logout) that can carry a
  // "Content-Type: application/json" header with no body at all.
  // Fastify's default JSON parser rejects those before any route runs
  // (400 FST_ERR_CTP_EMPTY_JSON_BODY — the UI shows just "Bad
  // Request"). Treat an empty JSON body as {} here, in one place, for
  // every current and future body-less POST. Real bodies still parse
  // (and malformed ones still error) via JSON.parse below.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    const text = body as string;
    if (text.trim() === "") {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (error) {
      // Match the default parser: a malformed body is a 400, not a 500.
      const parseError = error as Error & { statusCode?: number };
      parseError.statusCode = 400;
      done(parseError);
    }
  });

  await app.register(cookie);
  await app.register(cors, { origin: buildCorsOrigin(config.corsOrigin), credentials: true });
  await app.register(websocket);

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    const isBrowserSocket = request.method === "GET" && request.url.split("?", 1)[0] === "/api/facebook/view";
    if (isBrowserSocket && (!origin || !isAllowedRequestOrigin(origin, config.corsOrigin))) {
      await reply.code(403).send({ error: "WebSocket Origin is not allowed" });
      return;
    }
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
    const hasSession = Boolean(request.cookies?.relist_session);
    if (hasSession && !origin) {
      await reply.code(403).send({ error: "State-changing requests require the configured Origin" });
      return;
    }
    if (origin && !isAllowedRequestOrigin(origin, config.corsOrigin)) {
      await reply.code(403).send({ error: "Origin is not allowed" });
    }
  });

  app.get("/api/health", async () => ({ ok: true }));

  registerAuthRoutes(app, store, config);
  registerFacebookRoutes(app, store, browser, config.corsOrigin);
  registerListingsRoutes(app, store, scraper, config.dataDir);
  registerJobRoutes(app, store, jobs, browser);

  return { app, store, browser, scraper, driver, jobs, shim };
}
