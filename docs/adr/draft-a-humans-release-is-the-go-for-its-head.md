# A human's Release is the go for the head it was given at

**Status: accepted.** Amends D5 of
[ADR-draft-a-merge-request-is-released-on-a-humans-go](draft-a-merge-request-is-released-on-a-humans-go.md).

A human who answers **Release** on an implement Run's "What next?" has said the merge
request should be released. The Release Run it starts then asked "Release <MR> at <sha>,
approved by …?" again: 46 of 52 such Release Runs did, a median of a minute later. The
second question protected nothing the first had not ([AGENTS.md](../../AGENTS.md),
Invariant 1).

## Decision

**D1. A human's Release that starts a Release Run is that Run's go for one head.** It is
one of:

- a human's answer **Release** to the question of the Release Run's parent, as implement's
  "What next?";
- a human taking the **Release** offer of the Run whose merge request it is.

A human is a front door a person types into — the board, Desktop, a terminal — or chat
carrying the human's own words of that turn, as Collie reads a human elsewhere. The Release
Run reads which it was from what the host recorded: who answered its parent's question, and
who started it, which the host records only for a human. Nothing an Input or an Output says
is read, so no agent can give a go by starting a Run.

**D2. It holds while nothing it was given on is worse.** The Release Run reads the merge
request when it starts, which the human's Release itself does: its head, and who the forge
names as approving it then, however far from ready it is, since a pipeline still running
is the usual state right after a merge request opens. At D5's
readiness it takes the go without asking, records that it did, and goes on to claim and
merge, where the head is that head and every approver then still approves. A moved head or
a lost approval asks D5's go as before. Readiness already requires the pipeline green and
the forge saying it can merge, so neither can be worse than when the go was given.

**D3. Nothing else changes.** Every wait stays: the approval, the answered comments, the
Checks and pipeline at the head, the forge's mergeability, the Helle claim and the go's own
check after it. A Release Run started any other way — by `then=release`, by an agent, or by
a human's `collie run start release` — asks the go as before. The production go is asked as
before.

## Consequences

- A human's Release on an unchanged head reaches the merge with nobody asked again.
- A go is never taken over a head the human did not see: one pushed after the Release Run
  started is asked about.
- An approval given after the human's Release does not stop the go; one withdrawn does.
