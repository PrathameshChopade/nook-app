import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { pool } from "../db.js";
import { Block, CreateBlockBody, Uuid, ErrorReply } from "../schemas.js";
import { roleInWorkspace, workspaceOfPage, atLeast } from "../permissions.js";

const rowToBlock = (b: any) => ({
  id: b.id,
  pageId: b.page_id,
  parentId: b.parent_id,
  type: b.type,
  content: b.content,
  position: b.position,
});

export async function blockRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const auth = { onRequest: [(app as any).authenticate] };

  async function guard(req: any, reply: any, pageId: string, need: "viewer" | "editor") {
    const ws = await workspaceOfPage(pageId);
    if (!ws) {
      reply.code(404).send({
        error: "not_found",
        message: "No such page",
        requestId: String(req.id),
      });
      return false;
    }
    const role = await roleInWorkspace(req.user.sub, ws);
    if (!atLeast(role, need)) {
      reply.code(403).send({
        error: "forbidden",
        message: "You do not have access to that workspace",
        requestId: String(req.id),
      });
      return false;
    }
    return true;
  }

  r.get(
    "/pages/:pageId/blocks",
    {
      ...auth,
      schema: {
        tags: ["blocks"],
        params: z.object({ pageId: Uuid }),
        response: { 200: z.array(Block), 403: ErrorReply, 404: ErrorReply },
      },
    },
    async (req, reply) => {
      if (!(await guard(req, reply, req.params.pageId, "viewer"))) return;
      const { rows } = await pool.query(
        `SELECT * FROM blocks WHERE page_id = $1 ORDER BY parent_id NULLS FIRST, position, created_at`,
        [req.params.pageId],
      );
      return rows.map(rowToBlock);
    },
  );

  r.post(
    "/pages/:pageId/blocks",
    {
      ...auth,
      schema: {
        tags: ["blocks"],
        params: z.object({ pageId: Uuid }),
        body: CreateBlockBody,
        response: { 201: Block, 403: ErrorReply, 404: ErrorReply },
      },
    },
    async (req, reply) => {
      if (!(await guard(req, reply, req.params.pageId, "editor"))) return;
      const { parentId, type, content, position } = req.body;
      const { rows } = await pool.query(
        `INSERT INTO blocks (page_id, parent_id, type, content, position)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [req.params.pageId, parentId ?? null, type, content, position],
      );
      return reply.code(201).send(rowToBlock(rows[0]));
    },
  );

  r.get(
    "/workspaces/:workspaceId/search",
    {
      ...auth,
      schema: {
        tags: ["blocks"],
        summary: "Full-text search across a workspace's blocks",
        params: z.object({ workspaceId: Uuid }),
        querystring: z.object({ q: z.string().min(1).max(200) }),
        response: {
          200: z.array(z.object({ blockId: Uuid, pageId: Uuid, pageTitle: z.string(), snippet: z.string() })),
          403: ErrorReply,
        },
      },
    },
    async (req, reply) => {
      const role = await roleInWorkspace(req.user.sub, req.params.workspaceId);
      if (!atLeast(role, "viewer")) {
        return reply.code(403).send({
          error: "forbidden",
          message: "You do not have access to that workspace",
          requestId: String(req.id),
        });
      }

      // websearch_to_tsquery accepts human input ("quoted phrase", -negation)
      // without throwing on malformed syntax. plainto_tsquery would lose the
      // operators; to_tsquery would raise on anything users actually type.
      const { rows } = await pool.query(
        `SELECT b.id AS block_id, b.page_id, p.title AS page_title,
                ts_headline('english', coalesce(b.content->>'text',''),
                            websearch_to_tsquery('english', $2)) AS snippet
           FROM blocks b
           JOIN pages p ON p.id = b.page_id
          WHERE p.workspace_id = $1
            AND p.archived_at IS NULL
            AND b.search @@ websearch_to_tsquery('english', $2)
          ORDER BY ts_rank(b.search, websearch_to_tsquery('english', $2)) DESC
          LIMIT 50`,
        [req.params.workspaceId, req.query.q],
      );

      return rows.map((row) => ({
        blockId: row.block_id,
        pageId: row.page_id,
        pageTitle: row.page_title,
        snippet: row.snippet,
      }));
    },
  );
}
