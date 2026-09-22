#!/bin/sh
# Everything that is safe to do again: link the plugin from this checkout, put the
# runner and the `collie` shim in place, and link the operator skill. `setup.sh`,
# `collie upgrade` and herdr's plugin build hook (through `install.sh`) all end
# here, so a new prerequisite is added in one place and every entry point picks it
# up at once.
#
# Keybindings are deliberately not here. Writing to a human's herdr config is not
# something a plugin rebuild may do as a side effect of being rebuilt; `setup.sh`
# owns those and nothing else touches them.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_ID="cego.collie"

# One line per step, in a shape `collie upgrade` can read back: a report has to be
# able to say which steps ran, which were already in place and which were skipped.
step() { printf 'prepare: %s: %s\n' "$1" "$2"; }

# `herdr plugin link` below fires the build hook, which is `install.sh`, which ends
# by calling this script. Exported, so that nested run sees it and stops there.
export COLLIE_PREPARING=1

# `install.sh` chains here when it is run on its own — by herdr's build hook, say —
# and the runner is then already built by the time we get here.
runner_built="${COLLIE_RUNNER_FRESH:-}"

if ! command -v herdr >/dev/null 2>&1; then
  step plugin-link "skipped — herdr is not installed; see https://herdr.dev/docs/install/"
elif herdr plugin list 2>/dev/null | grep -q "$PLUGIN_ID .*\[local:$ROOT\]"; then
  step plugin-link "already in place"
else
  herdr plugin link "$ROOT" >/dev/null
  step plugin-link "done"
  # The build hook that link just fired is what builds the runner, so building it
  # again below would be a second compile reported as a change that did not happen.
  if [ -x "$ROOT/bin/collie" ]; then runner_built=1; fi
fi

if [ -n "$runner_built" ]; then
  step runner "done"
else
  # The runner reinstalls every time — that is what makes this an upgrade path — so
  # what it reports is whether the binary it left is the one that was already there.
  before=$(cksum "$ROOT/bin/collie" 2>/dev/null || true)
  if ! out=$(sh "$ROOT/install.sh" 2>&1); then
    printf '%s\n' "$out" >&2
    step runner "failed"
    exit 1
  fi
  after=$(cksum "$ROOT/bin/collie" 2>/dev/null || true)
  if [ -n "$before" ] && [ "$before" = "$after" ]; then
    step runner "already in place"
  else
    step runner "done"
  fi
  printf '%s\n' "$out" | sed -n 's/^/  /p'
fi

# The operator skill: a link, so a `git pull` updates it without re-running anything.
# Into both stores, because the harnesses are split: claude-code reads only its own,
# and everything else — Collie's own skill lookup, pi, codex, opencode — reads the
# universal `~/.agents/skills`. A skill a harness cannot see is a skill it does not have.
SKILL_STORE="$HOME/.agents/skills"
link_operator_skill() { # skills dir -> done | already in place | skipped — …
  link="$1/collie"
  if [ "$(readlink "$link" 2>/dev/null)" = "$ROOT/skills/collie" ]; then
    echo "already in place"
  elif [ -e "$link" ]; then
    echo "skipped — $link is not ours to replace"
  elif [ -L "$link" ]; then
    # A link whose target is gone — the checkout it pointed at moved. `-e` is false
    # for it, so without this the plain `ln -s` below fails on the directory entry
    # that is still there, and `set -e` would end the run with later steps undone.
    ln -sfn "$ROOT/skills/collie" "$link"
    echo "done"
  else
    mkdir -p "$1"
    ln -s "$ROOT/skills/collie" "$link"
    echo "done"
  fi
}

# One step line for the two links: a store we may not touch is what the step reports,
# but it never costs the other store its link.
operator_skipped=""
operator_done=""
for skills_dir in "${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}" "$SKILL_STORE"; do
  state=$(link_operator_skill "$skills_dir")
  case "$state" in
    skipped*) operator_skipped="$state" ;;
    done) operator_done=1 ;;
  esac
done
if [ -n "$operator_skipped" ]; then
  step operator-skill "$operator_skipped"
elif [ -n "$operator_done" ]; then
  step operator-skill "done"
else
  step operator-skill "already in place"
fi

# The skills the baseline workflows require. They come from the skills.sh CLI, which
# is not vendored and not wrapped: the sources are pinned here, the versions float —
# every run takes the latest upstream state (ADR 0005). The bucket is addressed by
# path, so a skill added upstream inside those directories arrives on the next run
# where a list of names would stop at what we knew about.
#
# `universal` is the standard `~/.agents/skills` store, which is the first place
# Collie's own skill lookup already looks; `claude-code` is named as well because it
# is the one harness that does not read that store. pi, codex and opencode do, so
# they get no special handling.
# The CLI itself is pinned, where the skills it installs are not. That is not the
# same decision twice: ADR 0005 is about skill *contents*, which an agent reads, and
# this is an executable that runs unattended with your shell's privileges on every
# install, upgrade and plugin build. `@latest` would run whatever was published this
# morning. Bumping this line is a deliberate act, and a small visible diff.
SKILLS_CLI="skills@1.5.23"
SKILL_SOURCES="https://github.com/mattpocock/skills/tree/main/skills/engineering
https://github.com/mattpocock/skills/tree/main/skills/productivity
https://github.com/addyosmani/agent-skills"
# What this machine was given and what it has: the sources, and a checksum of every
# file in the store. It answers both questions this step has to ask — whether there is
# anything to add (a source added here, or a skill deleted by hand), and afterwards
# whether anything actually changed, which is what the step reports.
SKILL_STAMP="$HOME/.agents/.collie-sources"
stamp_now() {
  mkdir -p "$(dirname "$SKILL_STAMP")"
  skills_here >"$SKILL_STAMP"
}

skills_here() {
  printf '%s\n' "$SKILL_SOURCES"
  # `-exec … +` rather than a pipe into xargs: it runs nothing at all when the store
  # is empty, where `xargs cksum` would sit waiting on stdin.
  find "$SKILL_STORE" -type f -exec cksum {} + 2>/dev/null | sort
}

# What a failed skills step says: the CLI's last words, and then the one line naming
# what did not happen and how to try it again.
skills_skipped() { # output, what went wrong
  printf '%s\n' "$1" | tail -3 >&2
  step skills "skipped — $2; run \`collie upgrade\` to try again"
}

# Non-fatal on purpose: this step needs the network and a Node runtime, and neither
# is a reason to leave a machine without a runner. What it cannot do, it says.
skills_step() {
  if ! command -v npx >/dev/null 2>&1; then
    step skills "skipped — no npx on PATH; install Node, then run \`collie upgrade\`"
    return 0
  fi
  before=$(skills_here)
  if [ "$(cat "$SKILL_STAMP" 2>/dev/null || true)" != "$before" ]; then
    for source in $SKILL_SOURCES; do
      if ! out=$(npx -y "$SKILLS_CLI" add "$source" -g -y --skill '*' --agent universal claude-code </dev/null 2>&1); then
        skills_skipped "$out" "could not add $source"
        return 0
      fi
    done
    # Recorded as soon as the sources are in. What happens after this — an update
    # that cannot reach something — is a thing to report, not a reason to clone all
    # three of these again on every upgrade from here on.
    stamp_now
  fi
  if ! out=$(npx -y "$SKILLS_CLI" update -g -y </dev/null 2>&1); then
    skills_skipped "$out" "could not update the skills"
    return 0
  fi
  # What is reported is what changed, decided after the update rather than before it:
  # an update that brought a new version of a skill is a run that did something, and
  # saying "already in place" would hide the only thing that happened.
  after=$(skills_here)
  stamp_now
  if [ "$before" = "$after" ]; then
    step skills "already in place"
  else
    step skills "done"
  fi
}

skills_step

# What an older Collie recorded, read into this installation once. Idempotent by Run
# identity, so every run after the first keeps nothing and says so — which is what makes
# it safe on every install, upgrade and plugin rebuild. A Run something is still working
# on is skipped and imports when that finishes; nothing here touches a run directory.
history_step() {
  if [ ! -x "$ROOT/bin/collie" ]; then
    step history "skipped — no runner to read it with"
    return 0
  fi
  if ! out=$(HERDR_PLUGIN_ROOT="$ROOT" "$ROOT/bin/collie" history import 2>&1); then
    printf '%s\n' "$out" | tail -3 >&2
    step history "skipped — the import did not run; run \`collie history import\` to see why"
    return 0
  fi
  step history "$(printf '%s' "$out" | head -1)"
  # Only the lines a human can act on: a record nobody can decode, and one still owned.
  printf '%s\n' "$out" | sed -n '2,$p' | sed -n 's/^/  /p'
}

history_step
