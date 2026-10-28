# A Run never asks to run its checks

**Status: accepted, to be built.** Supersedes [ADR-0010](0010-a-run-proves-its-outcome.md)
D2's "a permission" and the Consequences paragraphs about a project with no
`.collie/verify.json` and the gate asking before it collects, and
[ADR-0023](0023-a-rally-is-a-loop-and-a-claim-is-not-proof.md) D6. Amends
[ADR-0035](0035-a-repositorys-checks-are-remembered-by-its-remote.md) and extends
[ADR-0011's 2026-09-29 amendment](0011-the-conversation-is-a-native-harness.md) from chat
to the Run's own agent.

A Run's **checks** are the commands Collie runs itself to prove it. Nobody approves them.
Where nothing written down names any, the Run's own agent names them, and Collie records
them and runs them without asking.

## What was true before

The checks were a permission. They came from `--verify` with the start, else
`.collie/verify.json`, else the checks remembered for the checkout's remote, else the
user's `verify.json`. Where none of those had any, a start of a workflow that declares
`verifies` was refused. A Run that got past that with an empty set parked at its evidence
gate with "nothing is approved for Collie to run, so no command can prove this Run". It
stayed parked until someone granted a check with `collie run intent verification` or
chat's `set_verification`, or pressed **Approve** on the board's offered list.

The permission protected nothing. Chat could already grant any check with no yes, and the
merge request already listed every check with its command, "a model may have chosen
them" (ADR-0011, 2026-09-29). The Run's own agent could already call
`collie run intent verification`. So a parked gate was ceremony, the kind
[AGENTS.md](../../AGENTS.md) invariant 1 calls a defect. It stopped
`mk-laptop:run-56fff4ed.implement` until a human typed a command that an agent could
have run.

## Decision

**D1. Where a Run's checks come from.** (Amended by
[ADR-draft-a-runs-checks-are-read-where-its-checkout-starts](draft-a-runs-checks-are-read-where-its-checkout-starts.md):
the project's file is read at the Run's base, not from the checkout it was started in.)
The order and the files are unchanged: `--verify`
(chat's `start.verify`), else `.collie/verify.json`, else the checks remembered for the
remote, else `~/.collie/user/verify.json`. The first one found is taken whole. When none
of them has any, the Run's own agent names them. `implement`'s builder does this first,
before it changes anything, from what the repository says proves its work: the
`package.json` scripts such as `check`, `test` and `typecheck`, a Makefile, the CI
config, each run in the directory it belongs to. It names each one with
`collie run intent verification <run> --name <name> [--cwd <dir>] -- <command>`. That is
the same host grant and Intent amendment a human or chat uses, and it is recorded as the
agent (ADR-0039).

**D2. No start is refused, and nothing waits for a check to be allowed.** `requireApproved`,
its park and the `verifies` declaration are removed. The gate reads the Run's checks at
every pass. If there are still none, that is a gap the implementer can close, and the
first gate fix is asked to name them. If the fixes run out and there are still none, the
Run is held the way a Run is held when a check still fails after its fixes
([ADR-0023, 2026-10-09](0023-a-rally-is-a-loop-and-a-claim-is-not-proof.md)). It suspends
with the gap named, and once a check is named, a resume proves it again. That is not
approval. Nobody is asked to allow a check, the agent was asked to name one at the build
and at every gate fix, and the Run is held for an outcome it could not prove.

**D3. The board's evidence gate is gone.** The `gate` Decision is removed: `Approve`,
`approve:<name>`, the cut list in the TUI drawer and on Desktop's card, `evidence-gate`
as an answer, and chat's instructions for it. A Decision is a question or a Proposal.
Removing a Decision kind is a removal from the board protocol, so `PROTOCOL` is bumped
(ADR-0038).

**D4. What stays.** These all stay, with their wording changed from grant to naming:

- `run intent verification` and `set_verification` are how anyone adds a check to a live
  Run or withdraws one.
- `run intent remember` and `remember_verification` keep a Run's checks, whoever named
  them, for its repository's later Runs.
- The Intent's `run_verification` and the host's `approved.json` are where a Run's checks
  are kept.

Code identifiers named `approved` keep their names. Renaming them would change no
behaviour and would invalidate the files Runs already in flight keep. The glossary term
changes to **Checks**.

**D5. What a check still is.** A check is an executable and its arguments, never a shell
string. It is bound argument for argument and runs in a tree the Run owns. Its result is
a Verification collected at a revision. A check whose directory is outside the Run's tree
is now refused when it is named, so the agent hears about it at once, and the gate also
refuses it when it runs it. A file that is there and does not decode still refuses the
start, and names the file. A `--verify` list given to a plan that spans repositories is
still refused. Neither of those asks for approval: each is an input that cannot mean
anything.

## Consequences

The agent whose work is being proved chooses its own proof. It could name a check that
always passes. Two things bound that. It names its checks before it builds, which is when
"what would count" is honest. And the merge request lists every check the Run was held to
with its command, read at the merge request step rather than at the start. The human
reads that list, along with the review, before anything lands. This is the bound
ADR-0011 already accepted for chat. A repository whose checks matter should keep a
`.collie/verify.json` or remembered checks, and then the agent names none.

An agent can also withdraw a check, since it has the same route as a human. The grant
journal records who did it. Collie does not try to stop this: a rule that only stopped
agents would be a safeguard binding agents alone, and it would name no harm that a human
withdrawing the same check would not cause.

Every Run in a repository with no checks file names its checks again, and two Runs may
name different ones. Collie does not remember them by itself, because a standing set is
the human's or chat's to keep, with `remember`.

A Run that parked at the old gate before this was built is picked up with
`collie run resume`. Its stale park clears once its next agent work is sent.
