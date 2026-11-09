import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app, browser, jobs, shim } = await buildApp({ config });

// Sprint 3 job runner: resume any job a previous run left mid-flight,
// then sweep periodically so in-review polls and pending steps advance
// without anyone having the app open. The service itself is timer-free;
// all scheduling lives here.
void jobs.processDueJobs();
const sweep = setInterval(() => {
  void jobs.processDueJobs();
}, 30_000);
sweep.unref();

async function shutdown(): Promise<void> {
  clearInterval(sweep);
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
console.log(
  config.dryRun
    ? "Recreate jobs run in DRY-RUN mode (default): nothing will be posted or deleted on Facebook. Set RELIST_DRY_RUN=0 for real writes."
    : "Recreate jobs run LIVE (RELIST_DRY_RUN=0): creates and deletes on Facebook are real.",
);
