# Steering a Run

This page is about how a message reaches a live agent, what Collie can and cannot say about
what happened to it, and what a Run is held to. The drift half compares work against a
Run's [Intent](cli.md#intent), which a Run of a workflow module does not carry yet.

## Delivery

One message to one live agent is a **delivery**. Every one of them goes through the
Dispatcher ([internals](internals.md#the-dispatcher)) — nothing else sends text to an
agent — and every one is journalled before it is sent.

Three modes:

| Mode        | What it does                                        | Needs                                  |
| ----------- | --------------------------------------------------- | -------------------------------------- |
| `boundary`  | Composed into the front of the agent's next prompt. | Nothing.                               |
| `now`       | Sent to an agent that is already working.           | A proven `now` for that harness.       |
| `interrupt` | An interrupt key, then the message.                 | A proven `interrupt` for that harness. |

`boundary` is the only one that works everywhere: it goes out as an ordinary prompt, which
every harness takes, and a busy agent's harness takes it when the turn it is in ends. A
human's message is about the work under way, so a `deliver` with no mode is `now`. Every
mode goes out from the host, through the Dispatcher, under the agent's ledger lock. `now`
and `interrupt` are gated on a **recorded live result** per harness; where that harness
has none the delivery is refused, with `capability_unproven:<harness>:<mode>` on the
ledger, so a steer that did not go out as asked has an answer rather than a silence.

## The states, and why they are kept apart

| State          | What it means                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`       | A boundary delivery an older Collie held for an agent's next prompt. Read in the ledgers it left; nothing writes it now.                             |
| `reserved`     | Written **before** herdr was called. A crash here leaves this.                                                                                       |
| `deferred`     | herdr answered that the pane cannot take a prompt yet, with a code that says it clears by itself. Nothing was delivered; the same id is tried again. |
| `submitted`    | herdr took it. Not: the agent read it.                                                                                                               |
| `acknowledged` | The agent wrote the ack file naming this delivery, version and attempt.                                                                              |
| `verified`     | An independent check says the thing asked for actually happened.                                                                                     |

They are separate because they are separate facts. herdr types text into a pane and
returns; that says the keystrokes went somewhere. Collapsing them would let Collie report
work as done on the strength of a send.

`submitted` carries one qualification. herdr's own gate waits for a turn to start after
the prompt; where that wait ran out, or the agent was already working, the delivery is
still `submitted` — the text and the Enter were written — with the note `unobserved`,
and `run deliveries` shows the note beside the state. It is never rounded up to a turn
nobody saw, and never rounded down to a failure: a prompt that arrived and one the agent
ignored look the same from here, and the note is what tells a later reader that.

The terminal states are `failed` (herdr refused), `unknown` (herdr never answered, so
nobody can say), `superseded` and `expired`. `unknown` blocks further deliveries about the
same work until a human reconciles it, and Collie never retries out of it on its own.

`deferred` is the one refusal that is retried, because it is the one that proves the prompt
was not delivered and says why the next try may land. Which refusals count is decided by
herdr's code, recorded on the line as `code` — today only `agent_blocked`, an agent with a
dialog up — and never by its message. A step's prompt and its repair are tried again with
a backoff from two seconds to thirty, each try reserved again under the same id, so every
attempt is on the ledger and a second copy of the work stays blocked meanwhile. Ten minutes
after the first refusal the delivery is settled `failed` with the note
`<code> held for <time> over <n> attempts`, and the Run's log says it `gave up` — which a
refusal nobody retried never says. The Run then parks rather than failing: its agent
is alive and its prompt is written, so `run show` says so and `collie run resume` hands that
prompt to that agent. A human's steer is sent once and told the refusal, since they are
waiting on the answer.

A step prompt's delivery ends `superseded` with the note `work_collected` once the agent
has gone quiet and its Output has been read: what the prompt asked for is in the Run, and a
later prompt about the same step — a human's `run resume` re-running a disputed fix at the
same iteration, to the same live implementer — is a new attempt, not a second copy of this
one. That settlement never happens after a give-up, and never touches a `reserved` or
`unknown` line: an agent that may still be working keeps its delivery in flight, so the
same work is not sent to it twice, and a delivery in doubt stays a human's to reconcile.

Every delivery asks the agent to write
`<run dir>/steering/acks/<delivery id>.json` with the delivery id, the Intent version, the
attempt and one sentence saying what it understood. An ack for a different version or
attempt is recorded as `ack_mismatch` and changes nothing — it is the agent answering a
different question.

## Interrupts are never "stopped"

An interrupt sends the harness's interrupt key and then the message. What can be observed
is that herdr sent the keys, and that the agent's status left `working`. Neither is proof
the harness stopped, and no such proof exists at this boundary — so the states are
`interrupt_requested` and `interrupt_acknowledged`, and the word "stopped" appears in
none of it.

## Manual override

If someone types into an agent's pane, Collie stops correcting that agent automatically.
On Claude this is detected by a `UserPromptSubmit` hook: a submission without Collie's
`collie-delivery:` token is somebody else's. Only `collie run clear-override <run> <agent>`
lifts it — nothing times it back on, because a human who took the keyboard is assumed to
still have it until they say otherwise.

No other harness offers a hook Collie can install, so on codex, opencode and pi there is
no attribution at all. Automatic correction there needs `authority.exclusive_steering`, and
every row of such a Run carries `⚠ unattributed` for as long as that is true: a human whose
agents are being corrected on a harness nobody can prove they are alone at is told so.

## What has actually been proven

Recorded 2026-09-11 by `tools/steering-live.ts <harness> --agent <name>` against herdr
0.9.0, on disposable agents in an isolated state directory; the rows, ack files, ledgers
and pane snapshots are in the release's `CAPABILITIES.md`. The table in
`src/steering-caps.ts` says the same thing and may only be changed to match a recorded pass.

| harness  | now      | interrupt | ack      | attribution |
| -------- | -------- | --------- | -------- | ----------- |
| claude   | proven   | proven    | proven   | unproven    |
| codex    | unproven | unproven  | unproven | none        |
| opencode | unproven | unproven  | unproven | none        |
| pi       | unproven | proven    | unproven | none        |

Claude took a delivery while working and wrote its ack within ten seconds; Escape and a
delivery after it left `working` and were acknowledged. Pi left `working` on Escape and
acknowledged what followed, but a prompt typed while it works sits in its editor until
that turn ends — `submitted` with the note `unobserved`, exactly what the Dispatcher
records — so `now` is not something pi has been shown to do. Codex and opencode took the
text but their own sandboxes and permission prompts stood between them and the ack file
in the probe; a blocked agent is one herdr refuses to prompt at all, and that refusal is
what the ledger shows (`deferred`, then `failed`, with the code `agent_blocked`). Attribution on Claude needs a human
typing into a Collie-launched agent's pane and is the one row an operator has to record.
`boundary` deliveries need none of this and work on every harness.

The evaluator has been run against the installed `claude` 2.1.268, ten calls and one
isolation call: every answer decoded against the schema it was given, and the isolation
transcript showed no tool but the CLI's own `StructuredOutput` channel — the mechanism
`--json-schema` answers through, whose input is the answer — no hook and no MCP server.
`tools/evaluator-probe.ts` is what produced that and what re-checks it after a CLI
upgrade. The code is still written for a wrong answer — a report naming a constraint the
Intent does not have is dropped, and one naming another Run is refused.

## Verified, and claimed

An agent's Output saying "the tests pass" is a **claim**. Collie shows it as one, next to
the agent that made it, and never as evidence.

A **verification** is a command whose exit Collie watched, bound to the tree it ran on:
`collie verify --run <id> -- <command>` ([CLI](cli.md#verify)). The tree is fingerprinted
before and after — the commit, the porcelain status, the diff against HEAD, and the
content of every untracked file git is not ignoring — and a result whose two snapshots
differ is `unstable`, never `pass`. So is one where either snapshot says the tree was too
large to look at: two unmeasured trees are not one tree.

Collie will also run a verification itself, but only one the human wrote into the run's
`authority.run_verification` with `run intent verification`, matched argument for argument.
The wrapper is part of what was approved — `bun test` and `bun test --bail` are not the
same permission. It runs at the run's finish, and only where a `command_exit` rule names
it and nothing has verified that name yet.

The baseline workflows and personas route their test, lint and typecheck runs through the
collector, so a card can say `verified` rather than `claimed`. The implementer also writes
a progress checkpoint per ticket under `steering/progress/`; those are claims too, and
labelled as such.

## Talking to Collie

A **steer** is one free-form message about a named Run:
`collie steer "<text>" --target run:<id>` ([CLI](cli.md#talk-to-collie)). It is a question.
It writes what you said into the Herd's conversation, asks the evaluator, records what
came back, and prints it — and that is all it does.

Targets are **named, never inferred**. `--target` is required: without one the call is
refused with `target_required` rather than having a run guessed for it from your words.
Collie has no grammar of its own, and a sentence that happens to name a branch is not a
target. Questions about the flock are the Home's
[native chat](using.md#talking-to-collie-about-the-flock), which reads the Herd rather than
paying for a model to be asked one here.

The conversation is one per Herd — one herdr session, every workspace in it — and lives on
disk, so closing the board loses nothing. Two things are done to a turn before it is
written: values shaped like credentials are replaced by what kind of credential they were
(a conversation about a failing deploy is exactly where one gets pasted), and paths that
point outside the runs Collie knows about become `<external>`, because a path in a turn
came from a model and the board offers to open what it renders. Worker terminal
transcripts are never stored: what an agent is doing reaches the conversation as herdr's
own status and title, and no further.

It is trimmed on write to 500 turns and 30 days. There is no daemon to sweep with, and the
write is the only moment anyone holds the lock.

## Drift

**Drift** is a recorded mismatch between the evidence and the run's Intent
([CLI](cli.md#drift)). A Run of a workflow module carries no Intent yet, so nothing in this
section, [Correcting drift](#correcting-drift), [Finishing](#finishing) or
[Cross-run checks](#cross-run-checks) runs for it: they are what a Run with an Intent is
held to, and what an older Collie's Runs recorded. Two kinds, kept apart on purpose.

A **rule** constraint is a fact Collie can establish by itself: which files changed,
which branch it is on, what a step's Output field says, what a named verification exited
with. No model is involved, so these are checked at every `collect`, at every work
boundary, and at `finish` — a fact that costs nothing to check should never be paid for.

A **semantic** constraint is a judgement, so it costs money and can be wrong. It is made
at boundaries and at `finish` only, and against **bounded actual evidence**: the real
unified diff of the files the constraint names, capped at 200 lines per file and 20 files,
with the truncation recorded on the report. A summary of a change would be a second thing
to be wrong about. Files whose _names_ look like credentials — `.env`, `*.pem`, anything
with `token` or `secret` in it — are listed by name with `<redacted>` rather than quoted.

The rule that keeps this honest: **nothing passes on an absence**. A verification nobody
ran is a breach, not a pass. A judgement Collie could not make — no evaluator, a call that
timed out or answered outside its schema — is recorded as `skipped` with the reason, so a
card can say why it says nothing rather than reading as clean. What every call cost is
written to the Herd's `budget.jsonl` as usage; no count of them is ever a reason to skip
the next.

The journal is append-only. A resolution is a new line, not an edit, so what Collie
thought and when survives being wrong. Two reports of the same constraint in the same
place are one finding, however many times it is looked at.

## Cards

A **card** is one slice of work as a human would want it handed to them: what was asked
for, what changed, what backs that up, and — the half usually missing from a report —
what nobody checked. `collie run cards <run-id>` lists them.

Two fields carry the discipline.

**Readiness** says how far the evidence goes and no further:

| Readiness       | What it means                                                    |
| --------------- | ---------------------------------------------------------------- |
| `claimed`       | An agent said so. That is all.                                   |
| `inspect-ready` | Something changed at a recorded revision; you could go and look. |
| `verified`      | A command Collie watched passed on **this** tree.                |

A verification from another revision is `stale`, not a pass: it says nothing about what
this card describes. Agent claims are always in `claims` and never among the
verifications.

**Significance** decides whether this is worth interrupting somebody, by rules over facts:
`decision` when something is waiting for the human (a Choice, unresolved drift, a pending
proposal, an unacknowledged correction), `consequential` when something happened they
should know about (blocking drift, a correction sent, the Intent moved, the run failed or
stopped), `try-it` when there is something to look at or a merge request moved, and
`routine` otherwise. A `decision` outranks a `consequential` because a decision is the
human being _waited on_.

The narrative is an input the rule ignores. There is no path by which a model makes its
own work look more important by describing it that way, and nothing that writes a card
takes focus — a card arriving must never move a human off what they are doing.

The implementer writes a **progress checkpoint** per ticket, and `implement` writes one
itself when a slice lands, whether or not the agent remembered. The board reads them while
the build is still running. That is the point: a human sees a slice land without waiting an
hour for the whole build.

The Home board draws them under a task's record, in
[Cards](using.md#what-a-card-says), where the same discipline is on screen: a claim is
prefixed `claimed:` so it can never be read as a pass, `missing` is drawn even when it is
empty, and the narrative is last and dim. The card on the board carries the newest one and
an amber `↯` line for open drift, so there is something to see without opening the record,
and none of it takes focus.

## Correcting drift

Collie corrects drift by itself only where the run's Intent granted `auto_correct`, and
even then every gate below is somebody being deferred to:

- **Somebody typed into that pane.** A manual override stops automatic corrections to that
  agent until `run clear-override`. Collie does not take turns with a human.
- **On a harness with no attribution**, Collie cannot tell its own submissions from a
  person's — so correcting needs `authority.exclusive_steering`, the human saying nobody
  else is steering this run, and the row says `⚠ unattributed` while it is being honoured.
- **The run is held.** A hold is the human saying stop; a correction is starting something.
- **Something about that constraint is already in the air.** The causal key is the
  constraint, so a second correction waits for the first to settle.
- **The bound is spent.** `max_corrections_per_constraint` (2 by default). After that the
  report is `escalated` and it is the human's.

The text is a **fixed template**, not the model's words — it goes out without anybody
reading it first, so what it can say has to be what the human agreed to when they granted
this. Its last sentence is the important one: it tells the agent that where the constraint
conflicts with the goal, it should **say so in its Output instead of choosing**. An agent
told only to obey picks one silently, and the conflict is exactly what the human needs to
see.

A correction is `correction_submitted`. Never `corrected`, never `verified`: sending text
is not the work changing. Only new evidence at a later revision settles that, which is why
a re-check of an unchanged tree clears nothing.

## Finishing

A finished run is immutable, so `finish` settles rather than acts:

- Anything queued as a boundary delivery is `expired` with the reason — there is no next
  piece of work to compose it into, and leaving it pending for ever would be a lie.
- The run gets an **alignment** verdict. `true` is the strong claim and needs everything
  actually checked: every rule passing, every semantic constraint judged against evidence
  that was not truncated, no open report, and the goal judged where there is one. `false`
  is the other strong claim: something blocking is open. Everything else is `unverified`,
  which is not a hedge — it is the accurate answer when nobody looked, or looked at part.
- With a blocking constraint still open, Collie records a **pending proposal** for a
  follow-up child run. It does not start one, and it does not re-prompt anybody.

## Follow-ups

A finished run is immutable, and there is no mode that reopens one. Where its outcome
needs more work, carrying on is one of the run's own offers
([CLI](cli.md#carry-on-from-a-finished-run)) — a child run of the workflow it declares,
started with `run action <run> <offer>`. Collie never starts one by itself.

## Cross-run checks

Sibling runs are judged against each other's Intents, so no Run of a workflow module is
checked this way.

## Proposals

A **proposal** records an interpretation, its target runs, and actions. User requests
from chat and `steer` execute through this journal immediately. Background suggestions
remain pending; they do not turn a status update into an unsolicited action.

A confirmation can execute a pending suggestion:

```sh
collie --json confirm <proposal id>
collie --json decline <proposal id>
```

Use optional `--hash <content hash>` when pinning a particular payload. A different hash,
an expired proposal, or a moved target is still rejected. Commands work from scripts and
chat without a terminal check; their actual origin is recorded rather than relabeled human.
Use `steer --dry-run` when you only want a preview.

Immediately before each action runs, everything the proposal assumed is asked again:
the run still exists and its status permits the action, an `answer` still matches the
Choice being asked, the agent in that pane is still the one the proposal was about, the
Intent is still the version it was written against, and a card-bound proposal's revision
has not moved. Time passes between reading a proposal and confirming it.

Each action writes its own line before it runs and again after. An action that started and
never settled makes the next confirmation refuse with `reconcile_required`: nobody can say
whether it happened, and re-running it is exactly the risk that record exists to prevent.
A human settles it with `collie proposal reconcile <id> <index> --as applied|not-applied`.

An action whose kind this build has no executor for is refused with `executor_missing` and
recorded as skipped. Every kind is registered by the module that owns the operation, so
there is nowhere in the codebase an action kind exists as a stub that does nothing.
