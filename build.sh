#!/usr/bin/env bash
# Build ai_trader.html from src/ files
# Usage: ./build.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/src"
OUT="$SCRIPT_DIR/ai_trader.html"

# Verify source files exist
for f in template.html styles.css body.html trader.js; do
    if [[ ! -f "$SRC/$f" ]]; then
        echo "ERROR: $SRC/$f not found" >&2
        exit 1
    fi
done

# Build using awk for reliable multi-line replacement
awk '
    /<!-- STYLES -->/ {
        while ((getline line < STYLES) > 0) print line
        close(STYLES)
        next
    }
    /<!-- BODY -->/ {
        while ((getline line < BODY) > 0) print line
        close(BODY)
        next
    }
    /<!-- SCRIPT -->/ {
        while ((getline line < SCRIPT) > 0) print line
        close(SCRIPT)
        next
    }
    { print }
' STYLES="$SRC/styles.css" BODY="$SRC/body.html" SCRIPT="$SRC/trader.js" "$SRC/template.html" > "$OUT"

echo "Built: $OUT"
