import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { pool } from "../db.js";
import { Workspace, CreateWorkspaceBody, ErrorReply } from "../schemas.js";

export async function workspaceRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const auth = { onRequest: [(app as any).authenticate] };

  r.get(
    "/workspaces",
    {
      ...auth,
      schema: {
        tags: ["workspaces"],
        summary: "Workspaces the caller is a member of",
        response: { 200: z.array(Workspace) },
      },
    },
    async (req) => {
      const { rows } = await pool.query(
        `SELECT w.id, w.name, w.owner_id, w.created_at
           FROM workspaces w
           JOIN workspace_members m ON m.workspace_id = w.id
          WHERE m.user_id = $1
          ORDER BY w.created_at`,
        [req.user.sub],
      );
      return rows.map((w) => ({
        id: w.id,
        name: w.name,
        ownerId: w.owner_id,
        createdAt: w.created_at.toISOString(),
      }));
    },
  );

  r.post(
    "/workspaces",
    {
      ...auth,
      schema: {
        tags: ["workspaces"],
        summary: "Create a workspace",
        body: CreateWorkspaceBody,
        response: { 201: Workspace, 401: ErrorReply },
      },
    },
    async (req, reply) => {
      // Creating the workspace and its owner membership must be atomic.
      // A workspace with no members is unreachable by every read path here —
      // it would be invisible, undeletable rows accumulating silently.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(
          `INSERT INTO workspaces (name, owner_id) VALUES ($1, $2)
           RETURNING id, name, owner_id, created_at`,
          [req.body.name, req.user.sub],
        );
        const w = rows[0];
        await client.query(
          `INSERT INTO workspace_members (workspace_id, user_id, role)
           VALUES ($1, $2, 'owner')`,
          [w.id, req.user.sub],
        );
        await client.query("COMMIT");
        return reply.code(201).send({
          id: w.id,
          name: w.name,
          ownerId: w.owner_id,
          createdAt: w.created_at.toISOString(),
        });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
  );
}
