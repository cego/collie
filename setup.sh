#!/bin/sh
# One-shot install for a teammate: link the plugin, add keybindings, reload herdr.
# Safe to re-run; every step skips what is already in place.
set -eu

REPO_URL="${COLLIE_REPO:-git@gitlab.cego.dk:mk/collie.git}"
PLUGIN_ID="cego.collie"
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

# The operator skill: a link, so a `git pull` updates it without re-running anything.
SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
SKILL_LINK="$SKILLS_DIR/collie"
if [ "$(readlink "$SKILL_LINK" 2>/dev/null)" = "$ROOT/skills/collie" ]; then
  say "Collie skill already linked"
elif [ -e "$SKILL_LINK" ]; then
  say "Leaving $SKILL_LINK alone; it is not ours to replace"
elif [ -L "$SKILL_LINK" ]; then
  # A link whose target is gone — the checkout it pointed at moved. `-e` is false for
  # it, so without this the plain `ln -s` below fails on the directory entry that is
  # still there, and `set -e` would end the setup with the keybindings undone.
  say "Repointing the stale Collie skill link at $ROOT"
  ln -sfn "$ROOT/skills/collie" "$SKILL_LINK"
else
  say "Linking the Collie skill into $SKILLS_DIR"
  mkdir -p "$SKILLS_DIR"
  ln -s "$ROOT/skills/collie" "$SKILL_LINK"
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

say "Done."
say "Inside herdr: prefix+f picks a workflow, prefix+u resumes, prefix+shift+f forks."
say "Outside it, the collie skill lets an agent drive runs from the CLI."
say "The first run in a workspace opens a '🐕 Collie' tab as its first tab (prefix+1):"
say "live agents, running and finished runs, and every menu a workflow asks you to answer."
