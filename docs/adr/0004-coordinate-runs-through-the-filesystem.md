# Coordinate Runs through the filesystem

[ADR-0029](0029-one-host-acts-for-a-run-and-a-workflows-name-decides-nothing.md) supersedes the per-Run Driver, its inbox and
the refusal of a daemon and SQLite: one host owns a state directory and keeps its Runs in
SQLite. Reports, prompts, Outputs and evidence are still files.

Collie keeps local Run state on the filesystem: one Driver owns each Run's authoritative
snapshot and consumes Schema-validated commands from an atomic per-Run inbox watched through
Effect's `FileSystem.watch`. This fits the same-user, local-only workload and existing audit
files while avoiding a daemon, socket protocol, SQLite schema, and migrations; file events
only trigger a reread of authoritative state, and request IDs make mutations safe to retry.
