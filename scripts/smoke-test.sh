#!/usr/bin/env bash
#
# Starlog release smoke test — verifies a *packaged* build installs and works
# end-to-end exactly as a user would experience it: global install, CLI, MCP
# handshake, init/dry-run/uninstall.
#
# Safe to run ANYWHERE (local, CI, Docker): it installs into a throwaway HOME
# and a throwaway npm prefix, so it never touches your real ~/.claude or your
# real global node_modules.
#
# Install source (pick one via env; defaults to the published registry):
#   STARLOG_TARBALL=/path/to/starloghq-x.y.z.tgz   # preferred: test the packed build BEFORE publish
#   STARLOG_VERSION=0.1.1                           # test a specific published version
#   (neither set)                                   # installs `starloghq` latest from the registry
#
# Optional:
#   STARLOG_EXPECT_VERSION=0.1.1   # assert `starlog --version` matches
#
# Exits non-zero if any check fails — suitable as a release gate.

set -u

PASS=0
FAIL=0
check() {
  # check "<description>" <condition-exit-code>
  if [ "$2" -eq 0 ]; then
    echo "  [PASS] $1"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] $1"
    FAIL=$((FAIL + 1))
  fi
}

# ── Isolated environment ─────────────────────────────────────────────────
WORK="$(mktemp -d "${TMPDIR:-/tmp}/starlog-smoke.XXXXXX")"
export HOME="$WORK/home"
export npm_config_prefix="$WORK/npm-global"
export npm_config_userconfig="$WORK/.npmrc"   # ignore any real ~/.npmrc (and its tokens)
export STARLOG_NO_UPDATE_CHECK=1              # keep doctor's version check off the network in the gate
mkdir -p "$HOME" "$npm_config_prefix"
: > "$npm_config_userconfig"
export PATH="$npm_config_prefix/bin:$PATH"
PROJECT="$WORK/project"
mkdir -p "$PROJECT"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

echo "=== Starlog smoke test ==="
echo "node $(node --version) | npm $(npm --version)"
echo "isolated HOME=$HOME"
echo "isolated npm prefix=$npm_config_prefix"

# ── Install ──────────────────────────────────────────────────────────────
if [ -n "${STARLOG_TARBALL:-}" ]; then
  echo "--- installing from tarball: $STARLOG_TARBALL ---"
  npm install -g "$STARLOG_TARBALL" >/dev/null 2>&1
elif [ -n "${STARLOG_VERSION:-}" ]; then
  echo "--- installing starloghq@$STARLOG_VERSION from registry ---"
  npm install -g "starloghq@$STARLOG_VERSION" >/dev/null 2>&1
else
  echo "--- installing starloghq (latest) from registry ---"
  npm install -g starloghq >/dev/null 2>&1
fi
check "global install succeeds" $?

# ── Checks ───────────────────────────────────────────────────────────────
command -v starlog >/dev/null 2>&1; check "starlog binary is on PATH" $?

# The package is named `starloghq` but the primary bin is `starlog`. Without a
# matching `starloghq` bin, `npx starloghq ...` (the README's quick-start) can't
# resolve an executable and errors out -- so `npx starloghq init` never runs.
# This alias is what makes the npx flow work; assert it's linked.
command -v starloghq >/dev/null 2>&1; check "starloghq binary is on PATH (npx <pkg> resolution)" $?

VER="$(starlog --version 2>/dev/null)"
echo "  (reported version: ${VER:-<none>})"
if [ -n "${STARLOG_EXPECT_VERSION:-}" ]; then
  [ "$VER" = "$STARLOG_EXPECT_VERSION" ]
  check "version == $STARLOG_EXPECT_VERSION" $?
fi

GROOT="$(npm root -g 2>/dev/null)"
{ [ -d "$GROOT/starloghq/node_modules/@anthropic-ai/sdk" ] || [ -d "$GROOT/@anthropic-ai/sdk" ]; }
check "runtime dependency @anthropic-ai/sdk is installed (L12)" $?

starlog search "auth for Next.js SaaS" --top-k 2 2>/dev/null | grep -qi "clerk\|auth"
check "search returns auth results (keyword fallback)" $?

starlog search "background jobs for node" --top-k 1 --format json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);process.exit(Array.isArray(a)&&a.length>0?0:1)})'
check "search --format json emits valid non-empty JSON" $?

starlog facts ua-parser-js 2>/dev/null | grep -qi "INCIDENT:ua-parser-js-2021"
check "facts returns the verified incident record for a known package" $?

starlog facts no-such-pkg-xyz 2>/dev/null | grep -qi "no facts on file"
check "facts gives an honest miss for an unknown package" $?

DOC_PRE="$(starlog doctor 2>&1)"; DOC_PRE_RC=$?
{ [ $DOC_PRE_RC -eq 0 ] && echo "$DOC_PRE" | grep -qi "not configured"; }
check "doctor (pre-init) runs and reports unconfigured" $?

# Dry-run must write nothing.
( cd "$PROJECT" && starlog init --dry-run -y >/dev/null 2>&1 )
[ ! -f "$HOME/.claude/settings.json" ]
check "init --dry-run writes nothing" $?

# Apply.
( cd "$PROJECT" && starlog init -y >/dev/null 2>&1 )
check "init applies cleanly" $?
{ [ -f "$HOME/.claude/settings.json" ] && grep -q '"starlog"' "$HOME/.claude/settings.json"; }
check "settings.json gains the starlog MCP server" $?
ls "$HOME"/.claude/hooks/*.js >/dev/null 2>&1
check "PostToolUse hook script is written" $?

# The hook is a thin shim that loads the package's dist/hook-runner.js at runtime,
# so `npm update` refreshes hook behaviour with no re-init. Prove it actually
# resolves that module and surfaces facts from a REAL global install — not just
# that the shim file exists. event-stream carries a known L2 incident record.
HOOK_JS="$HOME/.claude/hooks/starlog-pkg-check.js"
HOOK_OUT="$(printf '%s' "{\"tool_input\":{\"command\":\"npm install event-stream\"},\"cwd\":\"$PROJECT\"}" | node "$HOOK_JS" 2>/dev/null)"
echo "$HOOK_OUT" | grep -q 'event-stream'
check "PostToolUse hook resolves its logic module and surfaces facts (zero-touch upgrade path)" $?

starlog doctor 2>&1 | grep -qi "starlog_search available"
check "doctor (post-init) confirms MCP handshake" $?

# --api-key wires the hosted key into the MCP server's own env block (the server
# doesn't inherit the user's shell, so this is the only way the agent gets it).
( cd "$PROJECT" && starlog init --api-key smoke-test-key -y >/dev/null 2>&1 )
grep -q 'smoke-test-key' "$HOME/.claude/settings.json"
check "init --api-key wires STARLOG_API_KEY into the MCP server env" $?

# Regression: the MCP server must start even when invoked through a symlinked
# path. The run-if-main guard once string-compared argv[1] (as-invoked) against
# a realpath-resolved import.meta.url, so any symlinked path (macOS
# /tmp -> /private/tmp, some nvm/Homebrew layouts, npx caches) made the server
# silently never start. Docker's /tmp is NOT symlinked, so only an explicit
# symlink reproduces it -- which is exactly why earlier gates missed it.
MCP_JS="$(npm root -g)/starloghq/dist/mcp.js"
LINK="$WORK/linked-pkg"
ln -s "$(dirname "$(dirname "$MCP_JS")")" "$LINK"
INIT_REQ='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
{ printf '%s\n' "$INIT_REQ"; sleep 1; } | node "$LINK/dist/mcp.js" 2>/dev/null | grep -q '"serverInfo"'
check "MCP server starts through a symlinked path (run-if-main guard)" $?

# Uninstall must remove the MCP server entry.
( cd "$PROJECT" && starlog init --uninstall -y >/dev/null 2>&1 )
check "uninstall runs cleanly" $?
{ [ -f "$HOME/.claude/settings.json" ] && ! grep -q '"starlog"' "$HOME/.claude/settings.json"; }
check "uninstall removes the starlog MCP server" $?

# ── Summary ──────────────────────────────────────────────────────────────
echo "=== $PASS passed, $FAIL failed ==="
echo "(Not covered: the keyed --context LLM enrichment path — needs an API key.)"
[ "$FAIL" -eq 0 ]
