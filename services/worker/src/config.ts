import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3004),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  EXPORTER_URL: z.string().url(),
  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // How many jobs this process runs at once. KEDA scales replicas on queue
  // depth in stage 04, so this stays modest: the answer to a deep queue is
  // more pods, not one pod doing more, because one pod doing more hides the
  // signal KEDA scales on.
  CONCURRENCY: z.coerce.number().int().positive().default(4),

  ATTACHMENT_TTL_HOURS: z.coerce.number().int().positive().default(24),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
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
