# ADR-0031: What Collie provides in a project lives under `.collie/`

Status: accepted

## Context

A project's Collie files lived under `.herdr/`: its workflow modules in `.herdr/workflows`,
its personas in `.herdr/personas` and the verifications a Run may be granted in
`.herdr/verify.json`. `.herdr/` is herdr's. Collie runs as a herdr plugin, but those files
configure Collie's own features, and keeping them there made a project's Collie
configuration read as herdr's.

## Decision

**A file that configures something Collie provides lives in the project's `.collie/`:**
`.collie/workflows`, `.collie/personas` and `.collie/verify.json`. What herdr provides
stays where herdr keeps it, such as its worktree directory under `~/.herdr/worktrees`.

**The cutover is hard.** Collie reads nothing from a project's `.herdr/`, and there is no
fallback to it.

## Consequences

A project that saved modules, personas or a verification list under `.herdr/` moves them to
`.collie/` before Collie sees them again.
