import pg from "pg";
import { config } from "./config.js";
import { logger } from "./logger.js";

pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 6,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});
pool.on("error", (err: Error) => logger.error({ err }, "idle postgres client error"));

export const pingDb = () => pool.query("SELECT 1").then(() => undefined);
