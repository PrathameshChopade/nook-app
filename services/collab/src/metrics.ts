import { Registry, collectDefaultMetrics, Gauge, Counter, Histogram } from "prom-client";

export const registry = new Registry();
registry.setDefaultLabels({ service: "collab" });
collectDefaultMetrics({ register: registry });

// These four are the WebSocket SLIs stage 07 builds its SLO on.
//
// HTTP p95 cannot see a broken realtime tier: the HTTP surface here is three
// probe endpoints that will happily stay green while every socket in the
// cluster is failing to connect. Measuring the sockets themselves is the
// whole point.

export const activeConnections = new Gauge({
  name: "collab_active_connections",
  help: "Currently open WebSocket connections",
  registers: [registry],
});

export const connectionAttempts = new Counter({
  name: "collab_connection_attempts_total",
  help: "WebSocket connection attempts by outcome",
  labelNames: ["outcome"] as const, // accepted | unauthorized | forbidden | bad_request | error
  registers: [registry],
});

// Time from receiving an update to having broadcast it to every local peer
// and published it to Redis. This is the number a user experiences as "how
// long before my collaborator sees my keystroke".
export const syncLatency = new Histogram({
  name: "collab_sync_latency_seconds",
  help: "Time to fan an update out to local peers and Redis",
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

export const loadedDocuments = new Gauge({
  name: "collab_loaded_documents",
  help: "Documents currently held in memory on this replica",
  registers: [registry],
});

export const snapshotWrites = new Counter({
  name: "collab_snapshot_writes_total",
  help: "Document snapshots persisted to Postgres",
  labelNames: ["outcome"] as const,
  registers: [registry],
});
