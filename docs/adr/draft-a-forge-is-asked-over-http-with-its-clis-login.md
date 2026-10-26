# A forge is asked over HTTP, with its CLI's login

**Status: accepted, to be built.** Amends [ADR-0050](0050-a-merge-request-is-its-forges.md) D1
on how an adapter reaches its forge. Its interface, its two adapters and the rule that no
prompt names a forge's CLI of its own all stand.

## What was true before

Each adapter answered the forge interface by running `gh` or `glab` once or more per
answer. Measured on 2026-10-22 against github.com, `gh api user` took about 450 ms. About
50 ms of that is the process starting, and about 110 ms is a TLS handshake that a reused
connection skips. Some answers first ran `gh auth status`, which took another 450 ms.
`job` is polled every 30 s for each check left to CI, and `details` is read by the merge
watch, so this cost repeats for as long as a Run waits. Failures came back as exit codes
and stderr text, which each adapter read in its own way.

## Decision

**D1. Collie's own calls go through the `forges` library.** Every read and write Collie
makes itself goes to the forge in-process through [`forges`](https://forges.link), from
inside the adapter. Where `forges` models the operation (issues, comments, approval, the
viewer, a CI run, a rerun), the adapter calls that operation. Where it does not (the panel's
review decision, auto-merge and mergeability, a branch's merge requests, branch protection,
deployments, jobs at the merge-base), the adapter sends the same REST or GraphQL request
through the provider's `request()` or `graphql()`. Only `src/forge/` imports `forges`.

**D2. The CLI keeps what is not Collie's own call.** These still run `gh` or `glab`:
commands an agent is told to run, a reviewer's commands and a job's log command, `clone`,
the credential helper, opening a merge request in a browser, and the doctor's checks. A
Machine therefore still needs its forge's CLI, logged in.

**D3. The token is the CLI's login.** A provider gets its token from the CLI that is logged
in to its host: `gh auth token --hostname <host>` or `glab config get token --host <host>`.
It reads the token once and keeps it for the host. `glab config get` only reads glab's
config. glab refreshes an expired OAuth token only when it builds an API client, so once
the stored `oauth2_expiry_date` has passed, Collie first runs `glab auth status`, which
builds one, refreshes the token and writes it back. This keeps a long wait unattended, as
the CLI path was. After a 401, Collie reads the token again, once, and sends the rejected
request once more. A forge that answers 401 has applied nothing, so this holds for a write
too. Collie writes no token anywhere, and adds no new login or setting. A host whose CLI
has no token answers as not ready, with the same reason as before. A GitLab host named only
in agent text is asked only if glab's config or keyring, not the environment, holds its
token. `runStatus`'s `auth status` preflight did that before, and it would otherwise
answer from `GITLAB_TOKEN` for any host.

**D4. There is no fallback to the CLI.** Each operation is answered one way. When a call
fails, it answers as unavailable, as it does today. The reason is built from the typed
error: the HTTP status, the forge's message and, for a rate limit, when it resets. A write
that times out or gets a 5xx is not sent again, because the forge may already have applied
it. A rate limit that names a wait of a minute or less is retried once by `forges` itself.
The resend after a 401 in D3 is the only resend Collie makes.

**D5. The fake forge answers over HTTP too.** `test/support/forge.ts` keeps one model of
each forge and gains an HTTP face that answers the routes the adapters request. In-process
tests give that face to the provider as its `fetch`. For a spawned host, one environment
variable points the provider factory at the face, served on a loopback port. The FakeBin
face stays for the commands D2 keeps.

## Consequences

- `forges` is pinned to an exact version. It was at 0.2.0, three weeks after its first
  release, so an upgrade is a change reviewed against the forge contract test, like any
  other change.
- The first slice moves the CI job poll and records the timing of both transports. The
  remaining operations move only if that slice shows the library answering no slower.
- Not decided here: replacing the 30 s polls with webhooks or conditional requests, and
  any forge other than GitHub and GitLab.
