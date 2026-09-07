import { z } from "zod";

// Environment is validated once, at boot, and the process refuses to start if
// it is wrong. A service that boots with a missing variable and fails later on
// the first request is far harder to diagnose than one that never comes up.
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // How long the process keeps serving after SIGTERM before forcing exit.
  // Must stay below the Kubernetes terminationGracePeriodSeconds set in
  // stage 04, or the kubelet kills us mid-request.
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // Depth cap on the recursive page tree. Enforced here rather than in SQL:
  // an unbounded tree turns the recursive read into a denial-of-service
  // vector against our own database.
  MAX_PAGE_DEPTH: z.coerce.number().int().positive().default(10),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  // Deliberately console.error and not the logger: the logger needs config.
  console.error(`Invalid environment:\n${issues}`);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
