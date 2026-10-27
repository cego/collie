# A release shares its merge request for approval on a human's say

**Status: accepted, to be built.** Builds on
[ADR-draft-a-merge-request-is-released-on-a-humans-go](draft-a-merge-request-is-released-on-a-humans-go.md)
D3 (the host waits for the review) and [ADR-0043](0043-a-shared-setting-is-its-latest-edit.md)
(settings).

A Release Run can wait days on a teammate's approval. Teams ask for one by posting the
merge request in their Slack channel. That post is the only step left between an open merge
request and its go that a person still does by hand. It is also the first thing a shipped
workflow would post outside the forge: everyone in the channel sees it, and it cannot be
taken back.

## Decision

**D1. Off unless the operator turns it on.** Two settings decide it:
`release.share_for_approval`, off by default, and `release.approval_channel`, the channel.
A Run reads both once, in a journaled Activity, so a replay asks what the first pass asked.
Turned on with no channel, the Run says so on its log and shares nothing.

**D2. The human checks first.** Before each review wait, while nothing is shared yet, the
Run reads the review once. Where it waits on a teammate's approval it asks
`share-for-approval`: **Post for approval** or **Wait for changes**. A wait is asked again
only at a new head. A teammate's approval meanwhile goes on to the go as before, and a Post
answered after it posts nothing: the review is read again before the message goes.

**D3. One message, by the Run's agent.** Collie has no Slack client of its own, and the
operator's agent already has their Slack tool. The `share` step is cleared for one message
in the channel: the merge request's address linked by its title, with nothing else. Collie
records the permalink, or why nothing was posted. That record is the agent's word, and
nothing waits on it: a share that fails is recorded and never fails the release.

## What this does not decide

- Another chat service, or a channel per repository.
- Following up in the channel once the merge request changes or merges.

## Consequences

An operator who turns it on answers one more question per release, at each new head they
decline at. The question comes before the wait, so the card's wait line starts once it is
answered.
