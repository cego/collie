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

# envelope WHAT WANTED-STATUS PATTERN ARGS...: one line of JSON on stdout, that
# status, and that pattern in it. `set -e` is off around the run so a command that is
# meant to fail can be checked rather than ending the script.
envelope() {
  what=$1 wanted=$2 pattern=$3
  shift 3
  set +e
  out=$("$BIN" --json "$@" 2>/dev/null)
  status=$?
  set -e
  [ "$status" = "$wanted" ] || fail "$what exited $status, wanted $wanted"
  [ "$(echo "$out" | wc -l)" = "1" ] || fail "$what wrote more than one line: $out"
  echo "$out" | grep -q "$pattern" || fail "$what does not match $pattern: $out"
}

"$BIN" --help >/dev/null 2>&1 || fail "--help exited nonzero"
envelope "workflow list" 0 '^{"ok":true' workflow list
envelope "a missing run" 1 '"code":"run_not_found"' run show no-such-run
envelope "invalid input" 2 '^{"ok":false' workflow show

# The compaction controls a launch installs into an agent's own directory are generated
# from Collie's own source, and a harness's status line and hooks are pointed back at
# this binary. A release that lost either would only fail at the next agent launch, in
# someone else's session — so the binary is asked to be that helper here.
grep -q "collie-compact" "$BIN" || fail "the binary does not carry its bundled compaction controls"
CONTROLS="$STATE/controls"
mkdir -p "$CONTROLS"
line=$(echo '{"session_id":"smoke","context_window":{"total_input_tokens":9,"total_output_tokens":1,"used_percentage":3,"current_usage":{"input_tokens":9}}}' \
  | "$BIN" herdr compaction "$CONTROLS" 2>/dev/null) || fail "the compaction helper exited nonzero"
[ "$line" = "context: 3%" ] || fail "the compaction helper printed \"$line\", not the status line"
grep -q '"kind":"usage","tokens":10' "$CONTROLS/events.jsonl" ||
  fail "the compaction helper did not record the sample it was given"

echo "smoke: $BIN answered --help, one JSON success and two typed failures, and served its own compaction helper"
