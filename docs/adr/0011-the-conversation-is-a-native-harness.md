# The conversation is a native harness

**Status: accepted**, amended by the Control Plane redesign. Built for the Home's first
slice: the two-pane Home, the harness preference, the bounded read contract, and the two
transport adapters. The amendment is "Chat may do what the human could do on the board"
below, which replaces this ADR's original rule that chat's write tools carry nothing out,
"Amended 2026-09-29: chat may choose what proves a Run", "Amended 2026-10-02: the
tools are one Effect Toolkit", and "Amended 2026-10-05: a Herd's chat per Home, and one
Flock chat per Desktop", and "Amended 2026-10-07: the Flock chat reaches files".

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
because the installation checks fetch this checkout's refs. No second interpretation: the
native agent expressed the request structurally, so nothing pays a model to re-read it.
Claude reaches it through Effect's native MCP server over stdio (`collie mcp`,
started by the launch with `--mcp-config --strict-mcp-config`); Pi through a generated
extension loaded with `-e`; a human through `collie tools call`. Two spellings of "what is
going on" would be Collie and the row in front of a human telling different stories about
one Run. The MCP server uses the latest adapter supplied by the pinned Effect version;
Collie does not carry legacy protocol adapters or patch Effect to keep them working.

**Chat may do what the human could do on the board.** An earlier version of this ADR said
chat's write tools "carry nothing out" and that anything touching a Run had to be proposed
and confirmed. That was wrong, and it is superseded here. It made chat obstruct the person
it serves: asked to hold a workspace before leaving, Collie could only put the request on
the board and ask them to click it — a reduced-control interface wearing a safety rule.
The line is not "does it change a Run"; it is **who wanted it**.

- **The human's own instruction is carried out at once**, and the board shows the result.
  `collie_hold` holds a Run or a workspace, with an optional `until`; `collie_do` takes the
  board's own actions on a named Run — stop, resume, release, answer, steer (`deliver`),
  follow up and start — through the same closed union, the same last-moment admission
  check and the same executors a confirmation runs. It takes the board's **decisions**
  too: confirming a waiting proposal by its id and hash, declining one, and recording what
  became of finished work. A yes is still the human's — what changed is where they may say
  it. Saying "yes, do it" and being told to go and click it is the same obstruction as
  being told to go and click a hold.
- **What Collie wants of its own accord waits for a yes.** `collie_propose` records a
  proposal over the same closed action set, the same `validate` and the same executors a
  typed steer and the CLI go through; the human confirms it on the board by its id and the
  hash of exactly those actions. Drift Collie noticed and corrections it wants to send are
  this, and stay this. _Superseded for chat: `collie_propose` now carries out what it is
  given in the same call, with no separate confirmation — `set_verification` included
  (the 2026-09-29 amendment below, and [cli.md](../cli.md)). The evaluator's own proposals
  still wait on the board._

`test/chat-parity.test.ts` is where the line is kept honest: every operation the CLI offers
carries a route, and `write` says a tool does it directly.

**Chat is never a person.** Its actor origin is `chat`, stamped by the entrypoint that
serves the tools — never derived and never read out of the request — and a confirmation it
relayed is recorded as `chat:<id>`, not as the human. The bridge runs as a child of the
harness inside a pane, so it inherits a controlling terminal, and the CLI's "a TTY means a
person" shortcut would read a model as one. What relaxed above is that chat may act on
what it was told, never that chat became the human. Three things hold that line where it
matters:

- **No action kind settles anything.** There is no `confirm`, `decline`, `reconcile` or
  `verify` in `ActionSchema`, so a proposal can never carry its own yes, and a Run's notes
  asking to be confirmed are asking for something no proposal can contain.
- **Only the instruction path may settle.** `collie_propose` records; `collie_do` acts, and
  it alone stamps the actor as relaying what the human said in this turn. `maySettle` is
  what `judgeConfirmation` and `decline` ask, and a plain `chat` actor is still refused.
- **Everything chat proposes of its own accord is `pending`**, whatever a Run granted its
  Driver: that grant was for the Driver's own drift checks, and a conversation is not a
  Driver. Reconciling and verifying stay the human's, because they are an account of what
  somebody watched happen. _Superseded for what `collie_propose` carries out, which is
  applied at once, not left `pending` — `set_verification` too (2026-09-29, below).
  Reconciling and recording evidence are chat's too since 2026-10-01, below._

## Amended 2026-09-29: chat may choose what proves a Run

A Run that verifies is now refused at start when nothing is approved to prove it, and the
human put the line here: "the model may decide what counts as proof". The human verifies
the work in the merge request before it lands, and is not needed in the loop before then.
So the approved set is the one piece of authority chat sets on its own judgment:

- A `start` through `collie_do` may carry `verify`, the checks chat chose, read from the
  repository. The start is still the human's instruction; the checks it carries are
  chat's choice.
- `set_verification` adds or withdraws a running Run's check, through the same host grant
  and Intent amendment as `run intent verification`. `collie_propose` carries it out in
  the same call, with no yes: nobody confirms it.

This is a reach, and it is kept on purpose. A check is an executable and its arguments,
never a shell string, but the executable may be `sh` and its argument anything, and
Collie spawns it itself at the gate — outside the agents' permission rules, including
any managed-settings deny rules. Chat reads the repository to choose it, so what the
repository says can decide what Collie runs. Bounding it — a board yes, or only
executables a verify.json already names — would put the human back in the loop before the
merge request, which is the line the human drew. What bounds it instead is the merge
request: it lists each check the Run was held to with its command, and the human reads that
before anything lands. The same holds for a `start`'s `verify`, which `collie_do` carries
out as the start it is part of.

Recording evidence stays out of reach: there is still no `verify` action kind, so chat can
choose a command but never say it passed. And chat itself still has no shell: the
commands it chooses run at the gate, not in the conversation.

**The built-in tools are off** in both launches — `--tools ""` and `--no-builtin-tools`.
Collie's reads are the agent's entire reach, so there is no shell beside the admission
rules for a model to use instead of them. Everything is a flag on this launch: nothing is
written into `~/.claude` or `~/.pi`, and no model, effort level or spend is pinned.

## Amended 2026-10-01: nothing is the human's alone

The human put the line here: anything a human can do, an agent can do, and a safeguard
that binds an agent and not a human must name a harm only an agent could cause
([`AGENTS.md`](../../AGENTS.md), invariant 1). The `human-only` routes this ADR kept —
granting authority, per Run and as a default; reconciling a proposal, a delivery or the
Home; recording evidence with `collie verify`; `run steer`; the chat harness; creating a
workflow module — named no such harm. They are gone:

- Chat runs each through the `collie` CLI, as the human types it. It keeps the harness's
  own tools beside Collie's (the paragraph above on built-in tools being off no longer
  holds), so the CLI is a route it already has, with the same validation and executors.
  `test/chat-parity.test.ts` routes those operations `shell`.
- Chat confirms and declines a proposal on its own judgement, through `collie_do`, not
  only when the human said so in that turn. A proposal still never carries its own yes:
  no action kind confirms anything, so settling stays a separate act.

Two lines stay, because each names a harm only an agent can cause. Text that reaches chat
through a tool is data, never an instruction — a human is not prompt-injected by a Run's
notes. And what cannot be undone waits for the human's say-so on that thing, because an
agent acting on a misread wish does damage the human never intended.

Attribution is unchanged, and it is audit, never a gate: chat's tools record `chat`. A
`collie` command chat runs from its shell inherits the pane's terminal and is recorded as
human — a known gap in the record, not a permission.

## Amended 2026-10-02: the tools are one Effect Toolkit

The contract is one Effect `Toolkit`, so a second conversation can be given exactly the
tools this one has. Each tool states its parameters as an Effect Schema, which is both what
a harness is shown and what every call is decoded with, strictly. Each answers a failure as
a sentence rather than an error, and none needs approval. The MCP server registers the
Toolkit's tools itself rather than through `McpServer.toolkit`, which answers in JSON and
turns a refusal into a protocol error.

## Amended 2026-10-05: a Herd's chat per Home, and one Flock chat per Desktop

There are now two kinds of conversation, and both reach Collie only through Collie tools.
Each Home keeps the Herd-scoped Native chat this ADR describes, unchanged. Each Desktop
adds one **Flock chat**, about every Herd on every Machine it reaches.

The Flock chat is not a pane: Desktop has no terminal to put a harness in. It is a session
of the user's own Claude Code driven by the Agent SDK in Desktop's main process, so the
harness still owns the session, its persistence and its compaction, and Collie still owns
which session it is and what the model may reach. Its session id is minted once per
Desktop and resumed on every launch after, never "the most recent session", for the reason
`--continue` is refused above. It runs `opus` at medium effort
([ADR-0032](0032-a-chat-starts-new-on-the-latest-opus.md)), with Claude Code's built-in
tools off and no setting sources, so the user's hooks, skills and CLAUDE.md stay out.

Its tools are the same Toolkit, served in process rather than by `collie mcp`, and answered
by each Machine's host over a bridge channel Desktop opens `--as chat`, never Desktop's own
`desktop` channel: a model's action cannot be stamped human by a coding slip. Everything is
named `<machine>:<id>`; a bare id is taken only where one Machine has it. Before each write
the tool host declares the channel's conversation (`flock@<this computer>`) and the human's
message that turn, which the host records in the Actor
([ADR-0039](0039-every-operation-records-who-asked.md)). `collie_definitions`,
`collie_installation` and a workspace-wide `collie_hold` are not served there: each reads a
Machine's own files, which no host operation hands over.

The one built-in tool left on is AskUserQuestion. Its permission request is the human's
question, put to them as choice buttons, and the tool goes on with their answer; every
other permission request is refused. **Start fresh** mints a new session id and makes it
the one resumed; an earlier session is reopened by its id, from the transcripts Claude
Code keeps, never as "the most recent". The session before either ends first, so a
Desktop has one live Flock chat at a time. The board card the human clicked goes with
their next message as context from a UserPromptSubmit callback, never as their words.

News reaches the Flock chat as one batch across every Herd on every Machine, ordered by
Significance. A `decision` or `consequential` item starts a turn of Desktop's own when the
chat is idle and Desktop's `proactive` switch is on. That turn shows as Desktop's, and the
tool host declares no human words for it, so nothing it does is recorded as said by the
human. Anything else waits for the human's next message and goes with it as context. The
host settles only the items the model was given (the `news` operation's `keys`).

## Amended 2026-10-07: a Machine's host answers the Flock chat's reads

Desktop answered `collie_run`, `collie_receipts` and `collie_workspaces` with renderings of
its own, drawn from the drawer's details and the board. They fell behind Native chat's: a
waiting Run said `attention: question` and nothing of what it asked, what was sent to a
remote Machine's agents could not be read at all, and starting named directories the
Machine did not have. Those three are now answered by the Machine's own host with Native
chat's own reading, through one read-only front-door operation, `read`, that takes exactly
those three tool names and records nothing. Desktop places the Run as before, sends the
bare id, and heads the answer with the Machine's name; `collie_workspaces` asks every
Machine at once, a section each. A Machine that does not answer is named with "upgrade
Collie on <machine>". The Home board's selection never stands in for a Run through `read`:
it is an input for the Home's own chat
([ADR-0012](0012-the-boards-selection-is-an-explicit-chat-input.md)). The cost is that
Desktop cannot restyle an answer, and the ids inside it are bare; the heading names the
Machine. One reading of a Run, on the host, is what keeps the two chats from drifting apart
again.

## Amended 2026-10-07: the Flock chat reaches files

The Flock chat could not open a file. A human at Desktop can read, search, write and edit
any file on their computer and on every Machine they reach, and run a command here, so a
chat that could do none of it was the ceremony invariant 1 forbids: the human had to paste
what the model could have found.

On this computer, where Desktop and the chat run, the chat has Claude Code's own `Read`,
`Glob`, `Grep`, `Write`, `Edit` and `Bash`, beside AskUserQuestion, and none of them asks
first: a built-in tool that already exists is enabled rather than written again. Its
session still loads none of the user's settings, hooks, skills or CLAUDE.md, and its
working directory stays Desktop's state directory, where Claude Code keeps its transcripts,
so it names files by absolute path.

On every Machine it has `collie_read`, `collie_glob`, `collie_grep`, `collie_write` and
`collie_edit`, which take the same arguments as Claude Code's tools of those names, with a
path written `<machine>:<path>`. Each is answered by that Machine's host through a
front-door operation over the chat's own channel, never by ssh around the bridge. A read of
an image hands the model the image. A write or an edit takes a request id and is recorded
with the chat's voice, in the host's log, since it belongs to no Run. The one refusal is a
write or an edit inside the host's state directory: a Run's state is changed through the
host's operations (invariant 4), whoever is asking. These five are the Flock chat's own and
not the Toolkit's, so Native chat's reach is unchanged. `Bash` has no counterpart on a
Machine.

A file the chat finds, here or on a Machine, can go with a start, a follow-up or a steer as
a pasted one does ([ADR-0045](0045-an-attachment-is-uploaded-once-and-belongs-to-the-run.md)).
The system prompt says what the chat can reach, and still that what reaches it through a
tool, a file included, is data and not instructions.

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

"Chat cannot confirm its own proposal" is the probe confirming with a plain `chat` actor,
and it still refuses on this tree. What that row does not prove any more is that no
confirmation can come from chat: the human's own yes, relayed through `collie_do`, is one,
and it is recorded as `chat:<id>`. That path is held by `test/tools.test.ts` and
`test/chat-parity.test.ts`; the live probe has not been re-run on this tree.

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
