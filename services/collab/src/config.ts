import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(16),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // How long after the last edit before the document is written to Postgres.
  // Lower means less data lost if every replica holding a document dies at
  // once; higher means fewer writes. This number is the RPO for document
  // content, and stage 08 measures whether it holds under load.
  SNAPSHOT_DEBOUNCE_MS: z.coerce.number().int().positive().default(5_000),

  // A document with no connections is unloaded after this long. Without it,
  // a replica's memory grows with every document ever opened on it.
  DOC_IDLE_TTL_MS: z.coerce.number().int().positive().default(60_000),

  // Time allowed for sockets to drain on SIGTERM. Must stay below the
  // Kubernetes terminationGracePeriodSeconds set in stage 04.
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error(
    "Invalid environment:\n" +
      parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n"),
  );
  process.exit(1);
}

export const config = parsed.data;
