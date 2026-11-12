#!/usr/bin/env bash
# Build-time compilation of the validation artifacts to SaxonJS SEF files.
# usage: build-sef.sh <cen-ubl-1.3.16 xslt> <peppol PEPPOL-EN16931-UBL.sch> <schxslt2 transpile.xsl> <outdir>
set -euo pipefail
CEN_XSLT=$1; PEPPOL_SCH=$2; SCHXSLT2=$3; OUT=$4
XSLT3="$(dirname "$0")/node_modules/.bin/xslt3"
mkdir -p "$OUT"

# 1) CEN EN16931 UBL: official precompiled XSLT -> SEF (no Schematron step needed)
"$XSLT3" -t -xsl:"$CEN_XSLT" -export:"$OUT/cen-en16931-ubl.sef.json" -nogo -relocate:on

# 2) Peppol BIS 3: only .sch is published -> transpile with SchXslt2 (XSLT 3.0, runs on SaxonJS), then -> SEF
"$XSLT3" -xsl:"$SCHXSLT2" -s:"$PEPPOL_SCH" -o:"$OUT/peppol-en16931-ubl.xslt"
"$XSLT3" -t -xsl:"$OUT/peppol-en16931-ubl.xslt" -export:"$OUT/peppol-en16931-ubl.sef.json" -nogo -relocate:on

ls -la "$OUT"
