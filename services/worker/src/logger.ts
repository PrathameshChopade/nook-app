import { pino } from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.LOG_LEVEL,
  formatters: { level: (label) => ({ level: label }) },
  redact: { paths: ["S3_SECRET_KEY", "*.secretAccessKey"], censor: "[redacted]" },
  base: { service: "worker" },
});
