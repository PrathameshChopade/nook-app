# syntax=docker/dockerfile:1.10

# Digest-pinned, not tag-pinned. A tag is a moving pointer; a digest is the
# image. Stage 05 gates on this — an unpinned base makes a "reproducible"
# build a claim rather than a fact.
FROM node:22.11.0-bookworm-slim@sha256:1b01570a09b39510be11b6d8ac43258d60c68846f26dba191843da614adb226b AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# pnpm is installed by npm at a pinned version rather than through corepack.
# The corepack bundled in this Node image carries npm's previous registry
# signing key; npm has since rotated it, so corepack rejects the signature and
# exits. The commonly suggested workaround is COREPACK_INTEGRITY_KEYS=0, which
# turns off signature verification of the package manager itself — not a trade
# worth making on a project whose CI is meant to prove supply-chain integrity.
RUN npm install -g pnpm@9.12.0 && pnpm --version

FROM base AS deps
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY services/collab/package.json services/collab/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --filter @nook/collab... --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json ./
COPY services/collab services/collab
RUN pnpm --filter @nook/collab build

# Production dependencies only, resolved separately so the build toolchain
# and dev dependencies never reach the final layer.
FROM deps AS prod-deps
WORKDIR /app
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --filter @nook/collab... --frozen-lockfile --prod

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Non-root. The node image ships an unprivileged `node` user (uid 1000);
# stage 09's Pod Security Standards at `restricted` will reject this image
# outright if it runs as root.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/services/collab/node_modules ./services/collab/node_modules
COPY --from=build --chown=node:node /app/services/collab/dist ./services/collab/dist
COPY --from=build --chown=node:node /app/services/collab/package.json ./services/collab/

USER node
EXPOSE 3001

# No shell form: exec form makes the process PID 1, so it receives SIGTERM
# directly. Shell form wraps it in /bin/sh, which does not forward signals,
# and graceful shutdown silently stops working.
# terminationGracePeriodSeconds in stage 04 must exceed SHUTDOWN_TIMEOUT_MS.
# Draining sockets takes longer than draining HTTP requests, which is why this
# service gets a longer grace period than api does.
CMD ["node", "services/collab/dist/server.js"]
