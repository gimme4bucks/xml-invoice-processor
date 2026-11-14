#!/bin/sh
# Writes deploy/demo/.env for the public demo (ADR 0019) from deploy/demo/.env.example: every empty
# secret gets a random value (48 hex characters: safe in URLs, JSON and Basic auth), and TAG and
# ACME_EMAIL are taken from the environment when given. The file is created with mode 600 and is
# never overwritten; it stays on the server and is gitignored. Nothing is printed but its path.
#
#   TAG=1.2.0 ACME_EMAIL=ops@example.com sh deploy/demo/generate-env.sh
set -eu

dir=$(cd "$(dirname "$0")" && pwd)
target="$dir/.env"
secrets="POSTGRES_PASSWORD RABBITMQ_PASSWORD S3_SECRET_ACCESS_KEY DEMO_SUPPLIER_SECRET DEMO_CUSTOMER_SECRET DEMO_SUPPORT_PASSWORD"

if [ -e "$target" ]; then
  echo "$target already exists; remove it first to generate new secrets." >&2
  exit 1
fi

umask 077
tmp="$target.tmp"
: >"$tmp"
while IFS= read -r line || [ -n "$line" ]; do
  name=${line%%=*}
  case "$line" in
    *=) ;;
    *) printf '%s\n' "$line" >>"$tmp"; continue ;;
  esac
  value=
  case " $secrets " in
    *" $name "*) value=$(openssl rand -hex 24) ;;
  esac
  case "$name" in
    TAG) value=${TAG:-} ;;
    ACME_EMAIL) value=${ACME_EMAIL:-} ;;
  esac
  printf '%s=%s\n' "$name" "$value" >>"$tmp"
done <"$dir/.env.example"
mv "$tmp" "$target"

echo "$target"
for name in TAG ACME_EMAIL; do
  grep -q "^$name=.\{1,\}" "$target" || echo "Set $name in $target before starting." >&2
done
