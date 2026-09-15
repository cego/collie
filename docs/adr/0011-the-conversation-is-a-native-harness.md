# The conversation is a native harness

**Status: accepted.** Built for the Home's first slice: the two-pane Home, the harness
preference, the bounded read contract, and the two transport adapters. What full
conversational control may then _do_ is a later slice and is not decided here.

The Herd's conversation is an ordinary Claude Code or Pi session running in the Home's
right-hand pane. Collie does not implement a chat.

## What was true before

The Home drew a composer of its own — a field at the bottom of the board, entered with `:`
— and every message went to a one-shot evaluator call whose answer was journalled and
drawn back as turns. Collie therefore owned an editor, a paste path, a history, a context
window and a redraw loop, and each of them was a worse version of something both installed
harnesses already had. The reported symptoms were exactly that: the field did not capture
what was typed, and asking anything needed a mode nobody could be expected to find.

## Decision

**The harness owns the conversation.** Input, editing, paste, streaming, session
persistence and compaction are its own. Collie owns three things and no more: which
harness opens, which session that conversation is, and what the model may reach.

**Claude Code is the default**, on an existing installation as much as a new one, and
independently of the harness Runs use. Pi is selectable. The choice is a **launch
preference**: a running conversation is never stopped, replaced or summarised because a
setting changed, and there is no handoff, generated switch summary or transcript
conversion between the two. Each harness keeps its own native history.

**A conversation is bound to a session id Collie mints**, per Herd and per harness, and
passed with `--session-id` — which both harnesses create if it is missing and resume if it
is not. Never `--continue`: "the most recent conversation in this directory" is how a Home
reopens into somebody else's.

**The Home is one tab of two panes.** The board keeps four sevenths, chat takes three, and
reopening the Home reopens only a pane that has actually gone — so a divider a human
dragged stays where they put it, and a lost chat pane does not cost them the board.

**One contract, three ways in.** `src/tools.ts` is the whole of what chat may ask:
bounded, Herd-wide, and built from the same shared operations the board draws itself from.
Five of its tools read; `collie_installation` also reads, and says it is not read-only
because the installation checks fetch this checkout's refs. `collie_propose` records a
proposal over the same closed action set, the same `validate` and the same executors a typed steer and the CLI go
through — and carries nothing out. No second interpretation: the native agent expressed the
request structurally, so nothing pays a model to re-read it. Claude reaches it through a local MCP server over stdio (`collie mcp`, the
official SDK, started by the launch with `--mcp-config --strict-mcp-config`); Pi through a
generated extension loaded with `-e`; a human through `collie tools call`. Two spellings of
"what is going on" would be Collie and the row in front of a human telling different
stories about one Run.

**Chat is never a person.** Its actor origin is `chat`, stamped by the entrypoint that
serves the tools — never derived and never read out of the request. The bridge runs as a
child of the harness inside a pane, so it inherits a controlling terminal, and the CLI's
"a TTY means a person" shortcut would read a model as one. Everything it proposes is
`pending` whatever a Run granted its Driver, because that grant was for the Driver's own
drift checks. There is no action kind that confirms, declines, reconciles or verifies.

**The built-in tools are off** in both launches — `--tools ""` and `--no-builtin-tools`.
Collie's reads are the agent's entire reach, so there is no shell beside the admission
rules for a model to use instead of them. Everything is a flag on this launch: nothing is
written into `~/.claude` or `~/.pi`, and no model, effort level or spend is pinned.

## What has actually been proven

Recorded by `tools/chat-live.ts <harness>` against herdr 0.9.0, Claude Code 2.1.272 and
Pi 0.85.1, in a disposable Herd of its own — its own state and config directories, its own
Home workspace, its own conversation — so nothing here touched a live Run. Re-run on the
tree this ADR ships on; a row here is about that revision and no other, and a later one
has to be recorded again.

| check                                                | claude | pi   |
| ---------------------------------------------------- | ------ | ---- |
| the Home is one tab, board left and chat right       | pass   | pass |
| the chat pane holds a live agent on that harness     | pass   | pass |
| a typed question is answered through a Collie tool   | pass   | pass |
| a follow-up naming nothing keeps its context         | pass   | pass |
| a chat pane closed under it is recovered alone       | pass   | pass |
| the relaunch resumes this Herd's own session         | pass   | pass |
| a request is a proposal, recorded as chat's, waiting | pass   | pass |
| and nothing has happened to the Run yet              | pass   | pass |
| chat cannot confirm its own proposal                 | pass   | pass |
| the human's confirmation is what changes the Run     | pass   | pass |
| news reaches the conversation on its next turn       | pass   | pass |
| and reading it is what settles it                    | pass   | pass |
| a queued push arrives on its own                     | fail   | fail |

Every marker the probe asserts is a string the model had to find out — a Run id it could
only get from `collie_herd` — never one typed at it. That is not fussiness: a pane shows
the question as well as the answer, and an earlier version of this probe asked for a
marker that appeared in its own prompt, so every one of those rows passed on the echo of
the question. It proved nothing, twice.

The last row is the one that is not a pass, on either harness, and it is watched on both
rather than assumed for one. Collie attempts Pi's documented queued custom-message push
and the probe has never seen one arrive; on Claude it attempts none, and the probe watched
an idle pane for a minute after the item was written and saw nothing arrive there either.
So a push is recorded as unproven on Pi and absent on Claude — nothing is marked delivered
because of it, `collie chat status` says so, and the next turn is what actually carries
the news on both harnesses. Whether the message surfaces to a human who is present, and
the probe simply cannot see it, is not something reading a pane has settled either way —
so it is left open rather than claimed.

Five defects were found this way, and each is one no test with a fake adapter could have
found:

- herdr gives a new workspace a shell of its own, so the Home was two tabs.
- herdr holds an agent's name until its process has gone, so a relaunch under a name
  derived from the session was refused and the Home was left with an empty chat pane.
- Claude's `--session-id` **creates** an id and refuses one that has ever been used — only
  `--resume` reopens it — so every relaunch started a conversation with no history and
  reported that it had resumed one.
- The MCP server the launch names has to be Collie's own entrypoint. Under a probe running
  from source it was not, and Claude ran with no Collie tools at all — answering about the
  Herd from nothing, which is exactly what a tool-less conversation looks like from
  outside.
- Pi's extension was given only a working directory where Claude's server was given the
  whole environment, so Pi read whichever Collie the pane happened to have. Inside a
  disposable Herd it confidently answered about the human's real one. Both adapters now
  take the same object, and a test holds them to it.

## Consequences

The board is a board. There is no composer, no `:` mode and no `answer` evaluation kind;
`collie steer` now requires `--target`, because a question about the flock is chat's and a
steer is about one Run. Driver supervision's `judgement` calls are untouched.

A missing harness, or a chat pane herdr will not open, leaves the board and every Run
working and says so. Collie never quietly opens the other harness instead: the human chose
one.

The old conversation journal is kept and still read; proactive turns still write to it.
What a native conversation says is the harness's, and Collie does not copy it anywhere.

Outstanding, and the next slices': proactive delivery into a live native session on a
Claude that an organization has enabled custom Channels for. Collie will not turn that
consent on for a human, so until an installation arrives with it on, the next turn is the
delivery on that harness.
