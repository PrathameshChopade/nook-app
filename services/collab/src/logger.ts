import { pino } from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.LOG_LEVEL,
  formatters: { level: (label) => ({ level: label }) },
  redact: {
    paths: ["token", "*.token", "req.headers.authorization"],
    censor: "[redacted]",
  },
  base: { service: "collab" },
});
