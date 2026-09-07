import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { pool } from "../db.js";
import { exportQueue } from "../queue.js";
import { presignDownload } from "../storage.js";
import { Uuid, ErrorReply } from "../schemas.js";
import { roleInWorkspace, workspaceOfPage, atLeast } from "../permissions.js";

const ExportRecord = z.object({
  id: Uuid,
  pageId: Uuid,
  format: z.enum(["markdown", "pdf"]),
  status: z.enum(["queued", "running", "done", "failed"]),
  error: z.string().nullable(),
  downloadUrl: z.string().url().nullable(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});

export async function exportRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const auth = { onRequest: [(app as any).authenticate] };

  r.post(
    "/pages/:pageId/exports",
    {
      ...auth,
      schema: {
        tags: ["exports"],
        summary: "Queue an export of a page",
        params: z.object({ pageId: Uuid }),
        body: z.object({ format: z.enum(["markdown", "pdf"]).default("markdown") }),
        response: { 202: ExportRecord, 403: ErrorReply, 404: ErrorReply },
      },
    },
    async (req, reply) => {
      const ws = await workspaceOfPage(req.params.pageId);
      if (!ws) {
        return reply.code(404).send({
          error: "not_found",
          message: "No such page",
          requestId: String(req.id),
        });
      }
      const role = await roleInWorkspace(req.user.sub, ws);
      if (!atLeast(role, "viewer")) {
        return reply.code(403).send({
          error: "forbidden",
          message: "You do not have access to that workspace",
          requestId: String(req.id),
        });
      }

      // The row is written before the job is enqueued. The other order loses
      // the job if the process dies between the two: the queue would hold work
      // referring to an export record that does not exist. This way the worst
      // case is a row stuck at 'queued', which is visible and recoverable.
      const { rows } = await pool.query(
        `INSERT INTO exports (page_id, requested_by, format) VALUES ($1, $2, $3) RETURNING *`,
        [req.params.pageId, req.user.sub, req.body.format],
      );
      const rec = rows[0];

      await exportQueue.add(
        "export",
        { exportId: rec.id, pageId: rec.page_id, format: rec.format },
        { jobId: rec.id },
      );

      return reply.code(202).send({
        id: rec.id,
        pageId: rec.page_id,
        format: rec.format,
        status: rec.status,
        error: null,
        downloadUrl: null,
        createdAt: rec.created_at.toISOString(),
        completedAt: null,
      });
    },
  );

  r.get(
    "/exports/:id",
    {
      ...auth,
      schema: {
        tags: ["exports"],
        summary: "Poll an export; a finished one carries a short-lived download URL",
        params: z.object({ id: Uuid }),
        response: { 200: ExportRecord, 403: ErrorReply, 404: ErrorReply },
      },
    },
    async (req, reply) => {
      const { rows } = await pool.query(
        `SELECT e.*, p.workspace_id FROM exports e JOIN pages p ON p.id = e.page_id WHERE e.id = $1`,
        [req.params.id],
      );
      const rec = rows[0];
      if (!rec) {
        return reply.code(404).send({
          error: "not_found",
          message: "No such export",
          requestId: String(req.id),
        });
      }
      const role = await roleInWorkspace(req.user.sub, rec.workspace_id);
      if (!atLeast(role, "viewer")) {
        return reply.code(403).send({
          error: "forbidden",
          message: "You do not have access to that workspace",
          requestId: String(req.id),
        });
      }

      return {
        id: rec.id,
        pageId: rec.page_id,
        format: rec.format,
        status: rec.status,
        error: rec.error,
        downloadUrl:
          rec.status === "done" && rec.object_key ? await presignDownload(rec.object_key) : null,
        createdAt: rec.created_at.toISOString(),
        completedAt: rec.completed_at ? rec.completed_at.toISOString() : null,
      };
    },
  );
}
