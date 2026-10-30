# 0001 — Runner is a Bun-compiled binary fetched from a release

Amended by [ADR-draft-collie-runs-its-agents-in-herdr-core](draft-collie-runs-its-agents-in-herdr-core.md): Collie's signed release carries the `hc` it is verified against.

**Status:** accepted, 2026-08-27. Amended by [ADR-draft-an-installation-is-the-release-its-runner-carries](draft-an-installation-is-the-release-its-runner-carries.md): an install is no longer a clone, and the runner carries the shipped definitions and writes them out.

## Context

The plugin needs an executable behind each herdr action. Teammates install via `git clone && herdr plugin link`; the plugin must work without them installing a runtime. Bash+jq makes JSON socket work and frontmatter parsing painful.

## Decision

Write the runner in TypeScript, compile with `bun build --compile` per platform in CI on tag, and have the manifest's `[[build]]` step (`install.sh`) download the matching binary from the GitHub release (GitLab until 2026-09-18, when the repository moved). Workflow and persona definitions stay plain files in the repo and never require a rebuild.

## Alternatives

- Commit binaries to git: instant install, ~300 MB repo growth per release.
- Build at install: puts bun back on every consumer machine.
- Bash runner: no runtime, but brittle JSON handling.

## Consequences

Releases need a tag + CI job; install needs network. Editing workflows stays a text edit.
