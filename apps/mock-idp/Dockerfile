# Mock OAuth2 issuer (dev, demo and e2e only). Build from the repository root, because the
# lockfile covers the whole workspace:
#   docker build -f apps/mock-idp/Dockerfile .
#
# Stages: base (node + pnpm) -> deps (full install) -> build -> prod-deps -> runtime.

# Exact tag plus digest (the service image's base); Dependabot updates both FROM lines.
FROM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS base
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
WORKDIR /app
# pnpm comes from Corepack at the version pinned in package.json#packageManager.
COPY package.json ./
RUN corepack enable pnpm && corepack install

FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/service/package.json apps/service/
COPY apps/mock-idp/package.json apps/mock-idp/

FROM manifests AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @xip/mock-idp

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/mock-idp/ apps/mock-idp/
RUN pnpm -F @xip/mock-idp build

FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @xip/mock-idp

FROM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS runtime
ENV NODE_ENV=production \
    MOCK_IDP_PORT=4000
WORKDIR /app/apps/mock-idp
# Root-owned and read-only for the app user, like the service image.
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/apps/mock-idp/node_modules ./node_modules
COPY --from=build /app/apps/mock-idp/dist ./dist
COPY apps/mock-idp/package.json ./
USER node
EXPOSE 4000
CMD ["node", "--enable-source-maps", "dist/main.js"]
