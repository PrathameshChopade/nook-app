# syntax=docker/dockerfile:1.10

FROM node:22.11.0-bookworm-slim@sha256:1b01570a09b39510be11b6d8ac43258d60c68846f26dba191843da614adb226b AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install -g pnpm@9.12.0
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY services/web/package.json services/web/
RUN pnpm install --filter @nook/web... --frozen-lockfile
COPY services/web services/web
RUN pnpm --filter @nook/web build

# nginx-unprivileged rather than nginx: the stock image starts as root to bind
# port 80 and drops privileges afterwards, which stage 09's Pod Security
# Standards at `restricted` will reject. This one listens on 8080 as a
# non-root user from the start.
FROM nginxinc/nginx-unprivileged:1.27-alpine@sha256:28d91bdce70ad09025ea901458fdd149259d8e05982ade79d4ef2c0d9470eb48
COPY --from=build /app/services/web/dist /usr/share/nginx/html
COPY services/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
