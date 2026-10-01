# A repository's checks are remembered by its remote

A Run's [approved set](../../CONTEXT.md) came from `.collie/verify.json` in the project, else
the user's one global `~/.collie/user/verify.json`. Few repositories carry a `.collie/` file,
and one global list cannot fit a monorepo and a small package at once, so most Runs parked at
their start and had the same checks granted one at a time, Run after Run, in the same
repository.

## Decision

Between the project's file and the user's, the approved set is read from a file per
repository in the user's own config, keyed by the checkout's remote:
`~/.collie/user/verify/<host>/<path>.json`. The first file found still wins whole; nothing
merges layers. It is written by remembering a Run's current grant as its repository's own:
`collie run intent remember <run-id> [--replace]`, or chat's `remember_verification`, which
carries out the same code. Whoever can grant a Run its checks can keep them for the
repository; nothing about that is the human's alone.

## Consequences

A remembered set is a standing permission: it applies to every later Run in that repository
until it is remembered again with `--replace`, or the file is edited or deleted. Two
checkouts sharing a remote share it, and a checkout whose remote names another repository is
given that repository's set. A checkout with no remote has no remembered set, and a remote
whose path would leave `verify/` is never read or written. What a remembered check ran is in
each later Run's merge request, where it is read before it lands.
