# A Run about a merge request works on its branch

**Status: proposed.** Extends the branch order in [`docs/cli.md`](../cli.md#start-a-run).

## What was true before

A mutating Run took a merge request's source branch only when it fixed a review of that
merge request, or was given a `branch:` target. A Run started with "fix merge request X"
in its own words got a fresh `<login>/<slug>` branch. Its builder pushed to the real source
branch by hand, and the mr step, which looks up the merge request of the Run's own branch,
found none to update: it opened a wrong one or failed.

## Decision

**D1. A work source someone said that names one open merge request of this checkout's
project puts the Run on that merge request's source branch.** It comes right after the
reviewed branch in the order, and `--input branch=` still beats it. The branch is cut from
its remote tip, as a review fix's is.

**D2. Naming one is either the whole text being one reference, or prose holding exactly
one merge or pull request URL.** A bare `!42` or `#30` inside prose is not read: `#1` and
issue numbers make it a guess. A URL is read whole, word by word, never found inside a longer
one: `…/pull/30.json` or `docs.example.com/github.com/…/pull/30` names no merge request, and a
word holding two URLs is two.

**D3. A merged, closed or other project's merge request, or two of them, is context and not a
target**, so the Run gets a fresh branch as before. One of this project that the forge
will not describe, that names no source branch or that comes from a fork is refused: a
fresh branch there is the failure this ADR exists to end.

## Consequences

- The mr step needs no change: on the source branch, the forge's open merge request for
  the branch is the one the Run was about, and it is updated.
- Prose that cites an open merge request of the same repository only as an example puts
  the Run on that branch. The checkout note names the branch and that it came from the
  merge request, and `--input branch=` overrides it.
