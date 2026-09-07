import { UnrecoverableError } from "bullmq";

import { pool } from "../db.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { putObject } from "../storage.js";
import type { ExportJob } from "../queues.js";

type BlockRow = { type: string; content: Record<string, unknown>; depth: number };

/**
 * Flattens a page's block tree into a depth-annotated list.
 *
 * The recursive CTE is bounded by a depth limit for the same reason the API
 * caps page nesting: a cycle introduced by a bug would otherwise spin here
 * until the job times out, on every retry, forever.
 */
async function loadBlocks(pageId: string): Promise<{ title: string; blocks: BlockRow[] }> {
  const { rows: pageRows } = await pool.query<{ title: string }>(
    "SELECT title FROM pages WHERE id = $1",
    [pageId],
  );
  const page = pageRows[0];
  if (!page) throw new Error(`page ${pageId} not found`);

  const { rows } = await pool.query<BlockRow>(
    `WITH RECURSIVE tree AS (
       SELECT id, parent_id, type, content, position, 0 AS depth
         FROM blocks WHERE page_id = $1 AND parent_id IS NULL
       UNION ALL
       SELECT b.id, b.parent_id, b.type, b.content, b.position, t.depth + 1
         FROM blocks b JOIN tree t ON b.parent_id = t.id
        WHERE t.depth < 20
     )
     SELECT type, content, depth FROM tree ORDER BY depth, position`,
    [pageId],
  );
  return { title: page.title, blocks: rows };
}

export async function runExport(job: ExportJob): Promise<void> {
  const log = logger.child({ exportId: job.exportId, pageId: job.pageId, format: job.format });

  await pool.query(
    "UPDATE exports SET status = 'running', attempts = attempts + 1 WHERE id = $1",
    [job.exportId],
  );

  try {
    const { title, blocks } = await loadBlocks(job.pageId);

    // A timeout on the call to the exporter, not just on the job. Without one
    // a hung exporter holds this worker slot until BullMQ's stalled-job
    // detection fires, which is far slower than failing fast and retrying.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    let body: Uint8Array;
    try {
      const res = await fetch(`${config.EXPORTER_URL}/render`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, format: job.format, blocks }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 200);
        const message = `exporter returned ${res.status}: ${detail}`;
        // A 4xx or a 501 means this request will never succeed: the format is
        // unsupported, the payload is malformed, the feature does not exist.
        // Retrying it four times with backoff occupies a worker slot and
        // delays the honest answer without changing it. Only server-side
        // failures — 5xx other than 501, timeouts, connection refused — are
        // worth another attempt.
        if (res.status === 501 || (res.status >= 400 && res.status < 500)) {
          throw new UnrecoverableError(message);
        }
        throw new Error(message);
      }
      body = new Uint8Array(await res.arrayBuffer());
    } finally {
      clearTimeout(timeout);
    }

    const ext = job.format === "pdf" ? "pdf" : "md";
    const key = `exports/${job.pageId}/${job.exportId}.${ext}`;
    await putObject(key, body, job.format === "pdf" ? "application/pdf" : "text/markdown");

    await pool.query(
      "UPDATE exports SET status = 'done', object_key = $2, error = NULL, completed_at = now() WHERE id = $1",
      [job.exportId, key],
    );
    log.info({ key, bytes: body.length }, "export complete");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Record the failure but leave status as 'running' unless this was the
    // final attempt — a row that says 'failed' while BullMQ is still retrying
    // tells the user something untrue.
    await pool.query("UPDATE exports SET error = $2 WHERE id = $1", [job.exportId, message]);
    log.warn({ err: message }, "export attempt failed");
    throw err;
  }
}

/**
 * Called when BullMQ will not try again — either the attempts are exhausted or
 * the failure was unrecoverable.
 */
export async function markExportFailed(exportId: string, message: string): Promise<void> {
  await pool.query(
    "UPDATE exports SET status = 'failed', error = $2, completed_at = now() WHERE id = $1",
    [exportId, message],
  );
}
