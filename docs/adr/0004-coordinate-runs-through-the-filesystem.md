# Coordinate Runs through the filesystem

Collie keeps local Run state on the filesystem: one Driver owns each Run's authoritative
snapshot and consumes Schema-validated commands from an atomic per-Run inbox watched through
Effect's `FileSystem.watch`. This fits the same-user, local-only workload and existing audit
files while avoiding a daemon, socket protocol, SQLite schema, and migrations; file events
only trigger a reread of authoritative state, and request IDs make mutations safe to retry.
