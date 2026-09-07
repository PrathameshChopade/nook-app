import { pool } from "../db.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Removes attachment rows whose upload never completed.
 *
 * A presigned URL is issued optimistically: the row exists before the client
 * has uploaded anything. Most of those uploads happen; some do not, because
 * the user closed the tab. Without this sweep the table accumulates rows that
 * point at objects which do not exist, and the count of "attachments" slowly
 * becomes a lie.
 *
 * The S3 object is deliberately not deleted here. If the upload did land but
 * the confirmation call was lost, deleting it would destroy the user's file
 * on the basis of a missing acknowledgement. A lifecycle rule on the bucket
 * handles genuinely orphaned objects — the storage layer is a better place to
 * decide that than a job racing the client.
 */
export async function sweepPendingAttachments(): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM attachments
      WHERE uploaded_at IS NULL
        AND created_at < now() - ($1 || ' hours')::interval`,
    [String(config.ATTACHMENT_TTL_HOURS)],
  );
  if (rowCount) logger.info({ removed: rowCount }, "swept pending attachments");
  return rowCount ?? 0;
}
