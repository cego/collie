# A review follows its merge request to approval

**Status: accepted, to be planned** (run-a27c9329). Builds on
[ADR-0050](0050-a-merge-request-is-its-forges.md) (Collie acts as the human's forge login),
[ADR-0021](0021-one-host-answers-for-a-run.md) (`ask` is the decision),
[ADR-draft-a-message-on-a-humans-say-is-posted-as-that-human](draft-a-message-on-a-humans-say-is-posted-as-that-human.md)
(Slack is the human's own user token, never a bot) and
[ADR-draft-a-merge-request-is-released-on-a-humans-go](draft-a-merge-request-is-released-on-a-humans-go.md)
(the author-side loop that answers review comments and holds a go for one head).

On 2026-11-11 the human reviewed backoffice-core !481 and !482 with Collie. 12 of the 13
steps on !481 were coordination that Collie could have done. The steps were:

- adding :eyes: in Slack, twice;
- pasting links into chat;
- answering a Post menu;
- adding :memo:;
- marking the card "merged" to clear it;
- asking for a re-review by hand;
- approving in GitLab by hand;
- answering a moot "Don't post";
- adding :white_check_mark:.

On !482 the card was marked "merged" while the merge request stayed open with an unreviewed
head. The re-review got none of the earlier findings. It learned them by reading back Collie's
own note, which carried no attribution.

## Decision

**D1. A review of a merge request follows it until the merge request merges or closes.** One
Run runs the whole loop for one merge request:

1. Review the head.
2. Post the findings.
3. Wait without a live agent.
4. Review the next meaningful head again, against the earlier findings and the replies to them.
5. Ask to approve once the current head is clean.

A new head, a reply in a thread Collie posted, or a finished pipeline brings the next round,
after a quiet period. The author's own Slack message is not one of these signals. One head is
never reviewed twice.

**D2. Posting, reacting and re-reviewing need no question; approving always asks.** One shared
setting, off by default, opts the human in. While it is on, a review of a merge request does
the following without asking:

- posts its findings, attributed as Collie's on the human's behalf;
- reacts in Slack with :eyes: when it starts, :memo: when it posts findings and
  :white_check_mark: when the merge request is approved;
- re-reviews new heads.

With the setting off, today's review and its menu are unchanged.

Approval is always a question: "Approve `<mr>` at `<sha>`?". The question is asked only when
the current head has no open blocking finding and its evidence was collected at that head. It
holds for that head only. A moved head supersedes it and starts a new round. Whoever answers
is recorded (ADR-0039).

Each of these confers no authority:

- a comment, an emoji or a Slack message;
- a successful pipeline;
- a reply signed by any Collie Run, including the author's.

Approval never extends to merging, releasing or deploying. Hold and Stop end the follow-through.

**D3. While the setting is on, a merge request that requests the human as reviewer starts its
own review.** The host's existing merge-request watch notices the request. Each merge request
gets exactly one review Run. A merge request the human authored is never reviewed this way. A
pasted merge request or Slack link starts the same Run.

**D4. Collie never pushes to someone else's branch.** On someone else's merge request, posting
the findings is the improvement. The author, or the author's own Collie, fixes them, and the
review follows whatever they push. **Improve**, an agent fixing the findings and an
independent review of the fix, is offered only on the human's own merge requests and on their
Tasks' branches.

**D5. Slack reactions are the human's own, read before they are written.** The Slack sign-in
is widened in three ways:

- reactions can be written and read;
- channel history can be read, to find the message about a merge request and read its thread;
- messages can be searched, to find that message when a review starts from the merge request.

There is still no bot, no event subscription and no relay. A message that cannot be found
unambiguously gets no reaction, and the card says why. This narrows "Slack is post-only" to
"Slack is the human's own hand": the human's reactions, never a conversation with Collie.

**D6. Between rounds the host watches, not an agent.** A waiting review is a row in the host's
database, indexed by MR id, that holds the Run's cursor and a durable wake. The merge watch
already reads that MR. When its reading differs meaningfully from the cursor, it completes the
wake. A meaningful difference is one of:

- a new head;
- a comment not signed by Collie;
- a finished pipeline.

Before the next round starts, two waits apply:

- the head must stay unchanged for a quiet period;
- a running pipeline is waited for, up to a cap.

Collie's own notes never count as a change, so the loop cannot feed itself. A review never adds
forge reads of its own beyond the merge watch's.

**D7. Posting never approves silently.** A review note is signed and is posted at most once per
round; Collie reads it back by its signature before posting. Approval is a separate act, pinned
to the head it was decided at, so the forge refuses it once the head has moved. This applies to
today's menu as well: its Post says when it approves.

**D8. A maintained dispute is the human's to settle.** The reviewer may keep a finding against
the author's dispute once. After that the finding stops driving rounds and becomes a decision:
keep it, with no approval, or drop it and approve.

## Glossary

- **Follow-through**: a `review` Run, started with the opt-in on, that owns one merge request
  for one forge login until it merges or closes. Its request id claims the pair, so a second
  start returns the first Run.
- **Finding status**: `open`, `fixed`, `disputed` or `obsolete`, for one finding with a stable
  id, anchored to the head it was judged at and the note that posted it.
- **Watch**: a waiting Follow-through's cursor and wake, completed by the merge watch.

## Consequences

- The human re-signs in to Slack once.
- A review card that is waiting on the author is not something the human owes, and it never
  becomes overdue.
- A card leaves the board when the merge request merges or closes. Nobody marks a review
  "merged".
- A finding has a stable identity and a status (open, fixed, disputed, obsolete) across rounds.
  A later round posts only what changed.
