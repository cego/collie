#!/bin/sh
# The compiled-binary release gate from docs/SPEC.md: the binary starts, answers one
# command in JSON, and reports one typed failure. Run against bin/collie, so a broken
# entrypoint or envelope cannot ship even though `bun test` runs the sources.
set -eu

BIN="${1:-bin/collie}"
[ -x "$BIN" ] || { echo "smoke: no executable at $BIN" >&2; exit 1; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export HERDR_PLUGIN_ROOT="$ROOT"
# Nothing here may touch the real state dir or a live herdr.
STATE=$(mktemp -d)
trap 'rm -rf "$STATE"' EXIT
export HERDR_PLUGIN_STATE_DIR="$STATE/state"
export HERDR_PLUGIN_CONFIG_DIR="$STATE/config"
# Run as a release consumer would: no herdr, and none of the context a shell inside
# herdr exports, or the workspace-scoped commands would try to resolve a live one.
export HERDR_BIN_PATH="$STATE/no-herdr"
unset HERDR_WORKSPACE_ID HERDR_ACTIVE_WORKSPACE_ID HERDR_PLUGIN_CONTEXT_JSON \
  HERDR_SOCKET_PATH HERDR_TAB_ID HERDR_ACTIVE_TAB_ID HERDR_PANE_ID HERDR_ACTIVE_PANE_ID

fail() { echo "smoke: $1" >&2; exit 1; }

"$BIN" --help >/dev/null 2>&1 || fail "--help exited nonzero"

out=$("$BIN" --json workflow list) || fail "workflow list exited nonzero"
echo "$out" | head -1 | grep -q '^{"ok":true' || fail "workflow list is not a success envelope: $out"
[ "$(echo "$out" | wc -l)" = "1" ] || fail "workflow list wrote more than one line"

set +e
out=$("$BIN" --json run show no-such-run 2>/dev/null); status=$?
set -e
[ "$status" = "1" ] || fail "a missing run exited $status, wanted 1"
echo "$out" | grep -q '"code":"run_not_found"' || fail "a missing run is not typed: $out"

set +e
out=$("$BIN" --json workflow show 2>/dev/null); status=$?
set -e
[ "$status" = "2" ] || fail "invalid input exited $status, wanted 2"
echo "$out" | head -1 | grep -q '^{"ok":false' || fail "invalid input is not one envelope: $out"

echo "smoke: $BIN answered --help, one JSON success and two typed failures"
