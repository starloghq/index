#!/usr/bin/env bash
#
# Release gate: build → pack → smoke-test the PACKED tarball in a clean
# environment, the way a user would install it. Run this and require it green
# BEFORE `npm publish`.
#
# Uses Docker (node:20-slim, the package's minimum supported Node) for a fully
# fresh machine when available; otherwise falls back to running the smoke test
# locally (still isolated via a throwaway HOME + npm prefix).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
echo "=== verify-release: starloghq@$VERSION ==="

echo "--- version consistency (package.json <-> server.json) ---"
node scripts/check-versions.mjs

echo "--- build ---"
npm run build >/dev/null

echo "--- pack ---"
TARBALL="$(npm pack 2>/dev/null | tail -1)"
echo "packed: $TARBALL"
trap 'rm -f "$ROOT/$TARBALL"' EXIT

if docker info >/dev/null 2>&1; then
  echo "--- smoke test in Docker (node:20-slim) ---"
  docker run --rm \
    -v "$ROOT/$TARBALL:/tmp/pkg.tgz:ro" \
    -v "$ROOT/scripts/smoke-test.sh:/smoke.sh:ro" \
    -e STARLOG_TARBALL=/tmp/pkg.tgz \
    -e STARLOG_EXPECT_VERSION="$VERSION" \
    node:20-slim bash /smoke.sh
else
  echo "--- Docker unavailable; running smoke test locally (isolated HOME/prefix) ---"
  STARLOG_TARBALL="$ROOT/$TARBALL" STARLOG_EXPECT_VERSION="$VERSION" bash "$ROOT/scripts/smoke-test.sh"
fi

echo "=== verify-release PASSED for starloghq@$VERSION — safe to publish ==="
