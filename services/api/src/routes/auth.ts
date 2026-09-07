import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { pool } from "../db.js";
import { hashPassword, verifyPassword } from "../auth.js";
import { RegisterBody, LoginBody, TokenReply, User, ErrorReply } from "../schemas.js";

export async function authRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/auth/register",
    {
      schema: {
        tags: ["auth"],
        summary: "Create an account",
        security: [],
        body: RegisterBody,
        response: { 201: TokenReply, 409: ErrorReply },
      },
    },
    async (req, reply) => {
      const { email, displayName, password } = req.body;
      const passwordHash = await hashPassword(password);

      const { rows } = await pool.query<{ id: string; email: string }>(
        `INSERT INTO users (email, display_name, password_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO NOTHING
         RETURNING id, email`,
        [email, displayName, passwordHash],
      );

      const created = rows[0];
      if (!created) {
        return reply.code(409).send({
          error: "email_taken",
          message: "An account with that email already exists",
          requestId: String(req.id),
        });
      }

      const token = app.jwt.sign({ sub: created.id, email: created.email });
      return reply.code(201).send({ token, expiresIn: 12 * 60 * 60 });
    },
  );

  r.post(
    "/auth/login",
    {
      schema: {
        tags: ["auth"],
        summary: "Exchange credentials for a bearer token",
        security: [],
        body: LoginBody,
        response: { 200: TokenReply, 401: ErrorReply },
      },
    },
    async (req, reply) => {
      const { email, password } = req.body;
      const { rows } = await pool.query<{ id: string; email: string; password_hash: string }>(
        `SELECT id, email, password_hash FROM users WHERE email = $1`,
        [email],
      );

      const user = rows[0];
      // Verify against a dummy hash when the user does not exist, so the
      // response time does not reveal which emails are registered. Without
      // this, the endpoint is a user-enumeration oracle.
      const stored = user?.password_hash ?? (await hashPassword("dummy-not-a-real-password"));
      const ok = await verifyPassword(password, stored);

      if (!user || !ok) {
        return reply.code(401).send({
          error: "invalid_credentials",
          message: "Email or password is incorrect",
          requestId: String(req.id),
        });
      }

      const token = app.jwt.sign({ sub: user.id, email: user.email });
      return reply.send({ token, expiresIn: 12 * 60 * 60 });
    },
  );

  r.get(
    "/auth/me",
    {
      onRequest: [(app as any).authenticate],
      schema: {
        tags: ["auth"],
        summary: "The authenticated user",
        response: { 200: User, 401: ErrorReply },
      },
    },
    async (req, reply) => {
      const { rows } = await pool.query(
        `SELECT id, email, display_name, created_at FROM users WHERE id = $1`,
        [req.user.sub],
      );
      const u = rows[0];
      if (!u) {
        return reply.code(401).send({
          error: "unauthorized",
          message: "Token refers to a user that no longer exists",
          requestId: String(req.id),
        });
      }
      return {
        id: u.id,
        email: u.email,
        displayName: u.display_name,
        createdAt: u.created_at.toISOString(),
      };
    },
  );

  void z;
}
