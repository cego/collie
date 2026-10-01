# A repository's checks are remembered by a human

A Run's [approved set](../../CONTEXT.md) came from `.collie/verify.json` in the project, else
the user's one global `~/.collie/user/verify.json`. Few repositories carry a `.collie/` file,
and one global list cannot fit a monorepo and a small package at once, so most Runs parked at
their start and had the same checks granted one at a time, Run after Run, in the same
repository.

## Decision

Between the project's file and the user's, the approved set is read from a file per
repository in the user's own config, keyed by the checkout's remote:
`~/.collie/user/verify/<host>/<path>.json`. The first file found still wins whole; nothing
merges layers. Only `collie run intent remember <run-id> [--replace]`, which a human runs,
writes it: it saves a Run's current grant as its repository's own. No agent, workflow or
host writes there, and chat is told never to run the command. It is a CLI command only for
now: the board's offer to remember a Run's checks is a later step, and will call the same code
on a human's click.

## Consequences

A remembered set is a standing permission: it applies to every later Run in that repository
until the file is edited or deleted, which is how it is changed or withdrawn. Two checkouts
sharing a remote share it, and a checkout whose remote names another repository is given that
repository's set. A checkout with no remote has no remembered set, and a remote whose path
would leave `verify/` is never read or written.
