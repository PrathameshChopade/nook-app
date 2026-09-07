# Nook

A small collaborative workspace. Notion's shape, not its scope.

Nook exists to give the Ballast platform something real to carry — five
services, a stateful WebSocket tier, and a background queue. Features were
chosen because they create operational problems worth solving, not because
they would make a good product.

## Services

| Service | Stack | Role |
| --- | --- | --- |
| `web` | React + Vite + TipTap | Static bundle; the CDN and cache-header path |
| `api` | Fastify + TypeScript | REST/OpenAPI: auth, pages, blocks, permissions |
| `collab` | Node + Yjs + Redis | Stateful WebSockets with a pub/sub backplane |
| `worker` | BullMQ | Exports, search indexing, retention |
| `exporter` | Go, distroless | PDF/Markdown export; a small image beside large ones |

## Running it

```sh
cp .env.example .env
docker compose up --build
```

Host ports are deliberately non-default — Postgres on 55432, Redis on 56379,
MinIO on 59000 — so Nook never collides with something already listening.

MinIO stands in for S3 so the presigned-URL path is exercised locally with the
same SDK and the same signature as the real thing.

## Migrations

`db/migrations/` is mounted into Postgres and applied on first start. Every
migration must be safe to run twice: from stage 04 they run as a pre-deploy Job
that can be retried, so idempotency is a requirement, not a courtesy.

## Deliberately not built

No table/database views, no offline mode, no mobile client, no design system,
no AI features. The cut list is part of the plan; see `docs/adr/`.
