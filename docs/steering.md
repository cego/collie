# Steering a Run

This page is about how a message reaches a live agent, what Collie can and cannot say about
what happened to it, and what a Run is held to. The drift half compares work against a
Run's [Intent](cli.md#intent).

## Delivery

One message to one live agent is a **delivery**. Every one of them goes through the
Dispatcher ([internals](internals.md#the-dispatcher)) — nothing else sends text to an
agent — and every one is journalled before it is sent.

Every Delivery that carries someone's words names its sender on the line after its
`collie-delivery:` token, written by the Dispatcher from the stamped
[Actor](../CONTEXT.md) in every mode:

| Door                                                        | Sender line                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `board`, `desktop`, `cli-tty`                               | `From the human, on the board` / `in Desktop` / `in a terminal`, then the time. |
| `chat`                                                      | `From chat for the human, <time>. The human said: "<said>"`                     |
| `chat` with no `said`                                       | `From chat, <time>.`                                                            |
| `agent`, `host`                                             | the line below                                                                  |
| `cli` without a terminal, `driver`, `evaluator`, `schedule` | `From <door>, <time>.` It never says "the human".                               |

`<time>` is the host's local minute with its offset, `2026-10-16 14:02 +02:00`. `<said>` is
the human's own message that chat turn, attached by the tool host and never by the model,
with credential-shaped values removed. An agent's Delivery starts with:

```text
From <agent> of <run> on <machine>. Answer with collie_do deliver to <run> (or collie run steer <run> --operation <agent> "…").
```

The text follows word for word. The receiving Run's operations record the sender's Run,
agent and authenticated Machine. The answer follows the same route, found by Run id. The
answers to an agent's question ([ADR-0062](adr/0062-an-agents-question-is-asked-on-its-run.md))
carry the line of whoever answered: one line, `Your question <header> is answered: <answer>`,
or each question's answer joined with `; `. Answers given by different senders go as
separate messages, each under its own sender's line. Collie's own messages carry no sender line: a
step's message, a repair, a correction, a compaction request and a hand-off. Each step's
prompt tells its agent that a line starting `From the human` is the human's own message,
one starting `From chat for the human` quotes the human, and one from an agent is that
agent's words.

### The paste budget

Claude Code shows its model a typed message of more than about three lines or 800
characters as pasted content, and agents and auto mode do not take pasted content as the
user's own words. So a Delivery's typed form, everything Collie types for it (the token
line, the sender line with chat's quote, the words and any `Attached:` lines), stays within
**3 lines and 700 characters**, 100 under what was measured, leaving room for a resend's
longer token.

Where it would not, the words are kept word for word as `message-<digest>.md` in the Run's
`attachments/`: chat's `The human said: "…"` first, then the words, then the `Attached:`
lines. What is typed is the token, the sender line without chat's quote, and
`Their message is in <path>. Read it whole and act on it as theirs.` (`as that agent's` for
an agent). Where even that is over the budget, because the state directory's path is very
long, it is typed anyway, and the receipt says it may arrive as pasted content. Collie never
types an excerpt instead: a cut can change what it asks. This holds for every door that
steers, and the audit line records the words as asked
([ADR-0051](adr/0051-a-review-comment-is-written-on-desktops-own-views.md),
ADR-draft-what-a-run-authorises-reaches-auto-mode).

Auto mode reads only what is typed, so a kept message reaches it as a tool result. The
receipt of a kept steer says so to whoever sent it: ask for an action auto mode must clear
in a message of at most 3 lines and 700 characters. Where it refuses an action only a kept
file asked for, the agent asks on the Run with its question tool, naming the exact action
and its target, and the short answer is typed plain under the answerer's sender line.

Three modes:

| Mode        | What it does                                        | Needs                                  |
| ----------- | --------------------------------------------------- | -------------------------------------- |
| `boundary`  | Composed into the front of the agent's next prompt. | Nothing.                               |
| `now`       | Sent to an agent that is already working.           | A proven `now` for that harness.       |
| `interrupt` | An interrupt key, then the message.                 | A proven `interrupt` for that harness. |

`run steer <run> --step <step-id> "<words>"` leaves a note for a declared Step,
including one whose agent has not launched. Its next prompt starts with the note,
including a prompt made after `run resume`. While that Step's agent is working,
the host uses a boundary delivery to it. Notes keep their id, author, time, text
and read time. `run withdraw-note <run> <note-id>` removes an unread note; edit by
withdrawing it and sending another. A read note is history. A Step that makes no
prompt leaves its note unread, listed by `run show` even after the Run ends.
Question Steps take answers rather than notes. A Step already left with no next
item or round refuses notes and pauses, naming the Step.

`run hold <run> --before <step-id>` arms a pause at that Step's entry, before any
kind of work. `run release <run> --before <step-id>` disarms it. Once reached,
plain `run release <run>` continues. Chat's hold/release take `before`, deliver
takes `step`, and `withdraw_note` takes the note id, with the same rules.

`boundary` is the only one that works everywhere: it goes out as an ordinary prompt, which
every harness takes, and a busy agent's harness takes it when the turn it is in ends. A
human's message is about the work under way, so a `deliver` with no mode is `now`. Every
mode goes out from the host, through the Dispatcher, under the agent's ledger lock. `now`
and `interrupt` are gated on a **recorded live result** per harness; where that harness
has none the delivery is refused, with `capability_unproven:<harness>:<mode>` on the
ledger, so a steer that did not go out as asked has an answer rather than a silence.

One delivery is at most 8 KiB, a resource limit the Dispatcher refuses past. Words that
long are always over the paste budget, so they are kept as a file before that.

### What the host sends on its own

Besides what a human or an agent asks it to send, the host delivers, each through the
Dispatcher:

- each step's prompt;
- the answers to an agent's questions, once they are answered on its Run;
- a finished Run's report, to the agent that requested the Run;
- a correction of drift ([below](#correcting-drift));
- the end of a `collie verify` an agent asked for, in mode `boundary`, where herdr reports
  that agent `idle` or `done` and Collie is still collecting its Output. It names the
  check, its result and exit status, the commit and the log. A working or blocked agent is
  sent nothing, nor is one Collie is not waiting on, nor anyone for a verify answered
  from an earlier pass
  ([ADR-draft-an-agent-is-told-when-its-verify-ends](adr/draft-an-agent-is-told-when-its-verify-ends.md)).

## The states, and why they are kept apart

| State          | What it means                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reserved`     | Written **before** herdr was called. A crash here leaves this.                                                                                       |
| `deferred`     | herdr answered that the pane cannot take a prompt yet, with a code that says it clears by itself. Nothing was delivered; the same id is tried again. |
| `submitted`    | Sent: herdr typed it and pressed Enter. Not: the agent read it.                                                                                      |
| `acknowledged` | The agent took a turn after it: herdr saw one start, or Claude's prompt-submit hook recorded the delivery's token.                                   |

[PRODUCT.md](../PRODUCT.md) names three facts: a message sent, an instruction acknowledged
and an outcome verified. Sent is `submitted`. Acknowledged is `acknowledged`, a turn taken
after the delivery. Verified is not a delivery state at all: it is the drift judgement on
the Run, whether the work came back where it was told (below). They are separate because
they are separate facts. herdr types text into a pane and returns; that says the keystrokes
went somewhere. Collapsing them would let Collie report work as done on the strength of a
send.

`submitted` carries one qualification. herdr's own gate waits for a turn to start after
the prompt; where that wait ran out, or the agent was already working, the delivery is
still `submitted` — the text and the Enter were written — with the note `unobserved`,
and `run deliveries` shows the note beside the state. It is never rounded up to a turn
nobody saw, and never rounded down to a failure: a prompt that arrived and one the agent
ignored look the same from here, and the note is what tells a later reader that.

The terminal states are `failed` (herdr refused) and `superseded` (a human reconciled it).
`unknown` (herdr never answered, so nobody can say) blocks further deliveries about the
same work until a human reconciles it, and Collie never retries out of it on its own.
A step's prompt or repair left `unobserved` with nothing to show it was taken parks its
Run the same way, and is reconciled the same way; `not-sent` has the resume send it again.

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

A step's prompt or repair also waits out another sender holding the agent's ledger — a
transaction already open on it in the host, or its lock held by another process — on the
same backoff, and parks once that has lasted ten minutes. A steer to an agent whose step
is still being launched or given waits until that step's prompt has gone out, so the work
reaches the agent first.

## Who a steer reaches, and what it says came of it

A steer, a review comment, chat's `deliver` and a correction that name no agent reach the
agent whose step is active — its newest launch has no Output yet — and with none active,
the Run's builder (its `implementer`), else whoever was launched last — a Run with no
implementer, such as an investigation, has no builder, and `--to builder` there says no
agent was launched for it. A busy builder is reached even when an idle reviewer was
launched after it. `--to builder|reviewer|planner` names a role, `--to <agent>` an agent or
an operation, and `--operation` still works; where both are given, an agent's name wins,
then `--operation`, then `--to`. An agent is also named by the short name it was launched
under, such as `build` for `run-…-build-r1`, which reaches it in a Run whose operations are
its tickets, finished or not.

A steer or correction that herdr did not see start a turn is confirmed as a step's prompt
is: a turn starting once the agent has settled, Claude's prompt-submit receipt, or, with
its token still in the prompt box of a settled agent, one Enter. It waits for that up to
twenty seconds, since someone is waiting on the answer. The result carries `observed` and
`how`; the CLI says `Delivered to <agent> (observed: <how>).`, or `Sent to <agent>, not
observed.` with the `herdr agent focus` that shows its pane. It never says the agent was
told when nothing was seen.

## Interrupts are never "stopped"

An interrupt sends the harness's interrupt key and then the message. What can be observed
is that herdr sent the keys, and that the agent's status left `working`. Neither is proof
the harness stopped, and no such proof exists at this boundary — so the log says
`interrupt_requested`, the text after it is confirmed like any other delivery, and the word
"stopped" appears in none of it.

## Manual override

If someone types into an agent's pane, Collie stops correcting that agent automatically.
On Claude this is detected by a `UserPromptSubmit` hook. Every prompt Collie sends — a
step's pointer, a repair, a hand-off, a steer, a compaction request — carries a line of
its own, `collie-delivery:<id>`, first or straight after a slash command, and the hook records that id with the submission, so a
prompt Collie sent is tied to its delivery. Claude also submits turns of its own through
the same hook — a background task or monitor finishing (`<task-notification>`) and a
message from another agent (`<agent-message from=…>`) — and those are recorded as
`harness`, not as a person: nobody typed them. What is left, a submission that is neither
Collie's nor Claude's own, is somebody else's, and only those are counted. The prompt's
text is never kept, only who submitted it. Only `collie run clear-override <run> <agent>`
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
what the ledger shows (`deferred`, then `failed`, with the code `agent_blocked`). Attribution on Claude is
unproven, and on Claude a correction still needs `exclusive_steering`. Its `UserPromptSubmit`
hook used to record turns Claude injects itself, such as a task notification, as external,
so oversight could read one as a manual override; it now records them as `harness`. The
probe decides attribution from the hook's own record: its delivery is recorded as `collie`,
and the agent's count of external submissions rises by exactly one while the line is typed.
The hook runs from the installed binary, so the row can only be recorded against a release
with that fix installed, and it is an operator who has to record it.
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
`collie verify -- <command>` from the Run's agent pane, or with `--run <id>` from anywhere
else ([CLI](cli.md#verify)). The tree is fingerprinted
before and after — the commit, the porcelain status, the diff against HEAD, and the
content of every untracked file git is not ignoring — and a result whose two snapshots
differ is `unstable`, never `pass`. So is one where either snapshot says the tree was too
large to look at: two unmeasured trees are not one tree.

Collie will also run a verification itself, but only one of the run's checks, matched
argument for argument. Anyone names one with `run intent verification` — a human, the
run's own agent, or chat with `set_verification`, which `collie_propose` carries out in
the same call — and nobody approves it
([ADR-0055](adr/0055-a-run-never-asks-to-run-its-checks.md)). Collie spawns it itself,
outside any agent's permission rules. The wrapper is part of the check — `bun test` and
`bun test --bail` are not the same one. It runs at the run's finish, and only where a
`command_exit` rule names it and nothing has verified that name yet.

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
[native chat](using.md#talking-to-collie-about-a-herd), which reads the Herd rather than
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
([CLI](cli.md#drift)). A Run carries its Intent from the moment it is admitted, and the
checks below run for it: rules after each piece of agent work is collected and before the
next starts, and a judgement before each piece of work and at the finish. What they find is
[corrected](#correcting-drift) through the agent that did the work last, a Run
[finishes](#finishing) the same way whatever its workflow, and related Runs are
[checked against each other](#cross-run-checks). Before each check in a Run on a worktree of
its own, the constraints in its `plan/SPEC.md` are brought into its Intent, and one anyone
else removed stays removed ([ADR-0036](adr/0036-a-runs-own-plan-bounds-it.md)). A Run started
from a plan takes its goal from the spec: the first paragraph under `## Objective`, else under
`## Solution`, the heading to-spec writes. The goal is context for the judgement; it grants
nothing and is not a constraint. Two kinds, kept apart on purpose.

A **rule** constraint is a fact Collie can establish by itself: which files changed,
which branch it is on, what a step's Output field says, what a named verification exited
with. No model is involved, so these are checked at every `collect`, at every work
boundary, and at `finish` — a fact that costs nothing to check should never be paid for.

A **semantic** constraint is a judgement, so it costs money and can be wrong. It is made
at boundaries and at `finish` only, and against **bounded actual evidence**: the real
unified diff of the files the constraint names, capped at 200 lines per file and 20 files,
with the truncation recorded on the report, and the Run's Outputs under the same caps and
redaction the [cross-run check](#cross-run-checks) uses. Evidence past the cap is not judged
at a boundary, since each call would judge the same cut-off part: the Run log says `not judged
at <where>: evidence past the cap; judged at the finish`, nothing is recorded as skipped, and
the finish judges it once. A summary of a change would be a second thing
to be wrong about. Files whose _names_ look like credentials — `.env`, `*.pem`, anything
with `token` or `secret` in it — are listed by name with `<redacted>` rather than quoted.
The judgement is told that a constraint read from the plan narrows the goal it was cut
from: the goal is what was asked, never evidence of drift. A report is filed only when it
cites a file whose diff or an Output the judgement was shown, and it keeps that file as the
diff named it; one citing only the goal, plan text, a commit or a file it was not shown is dropped
([ADR-0036](adr/0036-a-runs-own-plan-bounds-it.md), amended 2026-10-19).

The evidence is the change since the Run left the default branch, committed or not:
`git diff <base>..HEAD` and `git diff HEAD`, and for the rules the untracked files too. An
[Integration](../CONTEXT.md) left with its conflicts for the builder changes that. Until its
merge commit is made, the worktree has a `MERGE_HEAD`, and `git diff HEAD` would hold every
change the default branch is bringing in. So both the judgement and the rules then read the
Run's side only, `git diff MERGE_HEAD`, which compares the incoming tip with the working
tree; the untracked files are still listed. A work boundary reached in that state is not
judged at all: the Run log says `drift not judged at <where>: an integration's conflicts are
open`, nothing is recorded as skipped, and the rules still run. The finish is judged as
always.

The rule that keeps this honest: **nothing passes on an absence**. A verification nobody
ran is a breach, not a pass. A judgement Collie could not make — no evaluator, a call that
timed out or answered outside its schema — is recorded as `skipped` with the reason, so a
card can say why it says nothing rather than reading as clean. So is a judgement with no
change to judge: where the diff it would read holds no file and the Run has no Output, a
report could cite nothing, so no call is made and the reason is `no change to judge`. A card names each reason
once, however many boundaries it was skipped at, and a judgement that is made later answers
the judgements skipped before it; one that fails afterwards takes nothing back. A skipped rule check is not answered by a judgement. A `claude --help` that
fails or prints nothing is such a reason, said with its exit code and stderr, never read as
a CLI missing every flag, and a `git diff` that fails is a reason too, never an empty
change: a judgement is skipped in git's words. The one exception is a Run with no checkout at
all, such as a plan in a plain directory: its diff is empty and it is judged on its Outputs,
or, with none, skipped in git's words. A rule check git fails is recorded as skipped and
clears no open report: a tree git could not read is not one the work came back from. What
every call cost is written to the Herd's `budget.jsonl` as usage; no count of them is ever
a reason to skip the next.

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
should know about (blocking drift, a correction sent, anyone but the plan moved the Intent,
the run failed or stopped), `try-it` when there is something to look at or a merge request
moved, and `routine` otherwise. A `decision` outranks a `consequential` because a decision is the
human being _waited on_.

The narrative is an input the rule ignores. There is no path by which a model makes its
own work look more important by describing it that way, and nothing that writes a card
takes focus — a card arriving must never move a human off what they are doing.

The implementer writes a **progress checkpoint** per ticket, and the host cards each one
while the agent is still working — a human sees a slice land without waiting an hour for
the whole build. Every piece of agent work also leaves a card when its Output is accepted,
so a ticket's build has one whether or not the agent remembered its checkpoint, and a Run
ends with a `final` card.

The Home board draws them under a task's record, in
[Cards](using.md#what-a-card-says), where the same discipline is on screen: a claim is
prefixed `claimed:` so it can never be read as a pass, `missing` is drawn even when it is
empty, and the narrative is last and dim. The card on the board carries the newest one and
an amber `↯` line for open drift, so there is something to see without opening the record,
and none of it takes focus.

## Correcting drift

`auto_correct` is the one grant every run starts with
([ADR-0037](adr/0037-collie-corrects-by-default.md)), and `run intent authority <run>
auto_correct=false` or a workspace default turns it off. A correction goes at a work boundary,
never as an interrupt, unless `now_allowed` was granted too. Every gate below still applies,
and each one is somebody being deferred to. The attribution gate means that today no run is
corrected without `exclusive_steering`: no harness has proven attribution yet.

- **Somebody typed into that pane.** A manual override stops automatic corrections to that
  agent until `run clear-override`. Collie does not take turns with a human.
- **On a harness with no attribution**, Collie cannot tell its own submissions from a
  person's — so correcting needs `authority.exclusive_steering`, the human saying nobody
  else is steering this run, and the row says `⚠ unattributed` while it is being honoured.
  Claude's attribution is unproven, so that includes Claude: a correction there is sent
  only with `exclusive_steering`.
- **The run is held.** A hold is the human saying stop; a correction is starting something.
- **Something about that constraint is already in the air.** The causal key is the
  constraint, so a second correction waits for the first to settle.
- **The bound is spent.** `max_corrections_per_constraint` (2 by default). After that the
  report is `escalated` and it is the human's.

The text is a **fixed template**, not the model's words — it goes out without anybody
reading it first, so what it can say has to be what the run's authority allows, on by
default and revocable. Its last sentence is the important one: it tells the agent that where the constraint
conflicts with the goal, it should **say so in its Output instead of choosing**. An agent
told only to obey picks one silently, and the conflict is exactly what the human needs to
see.

A correction is `correction_submitted`. Never `corrected`, never `verified`: sending text
is not the work changing. Only new evidence at a later revision settles that, which is why
a re-check of an unchanged tree clears nothing.

## Finishing

A finished run's status is history, so `finish` settles rather than acts:

- One of the run's checks that a `command_exit` rule names and nobody ran is
  run by Collie first — bounded at ten minutes, so a command that hangs cannot hold the
  ending for ever.
- The run's semantic constraints are judged one last time. A run with none makes no
  judgement call: only a semantic constraint can be reported against, and the goal is never
  judged on its own.
- The run gets an **alignment** verdict. `true` is the strong claim and needs everything
  actually checked: every rule passing, every semantic constraint judged against evidence
  that was not truncated, and no open report. A run whose Intent has no constraint, with a
  goal or without one, had nothing judged, so it is `unverified` with the why `nothing was
  judged`. `false` is the other strong claim: something blocking is open. Everything else
  is `unverified`, which is not a hedge — it is the accurate answer when nobody looked, or
  looked at part.
- With a blocking constraint still open, Collie records a **pending proposal** for a
  follow-up child run. It does not start one, and it does not re-prompt anybody.

None of this runs again for a finished Run its agents are later steered on: what a steered
agent does after the Run finished is not re-judged, and no drift correction is sent to it
([ADR-0041](adr/0041-a-finished-run-still-takes-steering.md)).

## Follow-ups

A finished Run's status is never rewritten, and its Workflow is never re-entered. Its
live agents still take steering
([ADR-0041](adr/0041-a-finished-run-still-takes-steering.md)): a `deliver` reaches them
through the Dispatcher with the delivery token, the ledger line and the receipt a running
Run's agent gets, and comes back `applied` only when the text was sent. `answer` is
refused because a finished Run asks nothing; `update_intent` and `clear_override` work as
they do on a running Run; `stop` closes its live agents' panes and leaves the status as it
was; `hold`, `release` and `set_verification` are refused with what to do instead.

A `deliver` whose agent's pane is gone fails and names the route that carries the request
on. Where its outcome needs more work, or its agent is gone, carrying on is one of the
run's own offers ([CLI](cli.md#carry-on-from-a-finished-run)) — a child run of the
workflow it declares, started with `run action <run> <offer>` — or a new Run on its
branch where it offers none. Collie never starts either by itself, and never relaunches a
finished Run's agent.

## Cross-run checks

Related runs — a parent, its children, siblings of one parent, and Runs about one merge
request — are judged against each other's Intents, once per boundary for the whole Herd rather than once per Run. Each
Run with relatives stands for the check at every boundary and at its finish; one wins and
asks the model about all of them, and a loser writes down that it moved, which is what
tells the winner its snapshot is behind — it judges again, a bounded number of times.

The judge is told, as a Run's own judgement is, that plan constraints narrow the goal, and
is given each Run's work beside its constraints, as data to judge: the diff from where
the commit of its newest card left the default branch, read in that Run's own checkout
(its worktree, else the checkout it was placed in), so a Run of another repository shows
its own work, and its Outputs (`<operation>.json` in its agents directory, never the
`.launch.json`, `.mcp.json` or `.settings.json` beside them), under the caps and redaction
above — an Output whose name looks like a credential is named with `<redacted>` — and marked `TRUNCATED` where any of it was cut. Where a Run's work cannot be read
the pack says why and the judgement goes on with what it can read: `work: none yet (no
card)`, `diff: could not be read: <git's first line>` for a commit its checkout does not
have, or `diff: no committed change yet`; its Outputs are shown either way, and the log line
of the judgement names each Run whose diff it could not show. Where no Run has a file of
its diff or an Output to show, the model is not asked: the log says `cross-run judgement
not asked at <when>: no related Run's work can be shown`, and nothing is written down as
owed.

A Run is about a merge request when it recorded it or its goal names it by URL, and it is
related to every Run that recorded the same one, whatever their Task or repository; two
Runs whose goals only name it are not. Each Run's section of the pack also carries the
replies it posted to reviewers (`--- reply to <comment> (fixed|disputed)`), and the judge is
told that a Run whose goal or work contradicts what another replied on their merge request
is drift, reported on the contradicting Run and citing its own work.

A report is kept only when it names a Run in the pack, one of that Run's own constraints,
and cites that Run's work as the pack showed it: a file of its diff or one of its Outputs.
Goal or plan text, a commit alone, or another Run's file is never enough. Collie sets its
kind, id and `evidence_truncated`, never the model. It is filed on the Run it is about: its
drift journal while it is working, and the board's pending reports once it has ended,
since a finished Run's record does not change.
A host with no Herd holds no election, and says so in the log of a Run with relatives.
A check nobody could make is written down as owed by the Run leaving without an answer,
and while one is owed every Run in the Herd stands for it — otherwise an owed check waits
for a Run that may never work again. A Run's final card says `cross_run: pending` while
one about it is owed, and the finish toasts `drift-unresolved` once.

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
