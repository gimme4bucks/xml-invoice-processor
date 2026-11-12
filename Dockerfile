# One image, three commands (see the `xip` entrypoint below):
#   docker run <image> api       HTTP intake and queries
#   docker run <image> worker    message consumer and outbox relay
#   docker run <image> migrate   prisma migrate deploy (one-shot)
#
# Stages: base (node + pnpm) -> deps (full install) -> build -> prod-deps -> runtime.

# Exact tag plus digest; Dependabot (docker) proposes updates (both FROM lines).
FROM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS base
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
WORKDIR /app
# pnpm comes from Corepack at the version pinned in package.json#packageManager.
COPY package.json ./
RUN corepack enable pnpm && corepack install

# Manifests only, so the install layers are reused until a dependency changes. The mock-idp
# manifest is copied too: the lockfile covers the whole workspace.
FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/service/package.json apps/service/
COPY apps/mock-idp/package.json apps/mock-idp/

FROM manifests AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @xip/service

FROM deps AS build
# build:validation (work package G02) is a bash script that downloads artefacts with curl.
RUN apk add --no-cache bash curl unzip
# prisma generate reads apps/service/tsconfig.json, which extends the base config.
COPY tsconfig.base.json ./
COPY apps/service/ apps/service/
# prisma.config.ts reads DATABASE_URL even for `generate`; no database is contacted.
ARG DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN pnpm -F @xip/service prisma:generate
# Compiles the Schematron SEFs into validation-artefacts/generated/. Only the SEFs are kept:
# the downloads (the unlicensed Peppol .sch, SchXslt2) and the intermediate XSLT are build
# inputs and are not shipped in the image.
RUN pnpm -F @xip/service build:validation \
 && find apps/service/validation-artefacts/generated -mindepth 1 -maxdepth 1 ! -name '*.sef.json' \
      -exec rm -rf {} +
RUN pnpm -F @xip/service build

# Production dependencies only. The Prisma CLI is still installed: @prisma/client declares it
# as an optional peer and the lockfile resolves it (same version as the devDependency).
# Hoisting it publicly makes `prisma` and `prisma/config` resolvable for the migrate command.
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @xip/service --config.public-hoist-pattern=prisma \
 && node -e "require.resolve('prisma/package.json', { paths: ['/app/apps/service'] })"

FROM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS runtime
# CHECKPOINT_DISABLE: no update checks or telemetry from the Prisma CLI.
ENV NODE_ENV=production \
    CHECKPOINT_DISABLE=1
WORKDIR /app/apps/service
# The workspace layout is kept so pnpm's symlinked node_modules resolve. Everything is owned
# by root and only readable by the app user: the container can run with a read-only root
# filesystem.
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/apps/service/node_modules ./node_modules
COPY --from=build /app/apps/service/dist ./dist
COPY --from=build /app/apps/service/validation-artefacts ./validation-artefacts
COPY apps/service/package.json apps/service/prisma.config.ts ./
COPY apps/service/prisma ./prisma
COPY --chmod=0755 <<'EOF' /usr/local/bin/xip
#!/bin/sh
set -e
case "$1" in
  api)     shift; exec node --enable-source-maps dist/main-api.js "$@" ;;
  worker)  shift; exec node --enable-source-maps dist/main-worker.js "$@" ;;
  migrate) shift; exec /app/node_modules/.bin/prisma migrate deploy "$@" ;;
  *)       exec "$@" ;;
esac
EOF
USER node
EXPOSE 3000
ENTRYPOINT ["xip"]
CMD ["api"]
