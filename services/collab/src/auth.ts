import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { pool } from "./db.js";

export type Claims = { sub: string; email: string };
export type Access = { userId: string; canEdit: boolean };

/**
 * Browsers cannot set an Authorization header on a WebSocket handshake. The
 * WebSocket API exposes no header option at all, which leaves three choices:
 *
 *   1. Token in the query string — simple, and wrong: URLs land in access
 *      logs, proxy logs and Referer headers. A bearer token in a log file is
 *      a credential leak with a long tail.
 *   2. Token as a Sec-WebSocket-Protocol value — a documented abuse of the
 *      subprotocol negotiation field, but it travels as a header, stays out
 *      of logs, and is what most production systems settle on.
 *   3. A short-lived ticket fetched over HTTP and exchanged at connect time —
 *      the most correct option, and one more round trip plus a store.
 *
 * We take (2) and record why in the protocol document. If a security review
 * later demands (3), that is a contained change to this file.
 */
export function tokenFromHandshake(protocolHeader: string | undefined): string | null {
  if (!protocolHeader) return null;
  const parts = protocolHeader.split(",").map((p) => p.trim());
  const bearer = parts.find((p) => p.startsWith("bearer."));
  return bearer ? bearer.slice("bearer.".length) : null;
}

export function verifyToken(token: string): Claims | null {
  try {
    const claims = jwt.verify(token, config.JWT_SECRET, { algorithms: ["HS256"] });
    if (typeof claims === "string" || !claims.sub) return null;
    return { sub: String(claims.sub), email: String((claims as any).email ?? "") };
  } catch {
    return null;
  }
}

/**
 * Resolves what this user may do with this page, in one query.
 *
 * Authorisation is checked at connect time and not again. That is a deliberate
 * and documented limitation: revoking someone's access does not close their
 * open socket. Stage 09 revisits it — the fix is a revocation channel on
 * Redis, not a per-message database lookup, which would put a query in the
 * hot path of every keystroke.
 */
export async function accessToPage(userId: string, pageId: string): Promise<Access | null> {
  const { rows } = await pool.query<{ role: string }>(
    `SELECT m.role
       FROM pages p
       JOIN workspace_members m ON m.workspace_id = p.workspace_id
      WHERE p.id = $1 AND m.user_id = $2 AND p.archived_at IS NULL`,
    [pageId, userId],
  );
  const role = rows[0]?.role;
  if (!role) return null;
  return { userId, canEdit: role === "owner" || role === "editor" };
}
