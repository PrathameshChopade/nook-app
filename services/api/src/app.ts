import { randomUUID } from "node:crypto";
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyJwt from "@fastify/jwt";
import fastifySwagger from "@fastify/swagger";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { config } from "./config.js";
import { logger } from "./logger.js";
import { pingDb } from "./db.js";
import { registry, httpDuration, httpErrors } from "./metrics.js";
import { ErrorReply } from "./schemas.js";
import { authRoutes } from "./routes/auth.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { pageRoutes } from "./routes/pages.js";
import { blockRoutes } from "./routes/blocks.js";

declare module "fastify" {
  interface FastifyRequest {
    startTime?: bigint;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; email: string };
    user: { sub: string; email: string };
  }
}

// Readiness is a mutable fact, not a computed one. Once SIGTERM arrives we
// report not-ready immediately so the load balancer stops sending new work,
// while in-flight requests keep being served. That gap is the entire reason
// readiness and liveness are separate probes.
let ready = false;
export const setReady = (v: boolean) => {
  ready = v;
};

export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    // Trust the proxy so req.ip is the client, not the ALB. Wrong here means
    // per-IP rate limits in stage 09 would throttle the load balancer itself.
    trustProxy: true,
    genReqId: (req) => (req.headers["x-request-id"] as string) ?? randomUUID(),
    disableRequestLogging: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: "12h" },
  });

  // Bearer tokens, never cookies. A cookie-authenticated API is quietly a
  // web-only API: it drags in CSRF defences, SameSite behaviour and a browser
  // assumption that a mobile client cannot satisfy. This one line is most of
  // what keeps Flutter open later — see ADR-0002.
  app.decorate("authenticate", async (req: any, reply: any) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({
        error: "unauthorized",
        message: "A valid bearer token is required",
        requestId: req.id,
      });
    }
  });

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Nook API",
        description:
          "Collaborative workspace API. The document is generated from the same Zod " +
          "schemas the server validates with, so it cannot drift from the implementation.",
        version: "0.1.0",
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });

  app.addHook("onRequest", async (req) => {
    req.startTime = process.hrtime.bigint();
  });

  app.addHook("onResponse", async (req, reply) => {
    // routeOptions.url is the template ("/pages/:id"), not the concrete path.
    // Labelling with the concrete path would create unbounded cardinality and
    // eventually take Prometheus down — a classic self-inflicted outage.
    const route = req.routeOptions?.url ?? "unmatched";
    const seconds = req.startTime
      ? Number(process.hrtime.bigint() - req.startTime) / 1e9
      : reply.elapsedTime / 1000;

    const labels = { method: req.method, route, status_code: String(reply.statusCode) };
    httpDuration.observe(labels, seconds);
    if (reply.statusCode >= 500) httpErrors.inc({ method: req.method, route });

    req.log.info(
      {
        req: { method: req.method, url: req.url, route, ip: req.ip },
        res: { statusCode: reply.statusCode },
        responseTime: seconds,
        requestId: req.id,
      },
      "request completed",
    );
  });

  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err, requestId: req.id }, "unhandled error");
    else req.log.warn({ err: err.message, requestId: req.id }, "request rejected");

    reply.code(status).send({
      error: status >= 500 ? "internal_error" : (err.code ?? "bad_request"),
      // Never leak an internal message to a client on a 5xx; the detail is in
      // the log, correlated by requestId.
      message: status >= 500 ? "Internal server error" : err.message,
      requestId: String(req.id),
    });
  });

  // Liveness: is the process itself wedged? Deliberately does not touch the
  // database — if Postgres is down, restarting this pod does not help, and a
  // liveness probe that fails on a dependency outage turns a database blip
  // into a cluster-wide restart storm.
  app.get("/healthz", { schema: { hide: true } }, async () => ({ status: "ok" }));

  // Readiness: should this pod receive traffic right now? This one *does*
  // check the database, because a pod that cannot reach Postgres has nothing
  // useful to offer.
  app.get("/readyz", { schema: { hide: true } }, async (_req, reply) => {
    if (!ready) return reply.code(503).send({ status: "shutting_down" });
    try {
      await pingDb();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "database_unreachable" });
    }
  });

  app.get("/metrics", { schema: { hide: true } }, async (_req, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({
      error: "not_found",
      message: `No route for ${req.method} ${req.url}`,
      requestId: String(req.id),
    }),
  );

  await app.register(authRoutes, { prefix: "/v1" });
  await app.register(workspaceRoutes, { prefix: "/v1" });
  await app.register(pageRoutes, { prefix: "/v1" });
  await app.register(blockRoutes, { prefix: "/v1" });

  void ErrorReply; // referenced by route schemas

  return app;
}
