import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { pool } from "../db.js";
import { config } from "../config.js";
import { presignUpload, presignDownload } from "../storage.js";
import { Uuid, ErrorReply } from "../schemas.js";
import { roleInWorkspace, atLeast } from "../permissions.js";

const Attachment = z.object({
  id: Uuid,
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().nullable(),
  uploaded: z.boolean(),
  createdAt: z.string().datetime(),
});

export async function attachmentRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const auth = { onRequest: [(app as any).authenticate] };

  const forbidden = (req: any, reply: any) =>
    reply.code(403).send({
      error: "forbidden",
      message: "You do not have access to that workspace",
      requestId: String(req.id),
    });

  r.post(
    "/workspaces/:workspaceId/attachments",
    {
      ...auth,
      schema: {
        tags: ["attachments"],
        summary: "Request a presigned URL to upload one file",
        params: z.object({ workspaceId: Uuid }),
        body: z.object({
          filename: z.string().min(1).max(255),
          contentType: z.string().min(1).max(255),
          sizeBytes: z.number().int().positive(),
          pageId: Uuid.nullable().optional(),
        }),
        response: {
          201: z.object({
            attachment: Attachment,
            uploadUrl: z.string().url(),
            expiresInSeconds: z.number().int(),
          }),
          403: ErrorReply,
          413: ErrorReply,
        },
      },
    },
    async (req, reply) => {
      const role = await roleInWorkspace(req.user.sub, req.params.workspaceId);
      if (!atLeast(role, "editor")) return forbidden(req, reply);

      if (req.body.sizeBytes > config.MAX_ATTACHMENT_BYTES) {
        // Checked here because it cannot be checked anywhere else: the upload
        // goes straight to S3 and this service never sees the bytes.
        return reply.code(413).send({
          error: "too_large",
          message: `Attachments may not exceed ${config.MAX_ATTACHMENT_BYTES} bytes`,
          requestId: String(req.id),
        });
      }

      // The key is generated server-side from a UUID; the user's filename is
      // kept as metadata only. Deriving a key from user input invites path
      // traversal and lets one user guess or collide with another's object.
      const key = `attachments/${req.params.workspaceId}/${randomUUID()}`;

      const { rows } = await pool.query(
        `INSERT INTO attachments
           (workspace_id, page_id, uploader_id, object_key, filename, content_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          req.params.workspaceId,
          req.body.pageId ?? null,
          req.user.sub,
          key,
          req.body.filename,
          req.body.contentType,
          req.body.sizeBytes,
        ],
      );
      const a = rows[0];
      const uploadUrl = await presignUpload(key, req.body.contentType, req.body.sizeBytes);

      return reply.code(201).send({
        attachment: {
          id: a.id,
          filename: a.filename,
          contentType: a.content_type,
          sizeBytes: a.size_bytes,
          uploaded: false,
          createdAt: a.created_at.toISOString(),
        },
        uploadUrl,
        expiresInSeconds: config.PRESIGN_TTL_SECONDS,
      });
    },
  );

  r.post(
    "/attachments/:id/complete",
    {
      ...auth,
      schema: {
        tags: ["attachments"],
        summary: "Confirm an upload finished",
        params: z.object({ id: Uuid }),
        response: { 200: Attachment, 403: ErrorReply, 404: ErrorReply },
      },
    },
    async (req, reply) => {
      const { rows } = await pool.query(`SELECT * FROM attachments WHERE id = $1`, [req.params.id]);
      const a = rows[0];
      if (!a) {
        return reply.code(404).send({
          error: "not_found",
          message: "No such attachment",
          requestId: String(req.id),
        });
      }
      const role = await roleInWorkspace(req.user.sub, a.workspace_id);
      if (!atLeast(role, "editor")) return forbidden(req, reply);

      // Trusting the client's word that the upload happened. The alternative
      // is a HeadObject against S3 on every confirmation, which is a round
      // trip to prove something the retention sweep already handles: an
      // unconfirmed row is deleted, and a confirmed row pointing at nothing
      // fails visibly at download.
      const { rows: updated } = await pool.query(
        `UPDATE attachments SET uploaded_at = now() WHERE id = $1 RETURNING *`,
        [req.params.id],
      );
      const u = updated[0];
      return {
        id: u.id,
        filename: u.filename,
        contentType: u.content_type,
        sizeBytes: u.size_bytes,
        uploaded: true,
        createdAt: u.created_at.toISOString(),
      };
    },
  );

  r.get(
    "/attachments/:id/url",
    {
      ...auth,
      schema: {
        tags: ["attachments"],
        summary: "A short-lived download URL",
        params: z.object({ id: Uuid }),
        response: {
          200: z.object({ url: z.string().url(), expiresInSeconds: z.number().int() }),
          403: ErrorReply,
          404: ErrorReply,
          409: ErrorReply,
        },
      },
    },
    async (req, reply) => {
      const { rows } = await pool.query(`SELECT * FROM attachments WHERE id = $1`, [req.params.id]);
      const a = rows[0];
      if (!a) {
        return reply.code(404).send({
          error: "not_found",
          message: "No such attachment",
          requestId: String(req.id),
        });
      }
      const role = await roleInWorkspace(req.user.sub, a.workspace_id);
      if (!atLeast(role, "viewer")) return forbidden(req, reply);
      if (!a.uploaded_at) {
        return reply.code(409).send({
          error: "not_uploaded",
          message: "That attachment has not finished uploading",
          requestId: String(req.id),
        });
      }
      return { url: await presignDownload(a.object_key), expiresInSeconds: config.PRESIGN_TTL_SECONDS };
    },
  );
}
