import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { pool } from "../db.js";
import { config } from "../config.js";
import { Page, CreatePageBody, UpdatePageBody, Uuid, ErrorReply } from "../schemas.js";
import { roleInWorkspace, workspaceOfPage, atLeast } from "../permissions.js";

const rowToPage = (p: any) => ({
  id: p.id,
  workspaceId: p.workspace_id,
  parentId: p.parent_id,
  title: p.title,
  position: p.position,
  archivedAt: p.archived_at ? p.archived_at.toISOString() : null,
  createdAt: p.created_at.toISOString(),
  updatedAt: p.updated_at.toISOString(),
});

const forbidden = (req: any, reply: any) =>
  reply.code(403).send({
    error: "forbidden",
    message: "You do not have access to that workspace",
    requestId: String(req.id),
  });

export async function pageRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const auth = { onRequest: [(app as any).authenticate] };

  r.get(
    "/workspaces/:workspaceId/pages",
    {
      ...auth,
      schema: {
        tags: ["pages"],
        summary: "Pages in a workspace, as a flat list ordered for tree assembly",
        params: z.object({ workspaceId: Uuid }),
        response: { 200: z.array(Page), 403: ErrorReply },
      },
    },
    async (req, reply) => {
      const role = await roleInWorkspace(req.user.sub, req.params.workspaceId);
      if (!atLeast(role, "viewer")) return forbidden(req, reply);

      const { rows } = await pool.query(
        `SELECT * FROM pages
          WHERE workspace_id = $1 AND archived_at IS NULL
          ORDER BY parent_id NULLS FIRST, position, created_at`,
        [req.params.workspaceId],
      );
      return rows.map(rowToPage);
    },
  );

  r.post(
    "/pages",
    {
      ...auth,
      schema: {
        tags: ["pages"],
        summary: "Create a page, optionally nested under another",
        body: CreatePageBody,
        response: { 201: Page, 403: ErrorReply, 422: ErrorReply },
      },
    },
    async (req, reply) => {
      const { workspaceId, parentId, title } = req.body;
      const role = await roleInWorkspace(req.user.sub, workspaceId);
      if (!atLeast(role, "editor")) return forbidden(req, reply);

      if (parentId) {
        // Depth is capped here, before the insert. The recursive CTE below is
        // bounded by the same limit, so a tree that is already too deep cannot
        // be made deeper, and the read can never run away.
        const { rows } = await pool.query<{ depth: number; workspace_id: string }>(
          `WITH RECURSIVE ancestry AS (
             SELECT id, parent_id, workspace_id, 1 AS depth FROM pages WHERE id = $1
             UNION ALL
             SELECT p.id, p.parent_id, p.workspace_id, a.depth + 1
               FROM pages p JOIN ancestry a ON p.id = a.parent_id
              WHERE a.depth < $2
           )
           SELECT max(depth) AS depth, min(workspace_id::text)::uuid AS workspace_id FROM ancestry`,
          [parentId, config.MAX_PAGE_DEPTH],
        );

        const parent = rows[0];
        if (!parent?.depth) {
          return reply.code(422).send({
            error: "parent_not_found",
            message: "The parent page does not exist",
            requestId: String(req.id),
          });
        }
        // A parent in another workspace would let a member of workspace A
        // graft pages into workspace B.
        if (parent.workspace_id !== workspaceId) {
          return reply.code(422).send({
            error: "parent_in_other_workspace",
            message: "The parent page belongs to a different workspace",
            requestId: String(req.id),
          });
        }
        if (parent.depth >= config.MAX_PAGE_DEPTH) {
          return reply.code(422).send({
            error: "max_depth_exceeded",
            message: `Pages may not nest deeper than ${config.MAX_PAGE_DEPTH} levels`,
            requestId: String(req.id),
          });
        }
      }

      const { rows } = await pool.query(
        `INSERT INTO pages (workspace_id, parent_id, title) VALUES ($1, $2, $3) RETURNING *`,
        [workspaceId, parentId ?? null, title],
      );
      return reply.code(201).send(rowToPage(rows[0]));
    },
  );

  r.get(
    "/pages/:id",
    {
      ...auth,
      schema: {
        tags: ["pages"],
        params: z.object({ id: Uuid }),
        response: { 200: Page, 403: ErrorReply, 404: ErrorReply },
      },
    },
    async (req, reply) => {
      const ws = await workspaceOfPage(req.params.id);
      if (!ws) {
        return reply.code(404).send({
          error: "not_found",
          message: "No such page",
          requestId: String(req.id),
        });
      }
      const role = await roleInWorkspace(req.user.sub, ws);
      if (!atLeast(role, "viewer")) return forbidden(req, reply);

      const { rows } = await pool.query(`SELECT * FROM pages WHERE id = $1`, [req.params.id]);
      return rowToPage(rows[0]);
    },
  );

  r.patch(
    "/pages/:id",
    {
      ...auth,
      schema: {
        tags: ["pages"],
        params: z.object({ id: Uuid }),
        body: UpdatePageBody,
        response: { 200: Page, 403: ErrorReply, 404: ErrorReply },
      },
    },
    async (req, reply) => {
      const ws = await workspaceOfPage(req.params.id);
      if (!ws) {
        return reply.code(404).send({
          error: "not_found",
          message: "No such page",
          requestId: String(req.id),
        });
      }
      const role = await roleInWorkspace(req.user.sub, ws);
      if (!atLeast(role, "editor")) return forbidden(req, reply);

      const { rows } = await pool.query(
        `UPDATE pages
            SET title      = COALESCE($2, title),
                parent_id  = COALESCE($3, parent_id),
                position   = COALESCE($4, position),
                updated_at = now()
          WHERE id = $1
        RETURNING *`,
        [
          req.params.id,
          req.body.title ?? null,
          req.body.parentId ?? null,
          req.body.position ?? null,
        ],
      );
      return rowToPage(rows[0]);
    },
  );

  r.delete(
    "/pages/:id",
    {
      ...auth,
      schema: {
        tags: ["pages"],
        summary: "Archive a page (soft delete)",
        params: z.object({ id: Uuid }),
        response: { 204: z.null(), 403: ErrorReply, 404: ErrorReply },
      },
    },
    async (req, reply) => {
      const ws = await workspaceOfPage(req.params.id);
      if (!ws) {
        return reply.code(404).send({
          error: "not_found",
          message: "No such page",
          requestId: String(req.id),
        });
      }
      const role = await roleInWorkspace(req.user.sub, ws);
      if (!atLeast(role, "editor")) return forbidden(req, reply);

      await pool.query(`UPDATE pages SET archived_at = now() WHERE id = $1`, [req.params.id]);
      return reply.code(204).send(null);
    },
  );
}
