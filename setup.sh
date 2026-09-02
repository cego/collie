#!/bin/sh
# One-shot install for a teammate: link the plugin, add keybindings, reload herdr.
# Safe to re-run; every step skips what is already in place.
set -eu

REPO_URL="${COLLIE_REPO:-git@gitlab.cego.dk:mk/collie.git}"
PLUGIN_ID="cego.collie"
OLD_PLUGIN_ID="cego.workflows"
CONFIG="${HERDR_CONFIG:-$HOME/.config/herdr/config.toml}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'setup: %s\n' "$*" >&2; exit 1; }

command -v herdr >/dev/null 2>&1 || die "herdr is not installed — see https://herdr.dev/docs/install/"
command -v git >/dev/null 2>&1 || die "git is required"

# Run from a checkout, or clone one next to the user's other tools.
if [ -f "$(dirname "$0")/herdr-plugin.toml" ]; then
  ROOT=$(cd "$(dirname "$0")" && pwd)
else
  ROOT="${COLLIE_DIR:-$HOME/.collie}"
  if [ -d "$ROOT/.git" ]; then
    say "Updating $ROOT"
    git -C "$ROOT" pull --ff-only
  else
    say "Cloning into $ROOT"
    git clone "$REPO_URL" "$ROOT"
  fi
fi

OLD_STATE="$HOME/.local/state/herdr/plugins/$OLD_PLUGIN_ID"
if herdr plugin list 2>/dev/null | grep -q "$OLD_PLUGIN_ID"; then
  say "Unlinking $OLD_PLUGIN_ID; its state is preserved at $OLD_STATE"
  herdr plugin unlink "$OLD_PLUGIN_ID"
elif [ -d "$OLD_STATE" ]; then
  say "Previous $OLD_PLUGIN_ID state is preserved at $OLD_STATE"
fi

if herdr plugin list 2>/dev/null | grep -q "$PLUGIN_ID .*\[local:$ROOT\]"; then
  say "Plugin already linked from $ROOT"
else
  say "Linking plugin"
  herdr plugin link "$ROOT"
fi

# The `collie` on PATH is `install.sh`'s to write, and `herdr plugin link` above has
# just run it. A symlink here would replace a shim that pins `HERDR_PLUGIN_ROOT` with
# one that does not, and a `collie` without that pin takes its workflows from whatever
# directory it is standing in.

# The previous plugin bound the same three keys to cego.workflows.<action>. Unlinking
# it leaves those entries behind, so every upgraded user would end up with two
# bindings per key, one of them pointing at a plugin herdr no longer has.
drop_old_bindings() {
  [ -f "$CONFIG" ] || return 0
  grep -q "command = \"$OLD_PLUGIN_ID\." "$CONFIG" || return 0
  cp "$CONFIG" "$CONFIG.collie-backup"
  say "Removing $OLD_PLUGIN_ID keybindings; previous config saved as $CONFIG.collie-backup"
  awk -v old="command = \"$OLD_PLUGIN_ID." '
    function flush() {
      if (buffering && !drop) printf "%s", block
      block = ""; drop = 0
    }
    # Each [[keys.command]] table is buffered so one naming the old plugin can be
    # dropped whole; every other line passes through untouched.
    /^\[\[keys\.command\]\]/ { flush(); buffering = 1; block = $0 "\n"; next }
    /^\[/ && buffering { flush(); buffering = 0 }
    buffering { block = block $0 "\n"; if (index($0, old)) drop = 1; next }
    { print }
    END { flush() }
  ' "$CONFIG" >"$CONFIG.collie-new" && mv "$CONFIG.collie-new" "$CONFIG"
}

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
drop_old_bindings
add_binding "prefix+f"       pick   "Run a workflow"
add_binding "prefix+u"       resume "Resume a workflow run"
add_binding "prefix+shift+f" fork   "Fork a workflow or persona"

if herdr status server 2>/dev/null | grep -q "status: running"; then
  say "Reloading herdr config"
  herdr server reload-config >/dev/null
else
  say "herdr is not running; the bindings apply on next start"
fi

say "Done."
say "Inside herdr: prefix+f picks a workflow, prefix+u resumes, prefix+shift+f forks."
say "The first run in a workspace opens a 'Control Plane' tab as its first tab (prefix+1):"
say "live agents, running and finished runs, and every menu a workflow asks you to answer."
