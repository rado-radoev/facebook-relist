import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes } from "./auth.js";
import { BrowserManager, type BrowserLauncher } from "./browserManager.js";
import type { Config } from "./config.js";
import { startConnectShim, type ConnectShim } from "./connectShim.js";
import { registerFacebookRoutes } from "./facebookRoutes.js";
import { registerListingsRoutes } from "./listingsRoutes.js";
import type { FileDownloader } from "./recovery.js";
import { ScrapeService } from "./scrapeService.js";
import { Store } from "./store.js";

export interface AppParts {
  app: FastifyInstance;
  store: Store;
  browser: BrowserManager;
  scraper: ScrapeService;
  shim?: ConnectShim;
}

export interface BuildOptions {
  config: Config;
  store?: Store;
  launcher?: BrowserLauncher;
  /** Injectable media downloader (tests substitute a fake CDN). */
  downloader?: FileDownloader;
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

  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(cors, { origin: config.corsOrigin, credentials: true });
  await app.register(websocket);

  app.get("/api/health", async () => ({ ok: true }));

  registerAuthRoutes(app, store, config);
  registerFacebookRoutes(app, store, browser);
  registerListingsRoutes(app, store, scraper, config.dataDir);

  return { app, store, browser, scraper, shim };
}
