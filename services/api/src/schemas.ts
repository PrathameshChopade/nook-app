import { z } from "zod";

// These schemas are the single source of truth: Fastify validates against
// them at runtime, TypeScript infers request and reply types from them, and
// the OpenAPI document is generated from them. One definition, three uses —
// which is what makes the published spec trustworthy enough for stage 05's
// contract tests to bind to.

export const Uuid = z.string().uuid();

export const RegisterBody = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(120),
  password: z.string().min(12, "password must be at least 12 characters"),
});

export const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const TokenReply = z.object({
  token: z.string(),
  expiresIn: z.number().int(),
});

export const User = z.object({
  id: Uuid,
  email: z.string().email(),
  displayName: z.string(),
  createdAt: z.string().datetime(),
});

export const Workspace = z.object({
  id: Uuid,
  name: z.string(),
  ownerId: Uuid,
  createdAt: z.string().datetime(),
});

export const CreateWorkspaceBody = z.object({
  name: z.string().min(1).max(200),
});

export const Page = z.object({
  id: Uuid,
  workspaceId: Uuid,
  parentId: Uuid.nullable(),
  title: z.string(),
  position: z.number(),
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const CreatePageBody = z.object({
  workspaceId: Uuid,
  parentId: Uuid.nullable().optional(),
  title: z.string().min(1).max(500).default("Untitled"),
});

export const UpdatePageBody = z
  .object({
    title: z.string().min(1).max(500),
    parentId: Uuid.nullable(),
    position: z.number(),
  })
  .partial();

export const Block = z.object({
  id: Uuid,
  pageId: Uuid,
  parentId: Uuid.nullable(),
  type: z.string(),
  content: z.record(z.unknown()),
  position: z.number(),
});

export const CreateBlockBody = z.object({
  parentId: Uuid.nullable().optional(),
  type: z.string().min(1).max(64),
  content: z.record(z.unknown()).default({}),
  position: z.number().default(0),
});

export const ErrorReply = z.object({
  error: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
});
