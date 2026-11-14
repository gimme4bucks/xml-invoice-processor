#!/bin/sh
# `pnpm demo`: runs demo.mts against the local stack or, with API_BASE_URL set to a public host,
# against the public demo (deploy/demo, ADR 0019).
# - Local (https://localhost:…, the default): trust the edge's own root certificate, which
#   scripts/tls/edge-ca.sh exports from the running stack.
# - Public: Node's built-in public CAs verify the Let's Encrypt certificates; no local stack and no
#   extra certificate needed. Verification is never switched off.
set -eu

root=$(cd "$(dirname "$0")/../.." && pwd)
set -- node --experimental-strip-types --disable-warning=ExperimentalWarning "$root/scripts/demo/demo.mts"

case "${API_BASE_URL:-https://localhost:3443}" in
  https://localhost | https://localhost:* | https://localhost/*) exec sh "$root/scripts/tls/edge-ca.sh" "$@" ;;
  *) exec "$@" ;;
esac
