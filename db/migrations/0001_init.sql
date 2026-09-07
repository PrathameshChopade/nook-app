-- 0001_init.sql — workspaces, pages, blocks, permissions.
--
-- Safe to run twice: every statement is guarded. Stage 04 runs migrations as a
-- pre-deploy Job that may be retried, so idempotency is a hard requirement here
-- rather than a nicety.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Permissions are a table, not a column, because stage 04's NetworkPolicy and
-- stage 07's per-workspace metrics both need to join on membership.
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- Recursive tree: a page's parent is another page in the same workspace.
-- Depth is not constrained in SQL; the API caps it, because an unbounded tree
-- is a denial-of-service vector against the recursive CTE that reads it.
CREATE TABLE IF NOT EXISTS pages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id    uuid REFERENCES pages(id) ON DELETE CASCADE,
  title        text NOT NULL DEFAULT 'Untitled',
  position     double precision NOT NULL DEFAULT 0,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blocks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id    uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  parent_id  uuid REFERENCES blocks(id) ON DELETE CASCADE,
  type       text NOT NULL,
  content    jsonb NOT NULL DEFAULT '{}'::jsonb,
  position   double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Yjs document state. collab writes here periodically; it is the durable
-- record behind the in-memory CRDT, not the source of truth during a session.
CREATE TABLE IF NOT EXISTS page_snapshots (
  page_id    uuid PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  state      bytea NOT NULL,
  clock      bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pages_workspace_parent_idx ON pages (workspace_id, parent_id, position);
CREATE INDEX IF NOT EXISTS blocks_page_parent_idx     ON blocks (page_id, parent_id, position);
CREATE INDEX IF NOT EXISTS members_user_idx           ON workspace_members (user_id);

-- Full-text search starts in Postgres deliberately. It is good enough at this
-- size, and it means no extra service to run, secure and pay for. If it stops
-- being enough, that is a measured decision with an ADR behind it, not a
-- reflex reach for Elasticsearch.
ALTER TABLE blocks
  ADD COLUMN IF NOT EXISTS search tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(content->>'text',''))) STORED;

CREATE INDEX IF NOT EXISTS blocks_search_idx ON blocks USING GIN (search);

COMMIT;
