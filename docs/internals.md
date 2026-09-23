# Internals

This is the contributor's page: how Collie is put together, why, and how to work on it.
For the vocabulary, see [`CONTEXT.md`](../CONTEXT.md); for the file map, see
[`src/README.md`](../src/README.md).

## One program, two front doors

Collie is one Effect v4 program. The herdr actions and the `collie` CLI are thin adapters
over the same services, schemas and layers, so every interactive capability is also
available programmatically without a second implementation
([ADR-0003](adr/0003-collie-is-one-effect-program.md)). A capability that exists in only
one front door is a defect, not a design.

The shared middle is `operations.ts` (workspace resolution and run mutations) and
`engine.ts` (tabs, agents, prompts, waits, gates, choices and the fix loop). `collie.ts`
and `commands/` are the CLI adapter; `flows.ts` and `herdr.ts` are the herdr adapter.

## The Driver and the run directory

A run is executed by a **Driver**: a detached process with no pane at all. It writes its
progress and any failure into the run directory and asks its questions through files there,
and the Control Plane is a view over that. A run therefore survives the picker closing, the
Control Plane closing, and the terminal being detached.

One Driver owns a run's authoritative snapshot and consumes Schema-validated commands from
an atomic per-run inbox, watched through Effect's `FileSystem.watch`
([ADR-0004](adr/0004-coordinate-runs-through-the-filesystem.md)). An ownership claim in the
run directory — acquired atomically and carrying the process's identity — says whether a
Driver is still driving, so `resume` never starts a second one and a stop signal never
reaches an unrelated process.

`collie run stop` writes the request into the inbox and, when a Driver owns the run, sends it
SIGTERM. The Effect runtime answers a signal by interrupting the Driver's fibre, so the stop
is recorded in a finaliser: a run still `running` when its Driver is interrupted gets the
`stopped` marker and its finish time written before the ownership claim is released. A
Driver killed outright leaves neither, which is what the Control Plane reports as abandoned.

Every run is recorded under the Collie state directory: `runs/<id>/run.json` with the
inputs and where each came from, `workflow/<name>.json` with the
[definition snapshot](../CONTEXT.md),
`steps/<step>[/<variant>]/` with the exact prompt sent and the output written, `personas/`
with the persona as injected, `review.md` where the run produced one, and `log.txt`. That is
the audit trail and what `resume` reads.

The definition snapshot is what `CONTEXT.md` defines it as: the workflow a run is actually
running, frozen when the run is created. Without it a Driver re-resolves from whatever the layers say
_now_ every time it starts, so editing a workflow changes what a run started yesterday does
on resume — or crashes it, because a record has no step by the new name. What is frozen is
the **resolved** workflow, after `extends:` and `use:`: rebased step ids, merged variant
settings and each step's prompt text as it was resolved. It is written as JSON rather than
re-emitted Markdown precisely because reading Markdown back would resolve it again against
today's files, which is the thing being prevented. The snapshot is a copy inside the run
directory; nothing under the user's or the project's config is ever written.

A run recorded before snapshots existed has `definition: null` and resolves from the layers
as it always did — but only while the steps still match. Where the workflow has since gained,
lost or reordered a step, `resume` refuses with `definition_changed` and writes nothing, and
a Driver that finds the same mismatch stops the run `blocked` with that halt rather than
running a workflow the run never started. Reverting the workflow edit makes it resumable
again.

<!-- prettier-ignore -->
> [!IMPORTANT]
> The run directory is internal mechanics, not an interface. Its layout can change
> without notice. Coordinate with a run through the CLI ([CLI](cli.md)) — `run show`,
> `run wait`, `run answer` — and never by reading or writing run-directory files. Writing
> one directly races the Driver that owns it.

The Driver reads its inbox **during** a step as well as at a question: once per
`awaitAgent` poll, and again at every work boundary before a prompt is composed. That is
what makes steering reach a run that is busy rather than waiting — before this, a command
written while an agent worked sat unread until the next Choice.

What survives a Driver is decided by what the command is addressed to. `deliver`,
`intent_changed` and `drift_report` are about the work, so a new Driver keeps them;
`answer`, `stop`, `hold` and `release` were about the process that is gone, so it drops
them. A `stop` in particular must not survive: a stop written mid-step used to outlive its
Driver and kill the next one at its first question, which made any Workflow that asks a
question unresumable. A command this build cannot decode is logged and left in place —
a newer Collie may know what it is.

A `hold` takes effect at a work boundary, never mid-turn: the Driver declines to start the
next piece of work rather than interrupting anyone. It then loops on the inbox until a
`release` or a `stop`, with `awaiting` set to `hold` so both front doors say so.

Plan artefacts are the same story from the other side: `SPEC.md`, tickets, wayfinder maps
and architecture reports go into the run's `plan/` directory and never into the repository
([ADR-0002](adr/0002-plan-artefacts-live-in-the-run-directory.md)). Glossary and ADR changes
made while planning _are_ written into the repository — those are domain knowledge, not
plans.

A plan can also move while it is being built. A `plan` Step's own rewrite is diffed and
handed to the implementer, but a planner answering a question in its pane and writing the
answer into a ticket is outside any Step of ours. So a Step waiting on an agent re-reads
the plan's `issues/` at the same beat it samples the pane, and sends the acceptance
checkboxes that came and went. The baseline is the Run's, read before the first Step and
moved on only once an agent has actually been told: a `fresh` agent is not told — it
started after the edit and read the new ticket already — so a change during a review is
still news to the `fix` that follows. An unreadable ticket yields nothing rather than an
empty one, since empty would read as requirements deleted.

## A plan proves it can be handed out

The refusals that stop a fan-out — a ticket with no `Repo:` line, a repository nobody
checked out, a number claimed twice, a `Blocked by` line naming something that is not a
ticket, repositories that block each other in a cycle — are read at the step that writes
the tickets, not only when someone picks "Implement now". A `plan` run could otherwise end
`done` with tickets nobody can run, and the human would find out a workflow later from a
hand-off that would not start. A refusal makes the Output unusable, so the planner is asked
once to fix the tickets in the refusal's own words; a second unrunnable set blocks the step.

Two of those rules — a number claimed twice, and a blocker naming no ticket of the plan —
are about the tickets rather than the repositories, so they are checked whatever the plan's
layout. They used to be read only past the single-repository shortcut, which judged the same
plan one way as one repository and another as two, and the order those lines describe is
what a build is sliced along.

## A parent run that fans out

A Choice that chains is normally fire-and-forget: the child gets its own Driver and the
parent finishes. One case is not. When the plan a Choice hands on names several
repositories in its tickets' `Repo:` lines, "Implement now" starts one `implement` run per
repository and the parent stays `running` until the last of them ends
([Plans that span repositories](workflows.md#plans-that-span-repositories) is what that
means for the operator; `Repo run` and `Wave` in [`CONTEXT.md`](../CONTEXT.md) are the
terms).

Three mechanics carry it, and all three are the run directory again rather than anything
new between processes — so this is
[ADR-0004](adr/0004-coordinate-runs-through-the-filesystem.md) applied to a second run
rather than a decision of its own:

- **The record.** `run.json` gains `fanout`: the Choice title that started it, the waves as
  lists of repository paths, the run each repository got, the merge request each of those
  opened, which wave is in flight and which repository stopped it. `src/run.ts` owns the
  shape and the readers of it — `fanoutRepos` is what the board's row, the parent's
  summary, `run show`'s child lines and the resume check all read, so none of them derives
  "this repository was never started" for itself.
- **Waiting.** The engine gets a wait-on-run: watch the child's run directory, re-read its
  record, stop on a terminal status — the same watch-plus-tick shape the Driver's own
  Choice wait uses, for the same reason (an event that never arrives should cost latency,
  not the answer). It has no timeout: a repository run takes as long as its work does, and
  a child whose Driver was killed outright leaves the record `running`, so the parent waits
  until someone stops it. The parent's row says which repository it is waiting on.
- **Stop and resume across two runs.** `run stop` on a parent stops its repository runs
  before itself, and a repository run that will not stop is the whole answer: the parent is
  left alone and the failure names it, because stopping the parent and reporting success
  would say the plan had stopped while one of its runs was still orchestrating agents.
  `run resume` re-enters the fan-out instead of asking the menu again — repositories that
  succeeded are skipped, ones that failed or were stopped are resumed as themselves, and
  the rest start when their blockers are done, so a second attempt opens no second merge
  requests. The guard that refuses to stop or resume a run that has succeeded is lifted for
  a parent only while its fan-out is unfinished; once every repository has ended, a built
  plan is a succeeded run like any other.

A plan the fan-out cannot honestly run is refused when the Choice is picked, before
anything starts: a repository-level cycle, a ticket with no `Repo:` line where its siblings
have one, a `Repo:` that is not a path under the plan's root, one with no checkout there,
two tickets sharing one number, or a "Blocked by" line naming something that is not a
ticket of the plan. That reading is a
pure function in `src/plan.ts` for exactly that reason — the refusals have to be decidable
before a single run exists — and `isSingleRepo` is the same function's answer to "is this a
plan to chain as one run", which is `.` and nothing else.

## Worktrees and the settled rule

`worktree.ts` owns the checkout a mutating run works in. The unit is the **branch**: git
allows exactly one worktree per checked-out branch, so nothing has to invent an identity
for a directory. `git worktree list --porcelain` is the index — it names the repository's
own checkout and every branch that already has one, in one question, whether or not herdr
is running — and `git worktree add` cuts a new one at the path herdr would have used,
`<worktrees.directory>/<repo>/<branch-slug>`. `--input workspace=new` asks herdr instead:
`worktree open` gives an existing checkout its workspace back, `create` cuts a new one.

The run records `worktree.path`, `worktree.branch`, `worktree.managed_by` and
`worktree.created_by_collie`. Its cwd and Driver are that worktree's; its workspace is
the one it was activated from unless herdr opened one for the checkout (ADR-0006).
`startRun` resolves it for a run started here; `chain` resolves it for a chained one,
which is how `plan` and `architecture` get one.

Where herdr does open a workspace — `--input workspace=new`, the path ADR-0006 keeps —
that workspace comes with one numbered shell tab, and `create` may answer with it. The
run records it as `worktree.root_tab_id` and `worktree.root_pane_id`, and that pane is
the run's launch pane: its first agent starts there, so the workspace opens with the
Collie tab and the run's tabs and no bare shell tab beside them.

Both keys are optional, and that is herdr's contract rather than laxity: its schema
describes `worktree_created` twice, once with `tab` and `root_pane` and once without, so
a reply carrying neither is legal and the run simply opens its own tab as it always did.
Requiring them refused the run its checkout over a tab it can do without. `open` never
carries them, because the workspace it reuses is not the run's to rearrange, and a
git-managed checkout opens no workspace at all, so it has none.

A worktree is **settled**, and only then removed, when all four hold:

1. `git status --porcelain` in it is empty;
2. it holds no commit of its own: `git rev-list @{u}..HEAD` is empty where the branch
   has an upstream, and `git rev-list origin/<default>..HEAD` is empty where it does
   not — a branch merged and deleted loses its upstream ref to the next
   `git fetch --prune`, and condition 4's second half would otherwise be unreachable
   in exactly the case it names;
3. nothing is in it: no live agent's pane (its start directory, the directory it has
   moved to, or its workspace), and no run a `resume` could still restart there;
4. its merge request is merged or closed, or its remote branch is gone.

The checks run in that order and the first failure is what the board reports, so a kept
worktree always says which condition kept it — including a round that could not ask
herdr what is live, which reports every candidate as held and records nothing, so the
next refresh asks again instead of standing on a verdict it never reached.

Removal follows the checkout. A git-managed one is `git worktree remove` from the
repository's own checkout, and then the finished runs' recorded tabs whose every pane
sits inside the removed path are closed — dead shells nothing else would ever close, and
a tab a human has since split or reused is left alone. A tab herdr will not close is
counted on the removal line (`· 1 tab(s) left open`), because the checkout has left the
listing by then and no later sweep has a candidate to retry it with.

A checkout herdr has a workspace open on goes through `herdr worktree remove` whoever made
it, and one herdr made whose
workspace a human has since closed is opened again to be removed, rather than taken out
from under herdr — that would leave herdr listing a checkout that is not there.

Once the checkout has gone the entry is a removal whatever happens to the branch — a
branch `git branch -d` refuses is what is left to look at, so the board says which branch
and what git said about it, for as long as a removal is news.

Note what condition 2 does not do on its
own: a checkout with no upstream is still only removed once 3 and 4 hold too, so the
branch has to be gone from the remote — or its merge request merged or closed — before
"holds no commit of its own" removes anything. Never `--force`, never `-D`, whichever
manager removes it: git's refusals are the last guard, so a wrong judgement here can only
fail to clean, never delete work. Only paths some run recorded with `created_by_collie`
are candidates.

There is no daemon and no cron: pruning runs at `run start` and, at most every few
minutes, on the Control Plane's refresh — forked, never awaited, because the board redraws
on every keypress and a sweep walks every due checkout with git and glab. The frame goes
out with what the last sweep said; one sweep runs at a time, and its clock starts when it
finishes. Each
worktree's verdict is also kept for a few minutes in `worktrees.json` in the state
directory, so a due check is the only thing that shells out to git and glab, and the state
file is rewritten only when something moved.

Two things are deliberately not conditions. A `run start` names the checkout it is about
to work in, and that one is held whatever its state, because the run resolving its branch
in a directory that had just been deleted was worse than a late clean-up. Nothing else is
protected: a Control Plane showing a settled worktree removes it and herdr closes that
workspace, which is what a merged branch is supposed to do.

## The herdr boundary

`herdr.ts` is the only channel to the herdr Collie is running inside: the `herdr` CLI at
`HERDR_BIN_PATH` for the commands that have one, and the socket at `HERDR_SOCKET_PATH` for
the rest. Nothing else in the program shells out to `herdr` or opens that socket. That is
what makes the fake herdr in `test/support/` enough to test everything above it.

One thing outside the program does run a herdr binary: `tools/herdr-schema.ts` downloads a
named release and asks it to print its bundled schema. It is the exception the invariant
can afford, because it is not talking to the session — no `HERDR_BIN_PATH`, no socket, no
state, and a binary in a temp directory rather than the one the user is running. There is
nothing above it to fake, and routing it through `herdr.ts` would mean asking the running
herdr what some other version's schema says.

### Checking the boundary against herdr

The reply structs in `herdr.ts` are hand-written, and herdr releases often. `herdr api
schema --json` prints the JSON Schema of the socket API the binary bundles, and the CLI
answers with the same envelope, so that one document describes every reply Collie decodes
and every socket request it sends. `test/herdr-contract.test.ts` walks the structs against
it in the one direction that matters: Collie must accept everything herdr may send, and
extra fields herdr sends are never a failure. `herdr.ts` exports the shapes it decodes as
one `replySchemas` record, and the test asserts its table covers every key of it, so
adding a decoded call without a row turns that test red rather than going unchecked.

The version Collie is verified against is `herdr-pin.json`, with the schema that version
prints committed beside it as `herdr-api-schema.json`, and `min_herdr_version` in
`herdr-plugin.toml` equal to it. The `ci` workflow runs the test against the snapshot
and prove the snapshot is really what the pinned binary prints, so an unrelated merge
request never goes red because herdr released.

The daily `contract` workflow runs `stable` against the newest stable herdr and
`preview` against the newest preview build, which is allowed to fail. Both name
the version and protocol they tested. A red `stable` means the newest herdr moved
something Collie reads: either widen the struct, or — when the field is genuinely gone —
change what reads it. Bumping the pin afterwards is editing the version and checksums in
`herdr-pin.json` and running `bun run contract:regen`. A red `preview` is the same
news weeks early, and nothing to stop for.

It also owns the one fact herdr settles but answers no command about: where a
repository's worktrees go (`worktreesDirectory`, from `[worktrees] directory` in the
`config.toml` herdr is actually reading — `HERDR_CONFIG_PATH` where it names one, herdr's
own default otherwise). Reading that config elsewhere would be a second
channel to herdr, and "where would herdr have put this checkout" has to have one answer
whoever asks — the checkout Collie makes with git is found by herdr's own "open worktree"
UI precisely because it is at that path.

One gotcha the engine works around rather than reports: `tab create --cwd` and
`pane split --cwd` echo the directory back but leave the pane's shell in the workspace
directory (probed against herdr 0.8.2). So every pane the engine opens is `cd`-ed into
`run.record.cwd` explicitly before its agent starts, and that `cd` is what puts a run's
tabs in one workspace and its work in another directory. Keep both: the `--cwd` is
harmless and right if herdr ever honours it, and the `cd` is what actually works.

The second gotcha it works around is submission itself. `agent prompt` writes the text
and an encoded Enter and reports success once both are written — which is not the same as
the agent having read them. A harness whose TUI takes the pane over just after that write
keeps the text in its editor, unsent: probed against pi 0.85.1 under herdr 0.9.0, where
about one launch in three lost the Enter that way and the step then sat silent until its
quiet clock ran out.

So `agentPrompt` answers a `Submission` — what herdr could actually tell us — rather than
nothing. It reads the agent's status first, because only a submission that started from a
settled agent can be told apart from a turn that was already running; then it submits with
herdr's own gate, `--wait --until working --until blocked`. A turn observed after a settled
start is `observed`. A gate that times out, and a prompt to an agent that was already
working, are `unobserved`: the text and the Enter were written, and nothing at this
boundary can say whether the agent took them. The engine records that line against the
variant, because a step that goes quiet later is explained by it.

Settled means a status herdr actually gave — `idle` or `done`. A status it could not
give rules nothing out, so it is treated like a turn already running: no evidence.

`agent_prompt_stalled` is herdr saying it saw no turn come of a settled agent's
submission, and it is the one case with a recovery: one `agent send-keys <agent> enter`.
The Enter, never the text again — re-sending the text would run the step's work twice —
and never to an agent that is no longer settled, because a dialog that came up after the
stall would take that Enter as its answer, which is exactly what herdr refuses to do on a
caller's behalf. A turn seen after that Enter makes it a recovery; nothing seen leaves the
submission `unobserved` rather than failed, because a turn can start and finish inside the
wait and the variant's Output has to be collected either way. A genuinely lost Enter is
what the step's quiet clock is for.

A submission that fails outright — no such agent, a socket that is gone — blocks that one
variant with the reason rather than failing every agent beside it. `unobserved` is never
erased. Every send goes through the Dispatcher, which writes the `submitted` ledger line
with `unobserved` as its note and hands the answer back to the caller: the engine logs it
against the variant, a boundary item composed into that prompt — a hand-off queued through
the receiving Run's inbox among them — inherits the note, `run deliveries` shows it beside
the state, and a compaction request records it, so an unresolved compaction can be told
from one whose request may never have arrived.

Because the submission settles all of this, nothing waits again after it: the engine
watches a prompted agent straight away rather than keeping a readiness wait of its own.

`env.ts` is the plugin environment herdr provides — state directory, config directory,
socket path, plugin root. `HERDR_PLUGIN_ROOT` is what pins the baseline definitions to the
installation the runner came from; the `collie` on PATH is a two-line shim that sets it.
Without the pin the compiled runner falls back to its own installation (`process.execPath`
is the binary when bun runs it from `/$bunfs/`), so a `bin/collie` started from another
directory still finds its workflows and its Driver. Only `bun src/main.ts` in development
falls all the way through to the current directory.

## Definitions and layers

`definitions.ts` owns layer lookup, `extends:` overrides, `use:` embedding and validation;
`yaml.ts` splits frontmatter from the body over Effect's YAML parser and writes a key back
when forking. The merge semantics are canonical there and in
[Authoring](authoring.md#forking) — change both together.

Validation runs before a single tab opens: unknown harnesses, models, efforts and
permissions modes, a permissions mode on a step that continues another step's agent (the
mode is fixed when that agent starts), missing personas and skills, malformed choices,
unknown `extends:` parents, cycles, and placeholders no declared input can fill.
`collie workflow check` is the same validation without a run.

## Trust

`trust.ts` handles a harness's own "may I work in this directory" question, answering it
where that harness looks for the answer rather than driving its dialog. For claude that is a
read-modify-write of `~/.claude.json`, a file claude owns — which is why it is done once per
directory, atomically, and with a backup. What the user sees and how they configure it:
[Using Collie](using.md#trust-the-first-run-in-a-repo).

## Compaction at a work boundary

`compaction.ts` owns one policy and `compactors.ts` the four harness adapters behind it
([ADR-0007](adr/0007-compact-a-reused-agent-at-a-work-boundary.md)). Two places call it,
and they are the only two places a reused agent is given new work: `engine.ts`'s prompt
loop, for a step that keeps an earlier agent, and `handoff.ts`, for a Run handing its
result to another Run's live agent. A liveness nudge and a mid-step recovery message go
through neither, which is why neither is a boundary.

An agent's controls live in `<state>/compaction/<agent>/` rather than in its Run's
directory, because the agent outlives the Run that launched it — the same fact the
registry exists for. That directory holds the control record, the helper the launch
generated, and the telemetry the harness's own interface appends; an unresolved
compaction attempt is on the record, so whichever process reaches that agent next
refuses to dispatch past it. That telemetry is a bounded file independent processes all
write — a status line, a hook, a Driver — so every write takes the file's own lock, and
the cap drops the oldest lines while keeping the session line and the newest few
compaction events. Those are what a waiting Run polls for: a file the cap had taken the
binding out of reads as an agent nothing is known about, and the Run waits out its budget
for an answer that had already arrived. Installation through agent startup holds a per-agent PID
lock outside the controls directory. Cleanup takes the same lock and rechecks `agent
list` before removing controls or stopping an endpoint. A parallel launch therefore
cannot mistake an agent still starting for a stale one; a failed launch releases its
lock, and the existing PID-lock recovery handles a Driver that crashes.

## The registry and sessions

A **session** is one herdr session and one workspace, taken together; a Run's own worktree
does not move it out of the workspace it was started from.
`registry.ts` records which long-lived agents a session still has, per workspace and repo,
so `handoff.ts` can give one run's result to another run's live agent rather than starting
a second one. There is only ever one agent per role in a session, and a session never sees
another workspace's agents — even for the same repo.

Each entry also records an **incarnation**: herdr's own `terminal_id` for the process in
the pane, and the harness session it is driving where herdr knows one. An agent name is
reused by whatever takes that role next and a pane outlives what ran in it, so neither
names a process — which is why a delivery is checked against the incarnation and not
against the name. `verifyIncarnation` requires name, pane and workspace to match as
before, and `terminal_id` (and the recorded `agent_session`) on top.

Each Run also saves that binding on its agent variant and carries it into continuation
steps. Another Run taking the same role must not erase the first Run's identity proof.
If herdr loses the managed name, the Dispatcher can restore it through `agent rename`
only when the pane is unnamed and both the saved terminal and session still match.
It then re-reads the agent list and applies the normal incarnation checks before sending.
Missing session proof, changed identities, and deliberate renames are not recovered by
guessing. A genuinely missing agent still follows the existing fresh-agent resume policy.

An entry from before incarnations decodes as one without the field, and that is
**fail-closed**: it can still be stopped and pruned, but nothing is ever sent to it —
`deliverable` is false and `liveRole` returns null with `no_incarnation`. The alternative
would be a hand-off delivered to whichever agent happens to be in that pane now.

## The Dispatcher

`dispatcher.ts` is the only code that sends text to an agent, and a test reads every
source file to keep it that way. Six callers used to send independently — the next step's
prompt, a repair, a nudge, two hand-offs and a compaction request — none of them aware of
the others, so a hand-off from the board and a nudge from a Driver could land in one pane
in either order.

`Dispatcher.transaction(deps, entry, body)` holds one agent's ledger lock for the whole of
what a caller wants to do with it: it revalidates the incarnation against a fresh
`agent list`, hands `body` a `Channel` bound to that identity, and releases the lock when
`body` returns. A channel used after its transaction closes, or a second transaction for
one agent in one process, is a defect rather than a runtime error — the second would
deadlock on the lock that makes the first safe.

`channel.submit(text, draft)` writes `reserved` **before** it calls herdr and settles it
after: `submitted` where herdr took it, `failed` where herdr refused, `unknown` where the
transport never answered. Those last two are different facts — one is a decision, the
other is nobody knowing — and only `unknown` blocks the same work from going out again
until a human reconciles it. Nothing is ever retried automatically. What blocks a repeat
is the **causal key**, not the text.

Ordering when several messages are due for one agent: `interrupt` before `now` before
`boundary`, and within a mode, correction, steer, step, repair, follow-up, hand-off,
nudge, and a compaction last of all. A compaction goes out only with nothing else in
flight, and it travels on the caller's channel — `atBoundary` takes the channel as an
argument, so the ports never take a lock of their own.

Steering queued for an agent with `mode: boundary` is composed into the **front** of its
next prompt as a `## Steering` section, not queued behind the work: a steer that arrived
after the task text would be read after the thing it was meant to change. Each composed
item is its own delivery with its own id and its own acknowledgement, and its ledger line
names the prompt that carried it.

A hand-off is a delivery like any other, so it goes into the receiving Run's inbox for
that Run's Driver to compose — never straight into the pane. A hand-off to a Run nobody is
driving is refused: there would be nothing to compose it into the agent's next piece of
work, nothing to hold it behind an unresolved compaction, and nothing to record whether it
was understood.

## The Herd and its Home

A **Herd** is one herdr session — every workspace in it — keyed by the canonical path of
its socket. Never by a directory: a cwd would key two sessions in one repository to the
same Herd, and one session across two repositories to different ones. Everything shared
across a session's workspaces lives under `<state>/herd/<herdKey>/`: the conversation, the
proposals, the budget, the elections, and `home.json`.

The **Home** is the one workspace that Herd's board lives in. Ownership is a **record**
Collie wrote plus **proof** that what it names is still what it meant — either a live
`collie_home` token on the workspace, or the recorded pane still carrying the recorded
`terminal_id`. Either proof alone is enough, and the second is what heals an expired
token: the pane Collie opened is still there, so the claim was true and the TTL merely
lapsed.

A **label is never proof**. Two workspaces can be called the same thing, and a home test
reads `home.ts` to keep it that way. A live token with no record is not proof either — it
is a previous Collie's Home or another state directory's, and adopting it silently would
be one Herd taking over another's board.

Anything uncertain is `ownership_unknown` and stops: `collie home show` says what was
recorded, what herdr has, and which candidates there are; `collie home reconcile --adopt`
or `--forget` is how a person settles it. Two things this must never do are creating a
second Home because a token expired, and adopting one because it looks right.

The record is written **before** the pane is opened, so a crash in that window leaves
something attributable rather than a workspace nobody can explain. `server.json` records
the socket, version and protocol at every ensure and logs when they move; no start time
and no pid, because `status server` exposes neither and inventing one would be worse than
re-checking.

The **runtime gate** is a different question from the pinned contract. `herdr-pin.json`
and `test/herdr-contract.test.ts` say what Collie was _built_ against; `home.capabilityGate`
parses the installed binary's own `herdr api schema --json` and requires
`workspace.report_metadata`, `pane.report_metadata`, `workspace.create`,
`WorkspaceInfo.tokens`, `PaneInfo.tokens` and `PaneInfo.terminal_id`. A binary older than
the pin runs this code, and the only honest answer then is `herdr_capability_missing:<name>`
and an exit — there is deliberately no label-only path to fall back to. The schema is asked
for once per process and remembered by binary path: a capability declaration cannot change
while that binary is the one on disk, and it is a quarter of a megabyte down a pipe.

The shortcut writes `origin.json` beside the record — the workspace and directory it was
pressed in, or `filter: "all"` when it was pressed inside the Home — with a 60-second TTL.
The board reads it once at startup for its opening filter. Short on purpose: it exists so
the board opens on the work you came from, and a note from an hour ago says nothing about
the board in front of you.

The board tab and the tab-ordering anchor are separate: `RunCtx.boardTabId` comes from
`ensureHome` and is where a pending question goes — it may be in another workspace
entirely — while `RunCtx.orderAnchorTabId` is a tab in the Run's _own_ workspace: the first
one in that strip any Run of that workspace opened. Conflating them made a Run in one
workspace reorder the tabs of another. The anchor is resolved again while it is still null,
because the first tab Collie opens in a workspace is the anchor for the ones after it; with
no anchor at all nothing is reordered, which is a strip Collie has no business touching.
Only a pending question ever focuses anything, and only under `questions: focus`.

## Steering ledgers

Two append-only journals, both written only by `steering.ts`, both read by deriving state
from their lines rather than by rewriting them:

- `<state>/agents/<incarnation>/deliveries.jsonl` — one line per state change of one
  message to one agent, under a lock per incarnation. `reserved` is written **before**
  herdr is called, so a crash leaves a durable record that something may have been sent;
  `submitted`, `acknowledged` and `verified` are separate facts and are never collapsed.
  A `reserved` line nobody settled becomes `unknown`, which blocks further deliveries
  about the same work until a human reconciles it. Collie never retries out of `unknown`.
  The one retry is out of `deferred`, herdr answering that the pane cannot take a prompt
  yet: that proves nothing arrived, so the same id is reserved and sent again
  ([steering](steering.md#the-states-and-why-they-are-kept-apart)).
- `<state>/herd/<herdKey>/budget.jsonl` — a line before every model call and a settlement
  after it: which Run it was for, how long it took, how many bytes it produced and what the
  CLI said it cost. Usage, never a quota: nothing reads it back to refuse or throttle a
  call, and a reservation nobody settled is written down as a failure so the count is
  honest. Lines from before spending caps were dropped carry a `max_usd` that decides
  nothing. The **Herd** is one herdr session, keyed by the canonical path of its socket,
  never by a directory.

What blocks a second delivery is the **causal key** — the run, the cause and the Intent
version — not the text. Two corrections for one constraint are the same work in different
words, and a nudge and a re-sent prompt are different work in the same words.

## Build and release

The runner is TypeScript compiled by `bun build --compile`, one binary per platform, built
in CI on tag and downloaded from the GitHub release by `install.sh`
([ADR-0001](adr/0001-compiled-runner-fetched-from-release.md)). Workflow and persona
definitions stay plain files in the repo and never require a rebuild.

`install.sh` authenticates that download with `COLLIE_TOKEN` where it is set, and otherwise
borrows the token `glab` or `gh` already holds for the release host — see
[Using Collie](using.md#install). A private project answers an unauthenticated download
with a sign-in page and HTTP 200, so the install checks the first bytes for an ELF or
Mach-O header instead of trusting `curl -f`.

`bun run build` compiles beside the binary and renames over it, because replacing a running
runner's own file kills the process executing it. In a git checkout `install.sh` builds from
source rather than fetching a release, because that machine's own source is what a release
is cut from.

## Working on Collie

**Bun 1.4 or newer** — `engines` in `package.json`, `.mise.toml` and the workflows under `.github/` all say
so. The runner is compiled by bun and the tests are `bun:test`, so the version is a
prerequisite rather than a preference.

```sh
bun install
bun run check          # formatting, lint, types, then the full test suite
bun run build          # bin/collie for this platform
bun run smoke          # bin/collie answers --help and returns typed envelopes
```

`bun run build && bun run smoke` is the pairing to run before touching anything on the
release or install path: the build alone does not prove the compiled binary still starts.

Tests live in `test/`, with a fake herdr and shared fixtures under `test/support/`. Because
`herdr.ts` is the only boundary, an end-to-end test drives the real engine against that
fake.

`check` runs formatting, lint, and type checking in parallel, then tests after all three
pass. Keeping those phases separate avoids CPU contention with the subprocess-heavy tests.
The individual scripts in `package.json` still work for focused feedback.

`bun run test` uses [Bun's process-parallel runner](https://bun.com/docs/test/parallel)
with four workers and a fresh global per file. Tests within each file stay sequential:
fixtures change environment variables and prototypes, so `--concurrent` is not safe here.
For debugging, `bun test ./test/engine-e2e.test.ts` runs one file without workers.

Bun records file durations in `.scratch/test-timings.json` and uses them to schedule slow
files first next time. CI caches only that scheduling data, never test results. Missing or
stale timings cannot skip a test; delete the file to reset the schedule. Quiet-agent tests
use a controlled Effect clock so machine load cannot consume their nudge windows.

On the initial 377-test baseline (`fb2d018`), with Linux and Bun 1.4.2, the original checks
took about 96 seconds (90 in tests); the new
gate took about 51 seconds without timing history. Four-worker tests with history took
about 39 seconds, or 43 seconds for the whole gate. Eight workers and running static checks
alongside tests were rejected:
both caused subprocess tests to exceed their existing timeouts. Limiting Oxlint/Oxfmt
threads did not show a consistent improvement, so their defaults and rules stay unchanged.

Documentation changes in the same merge request as the behavior it describes. There is no
docs lint to catch a page that fell behind — a stale page is a defect like any other.
