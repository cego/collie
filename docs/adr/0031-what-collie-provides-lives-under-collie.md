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

**A person's own layer has the same shape, in `~/.collie/user/`:** `workflows/`,
`personas/` and `verify.json`, and their `config.json` beside them. It sits beside the
installation, which an upgrade fast-forwards, and the installation's git ignores it. It
used to be split between there (workflows) and herdr's plugin config directory
(personas, `verify.json`, `config.json`), so one person's Collie files had two homes.
What Collie keeps for itself — runs, the host's database, tasks — is state, and stays in
herdr's plugin state directory.

**The cutover is hard.** Collie reads nothing from a project's `.herdr/` or from herdr's
plugin config directory, and there is no fallback to either.

## Consequences

A project that saved modules, personas or a verification list under `.herdr/` moves them to
`.collie/` before Collie sees them again, and a person moves their personas, `verify.json`
and `config.json` from `$(herdr plugin config-dir cego.collie)` to `~/.collie/user/`.
