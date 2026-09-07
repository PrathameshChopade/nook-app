import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from "prom-client";

export const registry = new Registry();
registry.setDefaultLabels({ service: "worker" });
collectDefaultMetrics({ register: registry });

export const jobsProcessed = new Counter({
  name: "worker_jobs_total",
  help: "Jobs finished, by queue and outcome",
  labelNames: ["queue", "outcome"] as const,
  registers: [registry],
});

export const jobDuration = new Histogram({
  name: "worker_job_duration_seconds",
  help: "Job execution time",
  labelNames: ["queue"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

// The signal KEDA scales on in stage 04. Exposed here as well as read from
// Redis directly so a dashboard can show queue depth beside job latency and
// the two can be correlated during an incident.
export const queueDepth = new Gauge({
  name: "worker_queue_depth",
  help: "Jobs waiting in each queue",
  labelNames: ["queue"] as const,
  registers: [registry],
});
