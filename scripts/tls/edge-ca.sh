#!/bin/sh
# Exports the root certificate of the edge's local CA (Caddy, ADR 0013) from the running compose
# stack to .tls/edge-root-ca.crt, so that clients can verify https://localhost:3443 and :4443.
# Given a command, it then runs that command trusting the certificate through NODE_EXTRA_CA_CERTS,
# as `pnpm demo` and `pnpm e2e` do. The certificate is added to the trusted roots, only for that
# command; nothing here switches certificate verification off.
#
#   sh scripts/tls/edge-ca.sh            # export and print the path (`pnpm tls:ca`), for curl --cacert
#   sh scripts/tls/edge-ca.sh cmd args   # export, then run cmd trusting the edge
set -eu

root=$(cd "$(dirname "$0")/../.." && pwd)
file="$root/.tls/edge-root-ca.crt"
mkdir -p "$root/.tls"

# Read it fresh every time: `docker compose down --volumes` gives the edge a new CA.
if ! (cd "$root" && docker compose --profile full exec -T edge \
  cat /data/caddy/pki/authorities/local/root.crt) >"$file.tmp"; then
  rm -f "$file.tmp"
  echo "Could not read the edge's root certificate. Is the stack running?" >&2
  echo "  docker compose --profile full up -d --wait" >&2
  exit 1
fi
mv "$file.tmp" "$file"

if [ "$#" -eq 0 ]; then
  echo "$file"
else
  NODE_EXTRA_CA_CERTS="$file" exec "$@"
fi
