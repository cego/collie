#!/bin/sh
# One-shot install for a teammate: link the plugin, add keybindings, reload herdr.
# Safe to re-run; every step skips what is already in place.
set -eu

REPO_URL="${HERDR_PLUGIN_REPO:-git@gitlab.cego.dk:cego/herdr-plugin.git}"
PLUGIN_ID="cego.workflows"
CONFIG="${HERDR_CONFIG:-$HOME/.config/herdr/config.toml}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'setup: %s\n' "$*" >&2; exit 1; }

command -v herdr >/dev/null 2>&1 || die "herdr is not installed — see https://herdr.dev/docs/install/"
command -v git >/dev/null 2>&1 || die "git is required"

# Run from a checkout, or clone one next to the user's other tools.
if [ -f "$(dirname "$0")/herdr-plugin.toml" ]; then
  ROOT=$(cd "$(dirname "$0")" && pwd)
else
  ROOT="${HERDR_PLUGIN_DIR:-$HOME/.herdr-plugin}"
  if [ -d "$ROOT/.git" ]; then
    say "Updating $ROOT"
    git -C "$ROOT" pull --ff-only
  else
    say "Cloning into $ROOT"
    git clone "$REPO_URL" "$ROOT"
  fi
fi

if herdr plugin list 2>/dev/null | grep -q "$PLUGIN_ID .*\[local:$ROOT\]"; then
  say "Plugin already linked from $ROOT"
else
  say "Linking plugin"
  herdr plugin link "$ROOT"
fi

add_binding() { # key action description
  if grep -q "command = \"$PLUGIN_ID.$2\"" "$CONFIG" 2>/dev/null; then
    say "Keybinding for $2 already present"
    return
  fi
  say "Binding $1 → $2"
  cat >>"$CONFIG" <<TOML

[[keys.command]]
key = "$1"
type = "plugin_action"
command = "$PLUGIN_ID.$2"
description = "$3"
TOML
}

mkdir -p "$(dirname "$CONFIG")"
add_binding "prefix+f"       pick   "Run a workflow"
add_binding "prefix+u"       resume "Resume a workflow run"
add_binding "prefix+shift+f" fork   "Fork a workflow or persona"

if herdr status server 2>/dev/null | grep -q "status: running"; then
  say "Reloading herdr config"
  herdr server reload-config >/dev/null
else
  say "herdr is not running; the bindings apply on next start"
fi

say "Done. Inside herdr: prefix+f picks a workflow, prefix+u resumes, prefix+shift+f forks."
