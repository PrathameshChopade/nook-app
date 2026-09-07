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

  REDIS_URL: z.string().url(),
  S3_ENDPOINT: z.string().url(),

  // The endpoint signed into presigned URLs, when it differs from the one this
  // service talks to. A presigned URL is opened by a browser, so it must carry
  // an address the browser can reach — not the cluster-internal service name.
  // The signature covers the host, so this cannot be rewritten after signing:
  // it has to be correct at signing time. Unset in AWS, where S3's endpoint is
  // already public.
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),

  // How long a presigned upload URL stays valid. Short on purpose: the URL is
  // a bearer credential for one object, and anyone who obtains it can write
  // there until it expires.
  PRESIGN_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // Refused before a URL is issued rather than after the bytes arrive. A
  // presigned PUT goes straight to S3 and never touches this service, so this
  // is the only place we get to say no.
  MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),

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
