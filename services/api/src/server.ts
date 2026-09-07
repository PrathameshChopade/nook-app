import { buildApp, setReady } from "./app.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { pool } from "./db.js";
import { exportQueue, connection } from "./queue.js";

const app = await buildApp();

await app.listen({ port: config.PORT, host: config.HOST });
setReady(true);
logger.info({ port: config.PORT }, "api listening");

// Graceful shutdown is the same conversation as the readiness probe.
//
// On SIGTERM Kubernetes does two things at once: it sends the signal, and it
// starts removing the pod from Service endpoints. Those races. If we exited
// immediately we would drop requests that were routed to us microseconds
// before the endpoint update propagated.
//
// So: flip readiness off first, so the next probe fails and the endpoint is
// withdrawn; wait a beat for that to propagate; then stop accepting new
// connections and let in-flight requests finish; then close the pool.
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutdown started");

  setReady(false);

  const forced = setTimeout(() => {
    logger.error("graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS);
  forced.unref();

  try {
    // Give the endpoint removal time to reach every kube-proxy before we stop
    // listening. Tuned against real propagation time in stage 04.
    await new Promise((r) => setTimeout(r, 3_000));
    await app.close();
    await exportQueue.close();
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
