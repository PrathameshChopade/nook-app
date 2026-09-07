-- 0002 — attachments and export jobs.
--
-- Both tables exist so that work happening outside the request cycle has a
-- durable record. A queue alone is not that record: BullMQ jobs are evicted,
-- and a user asking "where is my export?" needs an answer that outlives Redis.

BEGIN;

CREATE TABLE IF NOT EXISTS attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id      uuid REFERENCES pages(id) ON DELETE SET NULL,
  uploader_id  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  object_key   text NOT NULL UNIQUE,
  filename     text NOT NULL,
  content_type text NOT NULL,
  size_bytes   bigint,
  -- Rows are created when the presigned URL is issued, before the client has
  -- uploaded anything. Until the upload is confirmed the row is pending, and
  -- a retention job in the worker sweeps ones that never completed.
  uploaded_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id      uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  format       text NOT NULL CHECK (format IN ('markdown','pdf')),
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','running','done','failed')),
  object_key   text,
  error        text,
  attempts     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS attachments_workspace_idx ON attachments (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS attachments_pending_idx   ON attachments (created_at) WHERE uploaded_at IS NULL;
CREATE INDEX IF NOT EXISTS exports_page_idx          ON exports (page_id, created_at DESC);
CREATE INDEX IF NOT EXISTS exports_requester_idx     ON exports (requested_by, created_at DESC);

COMMIT;
