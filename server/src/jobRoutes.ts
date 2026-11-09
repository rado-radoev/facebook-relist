// Recreate jobs + history for the signed-in person only (Sprint 3).
//
// Same isolation rule as every other route: the account comes from the
// app session cookie, jobs are read and created only under the caller's
// own id, and another user's job id is a 404 — never a peek.

import type { FastifyInstance } from "fastify";
import { makeRequireAuth } from "./auth.js";
import type { BrowserManager } from "./browserManager.js";
import {
  ActiveJobExistsError,
  CloneNotFoundError,
  JobIncompleteError,
  type JobService,
} from "./jobService.js";
import { toPublicJob } from "./jobTypes.js";
import { ListingNotSyncedError } from "./scrapeService.js";
import type { Store } from "./store.js";

export function registerJobRoutes(
  app: FastifyInstance,
  store: Store,
  jobs: JobService,
  browser: BrowserManager,
): void {
  const requireAuth = makeRequireAuth(store);

  app.post(
    "/api/listings/:id/jobs",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        await reply.code(401).send({ error: "Not signed in" });
        return;
      }
      const { id } = request.params as { id: string };
      if (browser.statusOf(user.id) !== "connected") {
        await reply.code(409).send({ error: "Connect Facebook before recreating a listing" });
        return;
      }
      try {
        const job = await jobs.createJob(user.id, id);
        // Kick the runner in the background; the client polls the job.
        void jobs.processJob(user.id, job.id);
        await reply.code(201).send({ job: toPublicJob(job) });
      } catch (error) {
        if (error instanceof ListingNotSyncedError) {
          await reply.code(404).send({ error: "That listing is not in your synced listings" });
          return;
        }
        if (error instanceof CloneNotFoundError) {
          await reply
            .code(404)
            .send({ error: "Run a clone check for this listing before recreating it" });
          return;
        }
        if (error instanceof JobIncompleteError) {
          await reply.code(400).send({ error: error.message, missing: error.missing });
          return;
        }
        if (error instanceof ActiveJobExistsError) {
          await reply.code(409).send({ error: error.message, jobId: error.jobId });
          return;
        }
        throw error;
      }
    },
  );

  app.get("/api/jobs", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      await reply.code(401).send({ error: "Not signed in" });
      return;
    }
    const list = jobs
      .listJobs(user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toPublicJob);
    await reply.send({ jobs: list });
  });

  app.get("/api/jobs/:jobId", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      await reply.code(401).send({ error: "Not signed in" });
      return;
    }
    const { jobId } = request.params as { jobId: string };
    const job = jobs.getJob(user.id, jobId);
    if (!job) {
      await reply.code(404).send({ error: "Job not found" });
      return;
    }
    await reply.send({ job: toPublicJob(job) });
  });

  app.get("/api/history", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      await reply.code(401).send({ error: "Not signed in" });
      return;
    }
    const history = jobs
      .listHistory(user.id)
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    await reply.send({ history });
  });
}
