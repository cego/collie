# 0001 — Runner is a Bun-compiled binary fetched from a release

**Status:** accepted, 2026-08-27

## Context
The plugin needs an executable behind each herdr action. Teammates install via `git clone && herdr plugin link`; the plugin must work without them installing a runtime. Bash+jq makes JSON socket work and frontmatter parsing painful.

## Decision
Write the runner in TypeScript, compile with `bun build --compile` per platform in CI on tag, and have the manifest's `[[build]]` step (`install.sh`) download the matching binary from the GitLab release. Workflow and persona definitions stay plain files in the repo and never require a rebuild.

## Alternatives
- Commit binaries to git: instant install, ~300 MB repo growth per release.
- Build at install: puts bun back on every consumer machine.
- Bash runner: no runtime, but brittle JSON handling.

## Consequences
Releases need a tag + CI job; install needs network. Editing workflows stays a text edit.
