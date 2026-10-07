# A check Collie runs is seen while it runs

**Status: accepted.**

While Collie runs one of a Run's approved checks, the card and chat say which check, which
pass and why, how long it has run against how long it usually takes, and the human can
open its output as it is written.

## What was true before

On 2026-10-01 run-a35622c3's card said `Running the test check, round 1` for an hour. In
that hour the host ran the full suite three times back to back: on the branch, where the
branch left the default branch, and once more on the same tree to rule out a flake. Each
took about 20 minutes, with four Runs' suites running at once at a load of about 38 on 16
cores.

Nothing said which of the three it was, why it was running, how long it had been going or
what it was printing. The `verifying` marker in the Run directory holds only the check's
name. `round 1` came from the last agent operation, not from the check. The host runs the
command with no pane and keeps only the last 4 KiB of each stream, after it ends.

## Decision

**D1. A check is run with its pass, and the pass is a declaration.** A Workflow says why it
asks for a check: the `gate` pass on the branch, a `recheck` on the same tree for a flake,
or a `fix` pass after gate fix N. A check at the default branch's base is the `baseline`
pass, because that is what running it there means. The finish's own checks are the
`finish` pass. A check asked for with no pass is a plain `check`. Collie never infers a pass
from a Workflow's id ([ADR-0029](0029-one-host-acts-for-a-run-and-a-workflows-name-decides-nothing.md)).

**D2. The marker says what is running.** While a check runs, the Run's `verifying` marker
records its name, pass, round, the revision it runs at, when it started and where its
output is being written. A marker in the old one-line shape still reads, as a name alone.
The Verification record keeps the pass and the output's path once it ends.

**D3. Output goes to a file as it arrives, not to a pane.** Both streams are appended to a
log in the Run's evidence directory while the command runs, bounded in size with the cut
said in the file. The check stays where it is: run by the host, outside any agent's
permission rules, with its exit and fingerprints taken by Collie. A pane would put a
terminal between Collie and the command it has to record exactly. Opening the output is
following that file: `collie run checks <run> --follow`, which the board opens in a pane of
the Task's workspace.

**D4. "Usually" is what it took before.** A check's usual time is the median of the last
five completed runs of the same command, name and arguments, in the same repository,
from this host's evidence journals. With none recorded there is no estimate, and the card
says only how long it has run.

**D5. One reading for every door.** The card's sentence, the drawer, `collie_run`,
`collie_herd` and `collie run checks` all read the marker and the journal through one
function. The sentence names the check and the pass in words, never the last operation's
round. It also says how many other checks this host is running when there are any, because
that is the usual reason one is slow.

## Consequences

- A long gate reads as what it is: `Running test again on the same tree to rule out a
  flake, 12 min of a usual 20.`
- A check's full output survives it, up to the bound, so a red gate can be read after the
  fact rather than from a 4 KiB tail.
- Limiting how many checks the host runs at once is a separate decision. This one only
  makes the contention visible.
