import Fastify from "fastify";

import { config } from "./config.js";
import { logger } from "./logger.js";
import { pool, pingDb } from "./db.js";
import { registry } from "./metrics.js";
import { attachWebSocketServer, CLOSE_GOING_AWAY } from "./ws.js";
import { allDocs, flush, publisher, subscriber } from "./docs.js";

const app = Fastify({ loggerInstance: logger, disableRequestLogging: true });

let ready = false;

app.get("/healthz", async () => ({ status: "ok" }));

app.get("/readyz", async (_req, reply) => {
  if (!ready) return reply.code(503).send({ status: "shutting_down" });
  try {
    await pingDb();
    if (publisher.status !== "ready") {
      // Redis being down does not stop this replica serving the documents it
      // already holds — but it does stop replicas seeing each other's edits,
      // which is a split brain. Better to leave the rotation than to serve
      // silently divergent copies.
      return reply.code(503).send({ status: "redis_unreachable" });
    }
    return { status: "ready" };
  } catch {
    return reply.code(503).send({ status: "database_unreachable" });
  }
});

app.get("/metrics", async (_req, reply) => {
  reply.header("content-type", registry.contentType);
  return registry.metrics();
});

await app.listen({ port: config.PORT, host: config.HOST });
const wss = attachWebSocketServer(app.server);
ready = true;
logger.info({ port: config.PORT }, "collab listening");

// Shutting down a stateful WebSocket tier is not the same problem as shutting
// down a request/response service, and this is the part stage 04's gate turns
// on.
//
// An HTTP service can finish its in-flight requests and exit. A socket has no
// natural end: if we simply stop, every open editor sees a hard disconnect and
// whatever was in memory but not yet persisted is gone.
//
// So the order is: stop accepting new sockets, persist every dirty document,
// then close each socket with a code the client understands as "come back",
// and only then let the process exit. The client reconnects with backoff and
// lands on a replica that is still up.
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, sockets: wss.clients.size }, "shutdown started");

  ready = false; // readiness fails, endpoints are withdrawn, no new connections

  const forced = setTimeout(() => {
    logger.error("graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS);
  forced.unref();

  try {
    // Let the endpoint removal propagate before we start closing sockets, or
    // clients reconnect to the replica that is going away.
    await new Promise((r) => setTimeout(r, 3_000));

    // Persist before disconnecting. Doing it the other way round races the
    // clients' reconnection against our own write.
    const docs = allDocs();
    await Promise.all(docs.map((d) => flush(d)));
    logger.info({ documents: docs.length }, "documents flushed");

    for (const client of wss.clients) {
      client.close(CLOSE_GOING_AWAY, "server shutting down");
    }

    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await app.close();
    await Promise.all([publisher.quit(), subscriber.quit()]);
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
