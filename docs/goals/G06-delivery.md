# G06: Delivery (Docker, compose, CI/CD)

**Goal:** reproducible images, a one-command full stack and a release pipeline to GHCR with
semver tags.

## Context

- Read `CLAUDE.md`. Decisions:
  - one image runs both the API and the worker (two commands); mock-idp gets its own image;
  - GHCR images, multi-arch (amd64 + arm64) built on native runners;
  - semver tags `vX.Y.Z` produce `X.Y.Z`, `X.Y`, `X` and `latest`, plus `sha-…` and `main`;
  - SBOM and provenance attestation if there is time.

## Owned paths

- `Dockerfile`, `apps/mock-idp/Dockerfile`, `.dockerignore`
- `docker-compose.yml` (add the `full` profile; keep `infra` as is)
- `.github/workflows/**`, `.github/dependabot.yml`

## Scope

1. **Multi-stage `Dockerfile`:**
   - the `deps` stage installs with `pnpm install --frozen-lockfile`;
   - the `build` stage runs prisma generate, `pnpm -F @xip/service build` and `build:validation` when that script exists. G02 adds it, so guard the step until then;
   - the `runtime` stage is `node:22-alpine` (pin the exact tag) with production dependencies only, runs as a non-root user, and keeps the filesystem read-only-friendly;
   - entry commands: `api`, `worker` and `migrate` (`prisma migrate deploy`).
2. **`docker-compose.yml` profile `full`:**
   - services: `migrate` (one-shot), `api`, `worker` and `mock-idp`, using `depends_on` with health and completion conditions;
   - images come from `ghcr.io/gimme4bucks/xml-invoice-processor:${TAG:-latest}` with a `build:` fallback;
   - env comes from `.env.example` defaults, with short retry TTLs for the demo.
3. **`ci.yml`:** keep `verify` and `contract`. Add an `e2e` job: `docker compose --profile full up -d --build --wait`, then `pnpm -F @xip/service test:e2e --passWithNoTests`, and dump the logs on failure.
4. **`release.yml`** (on push to `main` and on `v*.*.*` tags):
   - a build matrix on `ubuntu-24.04` and `ubuntu-24.04-arm`, pushing by digest, then a manifest-merge job;
   - `docker/metadata-action` tags;
   - `permissions: packages: write, id-token: write, attestations: write`;
   - SBOM + provenance (`docker/build-push-action` attests, or `actions/attest-build-provenance`);
   - pin every action to a commit SHA with a version comment, like `ci.yml` does.
5. **`dependabot.yml`:** weekly updates for npm (grouped), GitHub Actions and Docker.

## Out of scope

Application code. A live deployment is optional (weekend).

## Acceptance criteria

- `docker build .` succeeds locally, and the image runs as non-root (show `docker run --rm <img> id`).
- `docker compose --profile full up -d --build --wait` brings the stack up healthy with `ADAPTERS=in-memory` until G07 wires the real adapters. Show `docker compose ps`, then bring it down again.
- `actionlint` (via `docker run rhysd/actionlint`) reports no errors on the workflows.
- Only owned paths changed.
- A PR is open (`ci: …` / `build: …`).

## /goal condition

```
/goal Work package G06 in docs/goals/G06-delivery.md is done: a multi-stage non-root Dockerfile (api/worker/migrate commands), a mock-idp Dockerfile, the compose `full` profile, an e2e job in ci.yml, release.yml (GHCR, native multi-arch, semver tags, SHA-pinned actions) and dependabot.yml exist; you showed `docker build` succeeding, `docker run --rm <image> id` showing a non-root user, `docker compose --profile full up -d --build --wait` healthy (`docker compose ps` shown, then brought down), and actionlint with no errors; `git diff --stat origin/main...HEAD` (shown) touches only the owned paths; and you opened a PR to main with `gh pr create` (show the URL). Follow CLAUDE.md. Or stop after 60 turns and report what is missing.
```
