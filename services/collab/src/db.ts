import pg from "pg";
import { config } from "./config.js";
import { logger } from "./logger.js";

pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => logger.error({ err }, "idle postgres client error"));

export async function pingDb(): Promise<void> {
  await pool.query("SELECT 1");
}

/** Loads a page's last persisted Yjs state, or null if it has never been saved. */
export async function loadSnapshot(pageId: string): Promise<Uint8Array | null> {
  const { rows } = await pool.query<{ state: Buffer }>(
    "SELECT state FROM page_snapshots WHERE page_id = $1",
    [pageId],
  );
  const row = rows[0];
  return row ? new Uint8Array(row.state) : null;
}

/**
 * Persists a document's state.
 *
 * The clock increments on every write and exists so a replica that has been
 * partitioned cannot silently overwrite newer state with older state when it
 * rejoins. Last-write-wins on wall-clock time would do exactly that.
 */
export async function saveSnapshot(pageId: string, state: Uint8Array): Promise<void> {
  await pool.query(
    `INSERT INTO page_snapshots (page_id, state, clock, updated_at)
     VALUES ($1, $2, 1, now())
     ON CONFLICT (page_id) DO UPDATE
       SET state = EXCLUDED.state,
           clock = page_snapshots.clock + 1,
           updated_at = now()`,
    [pageId, Buffer.from(state)],
  );
}
