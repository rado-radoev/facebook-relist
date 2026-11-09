import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app, browser, shim } = await buildApp({ config });

async function shutdown(): Promise<void> {
  await browser.closeAll();
  if (shim) {
    await shim.close();
  }
  await app.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

await app.listen({ port: config.port, host: config.host });
console.log(`Relist backend listening on http://${config.host}:${config.port}`);
console.log(`Data directory: ${config.dataDir}`);
