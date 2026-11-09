import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes } from "./auth.js";
import { BrowserManager, type BrowserLauncher } from "./browserManager.js";
import type { Config } from "./config.js";
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
  });

  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(cors, { origin: config.corsOrigin, credentials: true });
  await app.register(websocket);

  app.get("/api/health", async () => ({ ok: true }));

  registerAuthRoutes(app, store, config);
  registerFacebookRoutes(app, store, browser);
  registerListingsRoutes(app, store, scraper, config.dataDir);
  registerJobRoutes(app, store, jobs, browser);

  return { app, store, browser, scraper, driver, jobs, shim };
}
