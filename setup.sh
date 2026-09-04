#!/bin/sh
# One-shot install for a teammate: prepare the machine, add keybindings, reload herdr.
# The preparation itself is `prepare.sh`; what stays here is the first-time-only work:
# the checkout, the keybindings, and reloading a running herdr.
# Safe to re-run; every step skips what is already in place.
set -eu

REPO_URL="${COLLIE_REPO:-git@gitlab.cego.dk:mk/collie.git}"
PLUGIN_ID="cego.collie"
CONFIG="${HERDR_CONFIG:-$HOME/.config/herdr/config.toml}"
CHECKOUT="${COLLIE_DIR:-$HOME/.collie}"
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'setup: %s\n' "$*" >&2; exit 1; }

command -v herdr >/dev/null 2>&1 || die "herdr is not installed — see https://herdr.dev/docs/install/"
command -v git >/dev/null 2>&1 || die "git is required"

# Run from a checkout, or clone one next to the user's other tools.
if [ -f "$HERE/herdr-plugin.toml" ]; then
  ROOT="$HERE"
else
  ROOT="$CHECKOUT"
  if [ ! -d "$ROOT/.git" ]; then
    say "Cloning into $ROOT"
    git clone "$REPO_URL" "$ROOT"
  fi
fi

# Update it, wherever it came from: the documented install is a clone followed by
# this script, so re-running the same command has to be how you get newer — the
# checkout is where the workflows, personas and skills live, not just the runner.
# `--ff-only`, and a pull it cannot do is said out loud rather than being the end of
# the install: someone with work in progress here still wants the rest of this run.
if [ -d "$ROOT/.git" ]; then
  say "Updating $ROOT"
  git -C "$ROOT" pull --ff-only || say "Could not update $ROOT; installing what is there"
fi

# Everything that is safe to do again — the plugin link, the runner and the `collie`
# shim, the operator skill, the skills the workflows require — is one routine, so
# that this script, `collie upgrade` and a plugin rebuild all leave the same machine.
sh "$ROOT/prepare.sh"

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
# `prefix+c` is herdr's own `new_tab`, so the board takes the shifted one.
add_binding "prefix+shift+c" board  "Open the Control Plane"

if herdr status server 2>/dev/null | grep -q "status: running"; then
  say "Reloading herdr config"
  herdr server reload-config >/dev/null
else
  say "herdr is not running; the bindings apply on next start"
fi

say "Done."
say "Inside herdr: prefix+f picks a workflow, prefix+u resumes, prefix+shift+f forks,"
say "and prefix+shift+c opens this workspace's Control Plane."
say "Outside it, the collie skill lets an agent drive runs from the CLI."
say "The first run in a workspace opens a '🐕 Collie' tab as its first tab (prefix+1):"
say "live agents, running and finished runs, and every menu a workflow asks you to answer."

# The last word, and the exit status: either everything is ready or what is missing
# with the command that fixes each one. `exec`, so nothing here can print after it
# and finishing means verified rather than asserted.
say "Checking prerequisites"
exec "$ROOT/bin/collie" doctor
