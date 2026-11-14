#!/usr/bin/env bash
# Builds the Schematron SEFs that SchematronBusinessRuleValidator runs on SaxonJS (ADR 0001).
#
#   1. verifies every committed artifact (UBL xsdrt, CEN XSLT) against manifest.json;
#   2. downloads the Peppol 3.0.22 .sch and SchXslt2 1.11.2 and verifies their sha256;
#   3. compiles the CEN XSLT to a SEF, transpiles the Peppol .sch with SchXslt2 and compiles
#      the result to a SEF.
#
# Everything it writes goes to validation-artifacts/generated/ (gitignored): the Peppol .sch
# has no licence and must never be committed, and SEFs are not reproducible (they embed a build
# timestamp). Needs node, curl and unzip; the xslt3 compiler needs roughly 1 GB of RAM.
#
# Usage: pnpm -F @xip/service build:validation
set -euo pipefail

cd "$(dirname "$0")/../.."
ARTIFACTS=validation-artifacts
MANIFEST="$ARTIFACTS/manifest.json"
OUT="$ARTIFACTS/generated"
DOWNLOADS="$OUT/downloads"
XSLT3=node_modules/.bin/xslt3

for tool in node curl unzip; do
  command -v "$tool" >/dev/null || { echo "fetch-and-compile: '$tool' is required" >&2; exit 1; }
done
[ -x "$XSLT3" ] || { echo "fetch-and-compile: $XSLT3 is missing; run pnpm install" >&2; exit 1; }

manifest() { node -p "require('./$MANIFEST').$1"; }

sha256() {
  node -e 'const c=require("node:crypto"),f=require("node:fs");
    process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$1"
}

verify() { # verify <file> <expected sha256>
  local actual
  actual="$(sha256 "$1")"
  if [ "$actual" != "$2" ]; then
    echo "fetch-and-compile: sha256 mismatch for $1" >&2
    echo "  expected $2" >&2
    echo "  actual   $actual" >&2
    exit 1
  fi
}

fetch() { # fetch <manifest id>: download fetched.<id> into its own directory and verify it
  local url sha file dir
  url="$(manifest "fetched.$1.url")"
  sha="$(manifest "fetched.$1.sha256")"
  file="$(manifest "fetched.$1.file")"
  dir="$DOWNLOADS/$1"
  mkdir -p "$dir"
  echo "Fetching $url"
  # Retries every error, also a dropped connection or a reset stream, not only timeouts and 5xx;
  # the sha256 check below still decides whether the file is the right one.
  curl --fail --silent --show-error --location --retry 3 --retry-all-errors --retry-delay 2 --output "$dir/$file" "$url"
  verify "$dir/$file" "$sha"
  echo "  sha256 ok ($sha)"
}

echo "Verifying committed artifacts against $MANIFEST"
node -e '
  const crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
  const manifest = require(path.resolve(process.argv[1]));
  let failed = 0;
  for (const [id, artifact] of Object.entries(manifest.committed)) {
    for (const [file, expected] of Object.entries(artifact.files)) {
      const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(path.dirname(process.argv[1]), file))).digest("hex");
      if (actual !== expected) { console.error(`  ${id}: sha256 mismatch for ${file}`); failed++; }
    }
    console.log(`  ${id}: ${Object.keys(artifact.files).length} file(s) ok`);
  }
  process.exit(failed ? 1 : 0);
' "$MANIFEST"

rm -rf "$OUT"
mkdir -p "$OUT"

fetch peppol
fetch schxslt2
SCHXSLT2_ENTRY="$(manifest fetched.schxslt2.entry)"
unzip -q -o "$DOWNLOADS/schxslt2/$(manifest fetched.schxslt2.file)" "$SCHXSLT2_ENTRY" -d "$DOWNLOADS/schxslt2"

CEN_XSLT="$ARTIFACTS/en16931-ubl-1.3.16/EN16931-UBL-validation.xslt"
PEPPOL_SCH="$DOWNLOADS/peppol/$(manifest fetched.peppol.file)"
PEPPOL_XSLT="$OUT/peppol-en16931-ubl.xslt"
CEN_SEF="$ARTIFACTS/$(manifest generated.cen)"
PEPPOL_SEF="$ARTIFACTS/$(manifest generated.peppol)"

echo "Compiling CEN EN 16931 XSLT to $CEN_SEF"
"$XSLT3" -t -xsl:"$CEN_XSLT" -export:"$CEN_SEF" -nogo -relocate:on

echo "Transpiling the Peppol Schematron with SchXslt2"
"$XSLT3" -xsl:"$DOWNLOADS/schxslt2/$SCHXSLT2_ENTRY" -s:"$PEPPOL_SCH" -o:"$PEPPOL_XSLT"

echo "Compiling the Peppol XSLT to $PEPPOL_SEF"
"$XSLT3" -t -xsl:"$PEPPOL_XSLT" -export:"$PEPPOL_SEF" -nogo -relocate:on

ls -l "$CEN_SEF" "$PEPPOL_SEF"
echo "build:validation done"
