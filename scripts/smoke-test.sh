#!/usr/bin/env bash
# Smoke test for the published `codemap-mcp` package.
#
# Steps:
#   1. Build the bundles (bun build → dist/cli/*.js).
#   2. `npm pack` to produce a tarball as it would be published.
#   3. Install the tarball into a temp prefix.
#   4. Verify both binaries on PATH:
#        - `codemap --help`     → exit 0, prints commander Usage.
#        - `codemap --version`  → exit 0, prints 0.1.0.
#        - `codemap validate`   → exit 0 in an empty repo (no graph file → clean).
#        - `codemap-mcp` accepts an MCP `initialize` JSON-RPC over stdin and
#          replies with a JSON-RPC response containing serverInfo.name=codemap.
#   5. Clean up.
#
# Designed to run cleanly in CI and locally. Requires: bun, node 22+, npm, jq.

set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v bun >/dev/null 2>&1; then
  echo "smoke-test: bun is required to build the bundle." >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "smoke-test: node is required." >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "smoke-test: jq is required to parse JSON-RPC output." >&2
  exit 2
fi

NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "smoke-test: node 22+ required, got $NODE_MAJOR." >&2
  exit 2
fi

WORKDIR=$(mktemp -d -t codemap-smoke.XXXXXX)
trap 'rm -rf "$WORKDIR"' EXIT

echo "==> Building bundles..."
bun run build

echo "==> Packing..."
TARBALL=$(npm pack --silent --pack-destination "$WORKDIR")
TARBALL_PATH="$WORKDIR/$TARBALL"
echo "    $TARBALL_PATH"

echo "==> Inspecting tarball contents..."
tar -tzf "$TARBALL_PATH" | sort > "$WORKDIR/contents.txt"
cat "$WORKDIR/contents.txt"

# Hard-fail if anything we don't want to ship slips into the tarball.
if grep -E '^package/(test|fixtures|tasks|notes|m1)/' "$WORKDIR/contents.txt" >/dev/null; then
  echo "smoke-test: tarball includes excluded directories (test/fixtures/tasks/notes/m1)." >&2
  exit 1
fi
if grep -E '^package/(V1_SPEC|TECH_SPEC|ROADMAP)\.md$' "$WORKDIR/contents.txt" >/dev/null; then
  echo "smoke-test: tarball includes spec docs (should be linked, not bundled)." >&2
  exit 1
fi
for required in package/dist/cli/codemap.js package/dist/cli/codemap-mcp.js package/README.md package/LICENSE package/package.json; do
  if ! grep -Fxq "$required" "$WORKDIR/contents.txt"; then
    echo "smoke-test: tarball missing required file: $required" >&2
    exit 1
  fi
done

echo "==> Installing into temp prefix..."
PREFIX="$WORKDIR/prefix"
mkdir -p "$PREFIX"
# `npm install -g --prefix` does a global-style install isolated to $PREFIX:
#   - bins land at $PREFIX/bin/<name> (Linux/macOS) — what we want for PATH.
#   - package files at $PREFIX/lib/node_modules/<pkg>/.
# Without `-g`, npm treats $PREFIX as a project and bins land in node_modules/.bin.
# Use --no-audit --no-fund for quiet, deterministic output.
npm install -g --silent --no-audit --no-fund --prefix "$PREFIX" "$TARBALL_PATH"

export PATH="$PREFIX/bin:$PATH"
which codemap
which codemap-mcp

echo "==> codemap --help"
codemap --help | head -5

echo "==> codemap --version"
# Read expected version from package.json so a `npm version` bump never silently
# regresses this assertion. node -p keeps the dependency footprint at zero.
EXPECTED_VERSION=$(node -p "require('./package.json').version")
VERSION_OUT=$(codemap --version)
if [ "$VERSION_OUT" != "$EXPECTED_VERSION" ]; then
  echo "smoke-test: expected version $EXPECTED_VERSION, got '$VERSION_OUT'" >&2
  exit 1
fi
echo "    $VERSION_OUT"

echo "==> codemap validate (empty repo)"
EMPTY_REPO="$WORKDIR/empty-repo"
mkdir -p "$EMPTY_REPO"
codemap --repo "$EMPTY_REPO" validate

echo "==> codemap-mcp initialize handshake"
# MCP stdio = newline-delimited JSON. Send initialize, then close stdin.
# Server responds with a single JSON-RPC line on stdout. timeout caps to 5s.
INIT_REQ='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1.0.0"}}}'
RESPONSE=$(printf '%s\n' "$INIT_REQ" | timeout 5 codemap-mcp 2>/dev/null | head -1 || true)
if [ -z "$RESPONSE" ]; then
  echo "smoke-test: codemap-mcp produced no response to initialize." >&2
  exit 1
fi
SERVER_NAME=$(printf '%s' "$RESPONSE" | jq -r '.result.serverInfo.name // empty')
if [ "$SERVER_NAME" != "codemap" ]; then
  echo "smoke-test: initialize response did not identify as codemap. Got:" >&2
  echo "$RESPONSE" >&2
  exit 1
fi
echo "    serverInfo.name=$SERVER_NAME"

echo "==> All smoke checks passed."
