import { Registry, collectDefaultMetrics, Histogram, Counter } from "prom-client";

export const registry = new Registry();
registry.setDefaultLabels({ service: "api" });
collectDefaultMetrics({ register: registry });

// RED metrics. Buckets are chosen around the latencies we expect to care
// about, not left at the library defaults — histogram_quantile is only as
// good as the bucket boundaries underneath it, and stage 07 sets an SLO on
// this exact series.
export const httpDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const httpErrors = new Counter({
  name: "http_requests_errors_total",
  help: "HTTP requests that returned 5xx",
  labelNames: ["method", "route"] as const,
  registers: [registry],
});
