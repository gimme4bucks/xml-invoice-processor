# The support app (ADR 0018): a static bundle, built with Node and served by Caddy as a non-root
# user. Build from the repository root, because the lockfile covers the whole workspace:
#   docker build -f apps/web/Dockerfile .
#
# Stages: base (node + pnpm) -> deps -> build -> runtime (Caddy and the bundle, no Node).

# Exact tag plus digest (the service image's base); Dependabot updates both FROM lines.
FROM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS base
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
WORKDIR /app
# pnpm comes from Corepack at the version pinned in package.json#packageManager.
COPY package.json ./
RUN corepack enable pnpm && corepack install

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @xip/web

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/web/ apps/web/
RUN pnpm -F @xip/web build

# The edge's Caddy release, as an exact tag plus digest.
FROM caddy:2.11.7-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5 AS runtime
# Production default, like the API's: a year. The compose stack sets 300 seconds (ADR 0013).
ENV HSTS_MAX_AGE_SECONDS=31536000
# Root-owned and only readable for the server's user: the container runs with a read-only root
# filesystem, and nothing in it is writable.
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
# Not root: port 8080 needs no capability.
USER 10001:10001
EXPOSE 8080
