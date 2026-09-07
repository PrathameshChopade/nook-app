import { pool } from "./db.js";

export type Role = "owner" | "editor" | "viewer";

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

/**
 * Returns the caller's role in a workspace, or null if they are not a member.
 *
 * Every route that touches workspace data goes through this. Authorisation
 * that is scattered through handlers is authorisation that will eventually be
 * forgotten in one of them — and the forgotten one is the vulnerability.
 */
export async function roleInWorkspace(userId: string, workspaceId: string): Promise<Role | null> {
  const { rows } = await pool.query<{ role: Role }>(
    `SELECT role FROM workspace_members WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId],
  );
  return rows[0]?.role ?? null;
}

/** The workspace a page belongs to, or null if the page does not exist. */
export async function workspaceOfPage(pageId: string): Promise<string | null> {
  const { rows } = await pool.query<{ workspace_id: string }>(
    `SELECT workspace_id FROM pages WHERE id = $1`,
    [pageId],
  );
  return rows[0]?.workspace_id ?? null;
}

export function atLeast(role: Role | null, required: Role): boolean {
  return role !== null && RANK[role] >= RANK[required];
}
