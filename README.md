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
make dev
```

One command from a cold start: builds every image, starts the stack, waits
until it is genuinely usable, and prints where things are. `make clean` takes
it all down including volumes. Verified from destroyed volumes to a working
stack — collaboration, export and search all passing — in about 22 seconds
with images cached.

| | |
| --- | --- |
| web | http://localhost:8090 |
| api | http://localhost:3000 |
| collab | ws://localhost:3001 and :3002 (two replicas) |
| MinIO console | http://localhost:59001 |

`make help` lists the rest.

Host ports are deliberately non-default — Postgres on 55432, Redis on 56379,
MinIO on 59000 — so Nook never collides with something already listening. The
web client is on 8090 rather than 8080 because the kind cluster maps its
ingress to 8080, and the local stack has to run beside the local cluster.

MinIO stands in for S3 so the presigned-URL path is exercised locally with the
same SDK and the same signature as the real thing.

## Migrations

`db/migrations/` is mounted into Postgres and applied on first start. Every
migration must be safe to run twice: from stage 04 they run as a pre-deploy Job
that can be retried, so idempotency is a requirement, not a courtesy.

## Images

| Image | Size | Base |
| --- | --- | --- |
| `exporter` | 7.2 MB | distroless static, non-root |
| `api` | 279 MB | node slim, non-root |
| `collab` | 283 MB | node slim, non-root |

The exporter exists partly to make that comparison real. Every image is
multi-stage, digest-pinned, runs as a non-root user, and carries no build
toolchain in its final layer.

## Deliberately not built

No table/database views, no offline mode, no mobile client, no design system,
no AI features. The cut list is part of the plan; see `docs/adr/`.
