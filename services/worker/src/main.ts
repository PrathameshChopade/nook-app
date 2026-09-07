import Fastify from "fastify";
import { UnrecoverableError, Worker, type Job } from "bullmq";

import { config } from "./config.js";
import { logger } from "./logger.js";
import { pool, pingDb } from "./db.js";
import { registry, jobsProcessed, jobDuration, queueDepth } from "./metrics.js";
import { connection, exportQueue, EXPORT_QUEUE, type ExportJob } from "./queues.js";
import { runExport, markExportFailed } from "./jobs/export.js";
import { sweepPendingAttachments } from "./jobs/retention.js";

const app = Fastify({ loggerInstance: logger, disableRequestLogging: true });
let ready = false;

// A worker has no inbound traffic, so these endpoints exist purely for
// Kubernetes and Prometheus. That is reason enough: without /readyz a rolling
// update would replace a worker before the new one could reach Redis, and
// without /metrics KEDA has nothing to scale on.
app.get("/healthz", async () => ({ status: "ok" }));
app.get("/readyz", async (_req, reply) => {
  if (!ready) return reply.code(503).send({ status: "shutting_down" });
  try {
    await pingDb();
    if (connection.status !== "ready") {
      return reply.code(503).send({ status: "redis_unreachable" });
    }
    return { status: "ready" };
  } catch {
    return reply.code(503).send({ status: "database_unreachable" });
  }
});
app.get("/metrics", async (_req, reply) => {
  // Sampled at scrape time rather than on a timer: a gauge updated on an
  // interval reports a number that is already stale by the time it is read.
  try {
    queueDepth.set({ queue: EXPORT_QUEUE }, await exportQueue.getWaitingCount());
  } catch {
    /* Redis unavailable; the last value stands rather than reporting a false zero */
  }
  reply.header("content-type", registry.contentType);
  return registry.metrics();
});

const exportWorker = new Worker<ExportJob>(
  EXPORT_QUEUE,
  async (job: Job<ExportJob>) => {
    const end = jobDuration.startTimer({ queue: EXPORT_QUEUE });
    try {
      await runExport(job.data);
      jobsProcessed.inc({ queue: EXPORT_QUEUE, outcome: "success" });
    } finally {
      end();
    }
  },
  {
    connection,
    concurrency: config.CONCURRENCY,
    // Without a limiter a backlog of exports would saturate the exporter and
    // the database at once. This is the crude version; the real control is
    // KEDA holding replica count down, in stage 04.
    limiter: { max: 20, duration: 1_000 },
  },
);

exportWorker.on("failed", (job, err) => {
  jobsProcessed.inc({ queue: EXPORT_QUEUE, outcome: "failure" });
  // An unrecoverable failure is final on the first attempt; everything else
  // is final only once the attempts are used up.
  const unrecoverable = err instanceof UnrecoverableError || err.name === "UnrecoverableError";
  const exhausted = Boolean(job) && (unrecoverable || job!.attemptsMade >= (job!.opts.attempts ?? 1));
  logger.warn(
    { jobId: job?.id, attempt: job?.attemptsMade, exhausted, unrecoverable, err: err.message },
    "export job failed",
  );
  if (job && exhausted) void markExportFailed(job.data.exportId, err.message);
});

exportWorker.on("error", (err) => logger.error({ err }, "worker error"));

// Retention runs on a plain interval rather than a repeatable BullMQ job.
// With more than one replica a repeatable job would be the right answer,
// because an interval means every replica sweeps. The DELETE is idempotent so
// concurrent sweeps are harmless — but this is a known simplification, not an
// oversight, and it becomes a CronJob in stage 04.
const retentionTimer = setInterval(
  () => {
    void sweepPendingAttachments().catch((err) =>
      logger.error({ err }, "retention sweep failed"),
    );
  },
  15 * 60 * 1_000,
);

await app.listen({ port: config.PORT, host: config.HOST });
ready = true;
logger.info({ port: config.PORT, concurrency: config.CONCURRENCY }, "worker started");

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutdown started");
  ready = false;

  const forced = setTimeout(() => {
    logger.error("graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS);
  forced.unref();

  try {
    clearInterval(retentionTimer);

    // close() waits for jobs already running to finish rather than abandoning
    // them. An abandoned job is not lost — BullMQ redelivers it after the
    // stall timeout — but it is redelivered slowly, and a job that writes to
    // S3 would then do the work twice.
    await exportWorker.close();
    await exportQueue.close();
    await app.close();
    await connection.quit();
    await pool.end();
    logger.info("shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "error during shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => {
  logger.fatal({ err }, "unhandled rejection");
  process.exit(1);
});
