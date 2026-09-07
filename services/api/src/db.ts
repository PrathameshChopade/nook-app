import pg from "pg";
import { config } from "./config.js";
import { logger } from "./logger.js";

// Postgres hands back BIGINT as a string to avoid silent precision loss.
// page_snapshots.clock is a bigint and we want it as a number, so parse it
// explicitly rather than discovering the string downstream.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  // Sized against RDS max_connections in stage 04. Exhausting the pool is one
  // of the failures deliberately induced in stage 08, so this number is meant
  // to be tuned with evidence rather than left at a default.
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  // An idle client erroring is not fatal — the pool replaces it — but it is a
  // signal worth alerting on if it becomes frequent.
  logger.error({ err }, "idle postgres client error");
});

export async function pingDb(): Promise<void> {
  await pool.query("SELECT 1");
}
