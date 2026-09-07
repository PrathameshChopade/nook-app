import { pino } from "pino";
import { config } from "./config.js";

// Structured JSON on stdout, always — including in development. Logs that look
// different locally than in the cluster are logs you have not really tested.
// Loki parses these directly in stage 07.
export const logger = pino({
  level: config.LOG_LEVEL,
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Anything credential-shaped is removed before it can reach a log sink.
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "password",
      "*.password",
      "password_hash",
      "*.password_hash",
    ],
    censor: "[redacted]",
  },
  base: { service: "api" },
});
