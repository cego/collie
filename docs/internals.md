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

The shared middle is `operations.ts` (workspace resolution and run mutations),
`lifecycle.ts` (what a front door asks the host), `host.ts` (the host and its RPC) and
`engine.ts` (the workflow engine: the registry, recovery, and the SDK a module is served).
`collie.ts` and `commands/` are the CLI adapter; `flows.ts` and `herdr.ts` are the herdr
adapter.

## The host and the run directory

Work runs in one background **host** per state directory
([ADR-0015](adr/0015-one-local-host-owns-a-state-directory.md)): `collie host --dir
<state>`, started by the first client that needs it and owned under `host.lock`. The CLI,
the board and chat reach it over Effect RPC on `host.sock`, so a Run survives the picker
closing, the board closing and the terminal being detached, and a client of another build
is told to run `collie host restart` rather than served. That command, and the herdr action
beside it, is the same stop a newer client uses followed by an ordinary start, so what the
old host was running is the new one's startup recovery and nothing else. A host stops by itself once its lock is
gone with the state directory it was in — there is nothing left for it to serve, even if its
socket makes the directory again — or once the process named in `COLLIE_HOST_WATCH_PID`,
where one is, has exited.

A stopped host gives its running steps a grace (`COLLIE_HOST_STOP_GRACE`, five seconds) and
then exits whatever is left, letting go of its lock: upstream's shutdown waits on each
step, and one that never yields kept an old host past every client that tried to replace
it. The grace bounds every end of a host: a stop signal, its lock or state directory gone,
or the process named in `COLLIE_HOST_WATCH_PID` exited. `host.log` names which it was. A
check the host is running is ended first, not waited for: its processes get SIGTERM at once
and SIGKILL in the grace's last fifth, and `host.log` names each one. A look at `/proc` for
a check's marked processes can take seconds on a loaded machine, so the host waits past its
grace for that SIGKILL and the last look after it, at most three seconds (`KILL_CEILING`),
before the lock goes. Three seconds holds one slow look and keeps the exit, with its log
flush, inside the five seconds a client gives a stopping host before it kills it. Its step does not complete
and nothing is recorded for it, so the next host runs it once more.

The one exception is a replacement by a newer build of the same installation: a newer client,
or `collie host restart` from one. Before it signals the host, the client writes
`host.handover` naming the host's pid and its own build. A host signalled while that names
it, and a build newer than its own, hands its supervised checks over rather than ending
them: it stops collecting them, leaves their processes and records alone, and writes
`host.handed-over` naming itself, by pid and start token, the build and the checks before it
lets go of its lock. It still ends any check it cannot hand over, such as a measurement's.
Every other end ends them as above: a plain stop signal, a lost lock or directory, a watched
process gone, a crash, and a restart onto the same build. A newer client that
asked a host to stop kills it five seconds after its grace. A host that does not say who it
is within five seconds is replaced too when `host.build`, which it writes as it starts,
names an older build of the same installation; otherwise the client reports it as
`HostUnavailable` with its pid. That host is asked for the same handover before it is
signalled: one too slow to answer still hears its signal and hands its checks over, and one
that never hears it is killed and hands over nothing.

Desktop starts a host the way any client does: it runs `collie bridge --as desktop` (or
`--as chat`), and the bridge starts `collie host --dir <state>` where none answers. Desktop
starts the bridge, and every other child, in `$HOME` (`CHILD_CWD` in
`desktop/src/bun/login-env.ts`), because its own `app/bin` folder is deleted when an update
replaces it. A client starts the host in its state directory, and the host `chdir`s there
itself as it starts, so a host started from any directory outlives that directory: one
left in a deleted directory could not start `claude`, `git` or Bun's shell. Neither can begin
in a directory already deleted — a compiled Bun program refuses to start there — which is
why each is started somewhere that lasts. Electrobun's
launcher variables (`ELECTROBUN_*` and CEF's `LD_PRELOAD`) are stripped from what Desktop
gives a child, again from what a client gives a host, and from the host's own environment
as it starts (`withoutLauncher` and `leaveLauncher` in `src/env.ts`), so neither the host
nor anything it starts preloads CEF. Without Desktop's `bin` to match, a host keeps
`LD_LIBRARY_PATH` and `ICU_DATA`.

The host writes what it does to `host.log` in its state directory — its start, a stop and
whether the grace ran out, every warning the engine and the registry log, and a board build
or an RPC answer that took over 2 s, with which RPC and how long it took. A write that
fails and leaves part of a Run's record missing (its final card, frozen checks, intent seed
or oversight audit), or that leaves the host's shutdown or pairing unfinished, is an Error
line with its cause; the Run carries on as it would have. A failed dial-back from a paired
Machine, or a failed line in a Run's own log, is a warning. A cleanup listing
or sweep over 2 s in all, counting the time spent gathering what its sweepers judge, also
says that time and how long each kind took to judge, slowest first:
`the cleanup listing took 4000 ms; gathering took 500 ms; judging took task 3000 ms, worktree 500 ms`. A stream, such as
the board's or a record's `runDetail`, is meant to stay open, so only its first value is timed:
one that took over 2 s is logged as `the runDetail stream took 4900 ms to send its first value`,
or `the door's runDetail stream took …` for a record the door's thread sent. Lines are flushed
every 100 ms, so a host killed outright can lose its last few. Past 1 MiB the file starts
again and the previous one is kept as `host.log.1`. Look there first when a host stops
answering. What a host started by a client writes to its stdout and stderr, a stack trace
the log never saw among it, is in `host.out`: the client starts it through `/bin/sh`, which
opens that file for appending and `exec`s the host with its pid. The host keeps it to 1 MiB
by copying it to `host.out.1` and emptying it in place, checked each minute and at each
start, since renaming a file the process still writes to would not move its writes.

### Tracing the host

A host makes no spans unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, since making them was most
of what an idle host allocated. When it is set, the host sends its spans and logs as OTLP/JSON
to that base URL, under the service `collie-host`. It sends only spans that took at least
`COLLIE_TRACE_MIN_MS` (5 ms by default). A busy host makes thousands of sub-millisecond file
reads a second, and that many spans stalled the exporter within a minute. A span's parent
always lasts at least as long as the span, so every span sent arrives with its parents. Every `Effect.fn` name becomes a span, for
example `Board.build`, `Engine.viewOf` and each RPC, so a trace shows where a slow board build
or a slow answer spends its time, on the live host and without a benchmark.
[motel](https://github.com/kitlangton/motel) is a local OTLP store that serves this. Run it from
a clone with `bun install && bun src/motel.ts daemon`, which listens on `127.0.0.1:27686`. Then
restart the host with the variable set:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:27686 collie host restart
```

Read the spans with `bun src/motel.ts trace-stats operation count collie-host`, or with
`search-traces` or the TUI. A host started any other way, such as by a client or by
`collie upgrade`, starts without the variable and so stops tracing. Spans cost time of their
own, so compare durations within one trace rather than against an untraced host.

A workflow is a TypeScript module, and the host runs it on Effect's own engine
([ADR-0014](adr/0014-native-workflows-run-on-effects-own-engine.md)): a
`ClusterWorkflowEngine` over a `SingleRunner`, with execution state in `host.db`, a Bun
SQLite file. The registry in `engine.ts` loads a module into a generation of its own
(`<id>@<n>`), admits a start under its request id and hands it to the engine; the store in
`store.ts` keeps what Collie adds to a Run — its Task, project, entry, input and where each
value came from, its options, its decisions and its receipts. The request id is the claim:
the same request twice is one Run, and a Run recorded and not yet handed to the engine is
handed over when the host starts again ([ADR-0017](adr/0017-one-request-is-one-run.md)).
A Task is a row of `collie_tasks` in the same file, looked up by id or by workspace and
written only by the host
([ADR-draft-collies-own-records-live-in-the-hosts-database](adr/draft-collies-own-records-live-in-the-hosts-database.md)):
a start with `--here` sends the workspace it was given from, and the host keeps the Run in
the Task already kept there or makes one. Other processes list Tasks through the host's
`tasks` request. Each write tells the Run model which Task moved and invalidates the Tasks'
Reactivity key, which the board follows. The first host on a state directory imports every
`tasks/<id>.json` once and leaves the files in place.
A starting host registers every saved generation before a Run it recovers looks one up, so a
parent resumed in the swap reads a child of any generation.

Once it answers, a starting host ends every check a previous host left running in its
state directory: one recorded under `running-checks/`, or a process marked with this
installation's id. A host that has just made that id looks for none, since no process can
carry it. Each gets SIGTERM, then SIGKILL two seconds later, and is never adopted unless it
was handed over. The Run's log and `host.log` name the check and the host that left it, and
the step that ran it runs it once more.

Before that, a host of the build `host.handed-over` names takes over each check listed there
whose record names the host that wrote it, and whose supervisor is still that record's, by
pid and start token, or has written its exit status. It takes the record as its own and says
`took over check` in `host.log`. The replayed step that ran a gate's check asks for the same
check, by its Run, name, pass and command, and gets the one taken over instead of starting
another. An agent's check is finished by the host itself once it exits, and the agent's
`collie verify`, whose stream broke with the old host, asks the new one for that
Verification by the check's id (`verifyFollow`), whatever its build. Nothing else is taken
over: a host of any other build, or one that finds no `host.handed-over`, ends them all. No check of a Run starts while one a previous host left of that Run is
still running: one that survives SIGKILL is ended again a second later, and named again,
until it is gone.

What a check's Verification is finished from is written to `check-output/<id>.json`
before it is spawned: which check of which Run, the command as resolved, the tree it
started on, when, what it expects and where its evidence goes. A host runs the command under
a supervisor, `collie supervise-check` (`src/check-supervisor.ts`), which is the host's
child, leads the check's process group outside the host's, and carries the check's markers,
as the command does. Its record names the supervisor as the leader, so a stop, `stillRuns`
and the sweep end both. Once it has spawned the command, the supervisor writes the
command's own pid to `check-output/<id>.pid`, the one `collie verify` says it started as. The supervisor holds the command's pipes and reads both to their end,
including a child that left the group and still holds one; it writes the check's log in the
order the two streams arrived, relays both to the host for a watching client, and keeps the
last 16 KiB of each. Once both close and the command has exited, it writes them to
`check-output/<id>.stdout` and `.stderr`, then the exit status to `<id>.exit`. A host that
goes leaves it writing: those three files answer each reason a host could not take over a
check it did not start, which are that its output went to the old host's pipe, that only a
parent reads an exit status, and that its starting tree was in the old host's memory, where
`<id>.json` now keeps it. The host that ran it finishes it from what it kept; another host
finishes it from those files. They go with its record, `running-checks/<id>.json`.

Recovery re-enters the module as it is now. Completed Activities are reused, a question
already asked is still asked, and an agent already launched is reattached to. There is no
frozen copy of the workflow: an unchanged one resumes where it was, one edited out of shape
has no seamless-resume promise, and one whose module is missing waits, naming the file,
until it is put back ([ADR-0016](adr/0016-a-workflow-module-is-found-where-it-was-saved.md),
[ADR-0029](adr/0029-one-host-acts-for-a-run-and-a-workflows-name-decides-nothing.md)).

A human's controls are the host's to settle, whichever door they come in by
([ADR-0021](adr/0021-one-host-answers-for-a-run.md)). A hold is a flag the Run reads as a
plain Effect at its next boundary and suspends on; release clears it and resumes. A stop is
read inside the Activity that waits on an agent and suspends that Activity's own instance,
so a resume reattaches to the launch already recorded. A Run that cannot go on by itself — a
pane that will not take a prompt, a check that still fails, or none named, after its gate fixes, a workspace closed with its
checkout gone — parks with the reason and the repair, and `run resume` picks it up.

Beside the database, a Run's files are its audit trail: `agents/<run>/<operation>.prompt.md`
with the Output it came back with, `evidence/<run>/` with its checks
and the ones collected, and `runs/<run>/` with its cards, its `plan/`, the review it left and the notes its agents
handed on in `handoffs/`, which the shipped workflows tell them to write there rather than in
`/tmp` and which `run show` and the Run's record list. `handoffs/` is made when the Run is
placed, before any agent of it starts, and a Claude Code agent is started with
`--add-dir <run dir>`, so its MCP servers count the Run's directory among the session's
roots and may write there. They are the Run's, so they go only when it does.
Nothing an older Collie recorded is read ([ADR-0027](adr/0027-one-engine-and-a-hard-cutover.md)),
and the host's cleanup sweep removes it once it has not changed for a day.

None of it is kept for ever ([ADR-0045](adr/0045-collie-removes-what-it-made-once-nothing-needs-it.md)
D5). A Task and every one of its Runs are forgotten together once the Task is Finished, no
workspace of it is open, no agent it launched is alive, no checkout it made is on disk, no
Run outside it names one of its Runs as parent or points an input into one of its run
directories, and its last Run ended more than 30 days ago — the board's finish time, else the
newest of its files. The rows go first, in one transaction under the Task's lock: each
execution's messages and replies, through `MessageStorage.clearAddress`, then its decisions
and its `collie_runs` row; a row the engine never accepted is left for recovery. Then its
`runs/`, `agents/` and `evidence/` directories, its markers, the steering ledgers that name
only its Runs, and the Task's record. A file a failure leaves behind has no row any more,
and the next sweep's no-row rule removes it.

<!-- prettier-ignore -->
> [!IMPORTANT]
> The run directory is internal mechanics, not an interface. Its layout can change
> without notice. Coordinate with a run through the CLI ([CLI](cli.md)) — `run show`,
> `run wait`, `run answer` — and never by reading or writing run-directory files.

Plan artefacts are the same story from the other side: `SPEC.md`, tickets, wayfinder maps
and architecture reports go into the run's `plan/` directory and never into the repository
([ADR-0002](adr/0002-plan-artefacts-live-in-the-run-directory.md)). Glossary and ADR changes
made while planning _are_ written into the repository — those are domain knowledge, not
plans. A new ADR is written as a draft named by its slug and numbered when its branch lands
([Numbering a branch's ADRs](#numbering-a-branchs-adrs)).

A plan can also move while it is being built. `implement` reads its tickets by name each
time it reaches its list, so a ticket edited since is built as it reads now and a completed
one is not built again
([ADR-0024](adr/0024-a-list-of-work-is-known-by-its-names.md)).

### Waiting for memory

Three starts wait while their Machine is Short of memory, all through `waitForMemory` in
`src/memory-wait.ts`
([ADR-draft-new-work-waits-while-its-machine-is-short-of-memory](adr/draft-new-work-waits-while-its-machine-is-short-of-memory.md)):
an agent's launch, in `launch` in `src/agents.ts` before it lists, opens a tab or asks
herdr to start anything; a Check pass, in the engine's `check` once no earlier pass is
relied on and before the checkout moves; and `collie verify`, in the host's `verify`
handler, so the CLI and the agent's tool wait alike. The reading is `src/memory.ts`'s,
taken with `memory_hold` fresh at the start and every 15 seconds after. While it waits, a
start keeps a file in its run directory's `memory-waits/` naming what waits, its sentence,
when it began, when it last read the Machine and, for an agent's verify, that agent. The
board, the drawer, `collie run show` and `collie_run` read the oldest one through
`memoryWaitOf`, a card reading those of every Run it shows, and an agent's Output budget
does not run while one names it (`holdsBudgetOf`). A file not read again for three periods
was left by a host that died, and is not read. Each start passes its Run's stop file to
the wait, which reads it again as memory frees: a stop during the wait, or as it ends,
ends it with nothing started.
The chats' agents start elsewhere, and never wait.

## A workflow made of workflows

`child({ runId, invocation, workflow, input })` starts another workflow as part of a Run
([ADR-0022](adr/0022-a-workflow-is-made-of-workflows.md)). The workflow id is resolved in
the parent's own project, through the same search path a front door uses; the child's
schema decodes the input before a row exists; and the invocation name is the child's
identity, so a replayed parent gets the child it already has. The parent writes its child's
row as accepted and dispatches it itself.

Fan-out is a loop in a module. `readPlanRepos` reads a plan's `Repo:` and `Blocked by` lines
into waves, or refuses the whole plan before any child exists: a repository-level cycle, a
ticket with no `Repo:` line where its siblings have one, a `Repo:` that is not a path under
the root or has no checkout there, two tickets sharing one number, or a `Blocked by` line
naming no ticket of the plan. It is a pure function in `src/plan.ts` for that reason — the
refusals are decidable before a single Run exists.

## Schedules on the host's engine

A [Schedule](using.md#schedules) is fired by the engine every Run runs on, with no polling
of Collie's own ([ADR-0052](adr/0052-a-schedule-is-a-saved-start-its-host-fires.md)).
`src/schedules.ts` registers one workflow of the host's own, `Schedule`, beside the
modules' generations. It is not a module and not a Run, and the board never shows it. One
execution is one occurrence, keyed by the Schedule's name, its epoch — the request id of the
add or resume that began the chain — and the occurrence:

1. `DurableClock.sleep` until the occurrence, with `inMemoryThreshold` zero, so every
   wake-up is the persisted clock message and outlives the host.
2. An Activity reads the Schedule and decides, through `onWake` in `src/schedule-model.ts`:
   paused, removed or under another epoch ends the execution; otherwise it starts the latest
   occurrence due, so a clock delivered late starts one Run for all it missed.
3. An Activity waits for herdr to answer, each minute, then starts the Run through the
   registry's own start, as a fresh start is placed, under `schedule:<name>:<occurrence>`
   and the Actor `schedule`. It is admitted with `handsOver`: the receipt is written, and
   the engine is not handed the Run.
4. The execution runs that Run on its own fiber with `result`, as `children.result` runs a
   child, so the Run's end is what wakes it. The Run has its own Task and no parent row.
5. An Activity records the occurrence and what became of it, works out the next one with
   `nextOccurrence` — one that fell meanwhile at once, else the next cron time — starts that
   execution with `discard`, and forgets what the engine kept of the execution before this
   one, as forgetting a Run does.

Nothing interrupts a Schedule's execution, because the interrupt would reach its Run.
Pausing and removing only write the Schedule, and a waiting execution ends itself when it
wakes. A resume begins a new epoch; where the old chain is still waiting for its Run, the
resume leaves it the record's `running`, and that chain starts the new epoch's first
occurrence when its Run ends, with no catch-up. A host that starts asks the engine for each
active Schedule's pending execution again, with `discard`; its key makes that a no-op
unless the engine lost it.

Each Schedule is `schedules/<name>/schedule.json` in the state directory — its start, cron
expression and time zone, paused, epoch, pending occurrence, last occurrence and the Run it
last started — beside `operations.jsonl`, the trail of each change and each occurrence with
its Actor. Only the host writes either, and cleanup keeps `schedules/`. A test host given
`COLLIE_HOST_SCHEDULE_SECONDS=1` takes a sixth, seconds field in a cron expression and reads
the engine's storage each second (`entityMessagePollInterval`), so its tests wait seconds,
not minutes; every other host refuses six fields.

## Worktrees and the settled rule

`worktree.ts` owns the checkout a mutating run works in. The unit is the **branch**: git
allows exactly one worktree per checked-out branch, so nothing has to invent an identity
for a directory. `git worktree list --porcelain` is the index — it names the repository's
own checkout and every branch that already has one, in one question, whether or not herdr
is running — and `git worktree add` cuts a new one at the path herdr would have used,
`<worktrees.directory>/<repo>/<branch-slug>`. `--input workspace=new` asks herdr instead:
`worktree open` gives an existing checkout its workspace back, `create` cuts a new one.

The run records `worktree.path`, `worktree.branch`, `worktree.managed_by` and
`worktree.created_by_collie` in its row's `checkout`, beside the directory it works in.
Its agents work in that worktree; its workspace is its Task's unless herdr opened one for
the checkout (ADR-0006). `placeRun` in `engine.ts` resolves it at admission, for a start
and a child alike, from the `checkout` the module declares and the `workspace` option
decoded into a request — which is how the `implement` that `plan` or `architecture`
chains into gets one, and why neither of them passes it anything about where to work.

Where herdr does open a workspace — `--input workspace=new`, the path ADR-0006 keeps —
that workspace comes with one numbered shell tab, and `create` may answer with it. The
run records it as `worktree.root_tab_id` and `worktree.root_pane_id`, and leaves it where
it is: the run's agents open tabs of their own, as they do in a Task's workspace.

Both keys are optional, and that is herdr's contract rather than laxity: its schema
describes `worktree_created` twice, once with `tab` and `root_pane` and once without, so
a reply carrying neither is legal and the run simply opens its own tab as it always did.
Requiring them refused the run its checkout over a tab it can do without. `open` never
carries them, because the workspace it reuses is not the run's to rearrange, and a
git-managed checkout opens no workspace at all, so it has none.

A worktree is **settled**, and only then removed, when all five hold
([ADR-0045](adr/0045-collie-removes-what-it-made-once-nothing-needs-it.md) D4):

1. `git status --porcelain` in it is empty;
2. it holds no commit of its own: `git rev-list HEAD --not --remotes=<remote>` is empty,
   where `<remote>` is its upstream's remote, or every remote where it tracks none — never
   a hard-coded `origin`. A branch merged and deleted loses its own ref to the next
   `git fetch --prune`, and the default branch's ref still holds its commits. Where
   commits remain, HEAD being the head its merged merge request was merged at, as the
   merge watch recorded it, counts as pushed: a squash merge leaves the branch's commits
   on no branch at all;
3. nothing is in it: no live agent's pane (its start directory, the directory it has
   moved to, or its workspace) other than the idle agents of the runs that finished there,
   no run still going there, and no stopped or failed run a resume would carry on there
   while its work has not landed — except that a failed run does not keep any of its
   repository's roaming checkouts, which the next roaming start would take over anyway, and
   the idle agents of the runs that finished or failed inside one hold it no more than
   their own run would;
4. its work has landed: no Task whose Runs used it still owes anything on it, as the
   board derives it (**Landed** in `CONTEXT.md`), and the merge watch read its merge
   request as merged or closed, on GitHub or GitLab (`board/mr-states.json`), the board
   says what settled it, or, with neither, its branch is gone from the remote; an open
   merge request keeps it, and a board that could not be built leaves only the remote
   branch to go by;
5. its Task's workspace has closed — by cleanup or by a human — so a checkout never goes
   from under a workspace someone is looking at.

A checkout Collie made whose branch was switched since is still a candidate, by its path
and the moment git wrote its `.git`, and is judged on what it holds now; `git branch -d`
then runs on the branch it now has. The plugin root and any repository's main checkout
(whose `.git` is a directory) are never candidates, whatever a record says.

The checks run in that order and the first failure is what the board reports, so a kept
worktree always says which condition kept it — including a round that could not ask
herdr what is live, which reports every candidate as held and records nothing, so the
next refresh asks again instead of standing on a verdict it never reached.

Removal follows the checkout. A git-managed one is `git worktree remove` from the
repository's own checkout, and then the tabs of the panes the finished runs' agents were
registered in, where every pane of the tab sits inside the removed path, are closed — dead shells nothing else would ever close, and
a tab a human has since split or reused is left alone. A finished Run's agent still in such a
tab is ended through `endAgent` first, and its tab is kept where it is not Quiet. A tab herdr will not close is
counted on the removal line (`· 1 tab(s) left open`), because the checkout has left the
listing by then and no later sweep has a candidate to retry it with.

A checkout herdr has a workspace open on goes through `herdr worktree remove` whoever made
it, and one herdr made whose
workspace a human has since closed is opened again to be removed, rather than taken out
from under herdr — that would leave herdr listing a checkout that is not there.

Once the checkout has gone the entry is a removal whatever happens to the branch — a
branch `git branch -d` refuses is what is left to look at, so the board says which branch
and what git said about it, for as long as a removal is news.

Note what condition 2 does not do on its own: a checkout is still only removed once 3, 4
and 5 hold too. Never `--force`, never `-D`, whichever
manager removes it: git's refusals are the last guard, so a wrong judgement here can only
fail to clean, never delete work. Only paths some run recorded with `created_by_collie`
are candidates.

Pruning is the worktree kind of the host's cleanup sweep (`src/cleanup.ts`), which runs
every ten minutes beside its merge watch and News, so it happens with no pane open. A
sweep judges every candidate without removing anything, then removes each settled one
after judging it again on its own. A board shows what the last sweep said, read from
`worktrees.json`, and never sweeps itself. One sweep runs at a time, and its clock starts
when it finishes. `worktrees.json` is rewritten only when something moved.

A Renovate clone under `renovate-repositories/` is its own kind of the same sweep: it goes
once no Run with a row cut a checkout from it and no checkout cut from it is left on disk.
Each use of such a clone, new or kept, gives it the forge's credential helper (see
[The forge boundary](#the-forge-boundary)), so a clone made before the helper existed gets
it on its next Run, and the checkouts cut from it share it.

Two things are deliberately not conditions. A `run start` names the checkout it is about
to work in, and that one is held whatever its state, because the run resolving its branch
in a directory that had just been deleted was worse than a late clean-up. Nothing else is
protected: a Control Plane showing a settled worktree removes it and herdr closes that
workspace, which is what a merged branch is supposed to do.

## Reaching another Machine

An agent-requested Run tells its requesting host twice over the paired link: at admission
and at settlement, beside its outcome report. The `linkNotice` call validates the sending
Machine and the requesting Run's agent, and records each request once on that Run. The
Flow hangs the link under the Step whose launch made the start and keeps that placement
when settlement arrives. Settlement takes precedence over an admission delivered late.
The started Run records each try's result in `linkNotices`, shown by `collie run show`,
and keeps each notice as first sent in `link-notices.jsonl`. Each time a paired Machine's
link comes up, `onLink` tells the reports layer. While that link stays up and anything is
still owed to the Machine, every five seconds it asks the Machine's host for its identity
and, once that answers, sends again every undelivered notice to it, unchanged and under
its request id, and every report that did not reach it (`unreached`: the Machine or its
host was not reached, as opposed to a host that refused). A report still being written or
closed waits for the next round. The receiver's `once` makes a repeat change nothing.
Nothing polls a Machine whose link is down. On one host, the Flow reads the requested Run's current facts
directly, and its link's `asOf` is null.

Run records are served by their owning host through `run-record.ts`. Intent changes,
remembered checks and override clearing take the caller's Actor and request id there;
verification runs in that host's checkout and streams its output. `verify-model.ts`
keeps the shared Schemas separate from the collector.
Once the owning host is found, its operation refusal is returned to the caller; it
does not become a search for the Run on another Machine.
The paste budget is measured on the same rendered token and sender line the Dispatcher
types, so a message is kept whole as a file rather than typed past it
([steering](steering.md#the-paste-budget)).

Each host keeps its peers in `src/peers.ts`, started in the host's scope
([ADR-0057](adr/0057-a-machine-reaches-another-over-a-paired-link.md)):

- **The pairings,** in `peers.json` in the state directory (0600): each peer's
  installation, name (herdr's label), which side dials, and for a peer this one dials its
  `url`, its `certificate` and the `secret`.
  Repeated invitations for the same installation reuse its inbound secret, so concurrent
  first reaches agree even when their replies arrive out of order. The listener keeps
  its original certificate across address aliases as the dialler's only CA. An alias
  missing from the original certificate gets a listener certificate signed by that
  original pin, retaining earlier aliases and normal TLS hostname verification.
  A repeated opposite invitation preserves an established outgoing link and tells the
  asker to keep the incoming direction. When both Machines first pair at once, the higher installation id keeps the outgoing
  record and the lower one the incoming record, so one listener and matching credentials remain.
- **A relay socket per peer,** `peers/<name>.sock`. A client writes one
  header line, `{"as": <front door>, "client": <name>}`, and is answered with one line —
  `{"ok":true}`, or why not (`refused`, or `unreachable` with what was seen, and `waits`
  where the link waits on an SSH connection) — then speaks
  the host protocol. Behind it the relay opens a fresh WebSocket to the peer's `/channel`,
  pinning the peer's certificate as the only CA and sending the secret as a bearer, and
  pipes bytes. `as: "host"` is taken only with the relay's own host's stamp.
- **The listener,** on `0.0.0.0:47217` (`COLLIE_PEER_PORT` for a test), only while a peer
  that dials in is paired. `COLLIE_PEER_PORT=0` binds whatever port is free the first time
  and that same port every later time, by any host of the state directory (it is kept in
  `peer-port` there), and an invitation answers it: the test rig's way to
  a port no other process can take between its choice and the listen. It finds the
  installation a bearer was minted for, and declares the channel on a fresh `host.sock`
  connection as `{frontDoor: as, from: {machine, client}}` with the host's per-process
  stamp, which is what lets `from.machine` through `declare`: a channel that sets it without
  the stamp is refused.

**Dial-back.** The dialling host keeps `/control` open, with the pinned certificate and
bearer. The listener keeps one control link per installation; a newer one replaces it.
When a client opens a relay toward an undialable peer, the listener sends `{dial, as,
client}` over its control link. The peer opens `/reverse?ticket=<dial>`, then declares
the channel into its own host with the listener's authenticated Machine identity.
Tickets belong to one installation, expire after ten seconds and can be used only once.
Both relay directions refuse with `MachineUnreachable` within five seconds.

**The way to a dialled peer.** Every socket the dialler opens, its `/control`, each
`/channel` and each `/reverse`, opens through `openPeer` in `src/peer-transport.ts`
(ADR-draft-a-blocked-link-rides-the-machines-ssh-connection). Without a way given, it tries
direct, to `<url><path>`, bounded to five seconds; only where that fails, it asks the
Machine's SSH connection to forward a free loopback port to the peer's `127.0.0.1:<port>`
and dials `wss://127.0.0.1:<local><path>` with the same pinned certificate, whose names
carry `127.0.0.1`, and the same secret. The forward belongs to the socket's scope, so
whatever ends the socket cancels it. Where no connection is open, the failure says so,
names `collie machine connect`, and carries `waits: "ssh_connection"`; the dialler keeps
that in its standing for `machine list`. While a control link is up, its channels and
dial-backs go its way; while it is down, a channel runs the ladder itself. A link over SSH
stays there until it ends, and its next connect tries direct again. A client asking a
peer's host through the relay waits fifteen seconds for the ladder and five more for the
host to say who it is, so a silent direct way still ends in the SSH way's answer. The dialler declares
its way on `/control?transport=<way>[&direct=<why>]`, and the listener records it for its
own `machine list`; one that declares nothing is recorded as `direct`. The listener never
guesses from the address, which is loopback over SSH and for a peer on the same computer
alike.

**The SSH connection.** `src/ssh-connection.ts` runs every ssh command Collie sends to a
Machine. Its control path is `<state dir>/ssh/<16 hex of sha256(label, target)>`, in a 0700
directory, so a changed target is another path and the length depends only on the state
directory; one too long for ssh to bind with its 17-byte temporary suffix is refused,
naming it. `openConnection` is the one way a connection is opened, and only a front door
that can show its login runs it: `collie machine connect`, pairing, and `reach` in the
lifecycle and `collie bridge` (`pairs` on their env) where a link waits on one. It runs
`ssh -M -N -S <path> -o ControlPersist=yes -o ServerAliveInterval=15 -o
ServerAliveCountMax=3 -o ConnectTimeout=15 <target>`, not in a process group of its own,
so the master ssh puts in the background outlives the command; its stderr goes to the
command's, and it answers once `-O check` does, within two minutes. Openers that come
together, in any process, take turns on `<path>.lock` and check again once they hold it,
so one master and one SSO approval serve them all; the two minutes count the wait and
every check too. The host is given only
`sshConnection`'s handle, whose `check` and scoped `forward` are `ssh -S <path> -O
check|forward|cancel <target>`, and whose `exit` is `ssh -S <path> -O exit <label>`,
removing a path a master left behind: each talks to an open master or fails, so the host
never logs in, and a master that has not answered one within five seconds (`MUX_BOUND`,
Desktop's too) counts as gone. `-G` and the invite's session are the module's too (`resolvedHost`,
`ride`); `src/peers.ts` builds no ssh argv. A session that rides the connection is built by `riderArgv`, `ssh -S <path> -o
ControlMaster=no -o ProxyCommand=false -T <target> <remote>`: where the socket has gone,
ssh would otherwise fall back to a login of its own, and `ProxyCommand=false` fails that
fallback at once (OpenSSH 10.2 exits 255 in under 10 ms). `connect` then asks the local
host's `wake`, which ends that Machine's dialler's backoff. `test/support/fake-ssh.ts`
models all of this, logging each call as `master`, `mux <verb>`, `ride` or `login`.
Still to confirm on a real OpenSSH: that a `ControlPersist` master releases its opener's
stdio, that `-O forward`, `-O cancel` and `-O exit` act on the master `-S` names whatever
destination follows, and that a rider session with `ProxyCommand=false` runs through a
live master.

**Who opens it.** `MachineUnreachable` carries `waits: "ssh_connection"` from
`openPeer`, through the relay's answer and `peerChannel`, into the `machine_unreachable`
envelope's details, whose message names `collie machine connect <name>`. `riding` in the
lifecycle catches that one failure for a front door with `pairs`: it opens the connection
as `machine connect` does, wakes the host's link, and reaches once more, returning a
second failure as it is. Everything else — reports (`pairs: false`), Schedules, sync and
the dialler through the host's own `connectPeer` — gets the typed refusal and opens
nothing.

**Closing.** On a Machine set to `herdr`, `reconcileMachines` runs `closeConnections` each
time it reads herdr's list:
every 16-hex path under `<state dir>/ssh/` that is not `controlPathOf` a machine herdr
lists now is ended with `-O exit` (the path no longer names its Machine, so the
destination is `collie`) and removed. A forgotten peer is told and dropped first. Where
herdr cannot say, nothing is closed. On a Machine set to `core` (the link's
`forgetsUnlisted` is false), it does nothing: a pairing core does not keep yet, as one made
on herdr before the switch, stays paired, and `machine list` says it is not added. Only
`collie machine forget` (`machineForget`) removes one: the host's `unpair` tells the peer,
forgets it and ends its connection, then core is asked `machine.rm`.

**Core's machines.** On a Machine set to `core`, `Herdr.machineList` reads core's
`machine.list`, each machine by core's name, its ssh target the last word of the `via`
Collie gave it (`viaTarget` in `src/ssh-argv.ts`). `collie machine add` opens the Machine's
connection with `openConnection`, then calls `machine.add {name, via}` with
`viaCommand`: the rider's own argv (`-S <control path>`, `ControlMaster=no`,
`ProxyCommand=false`) without its remote line, which core appends. With no master on that
path it exits 255 at once, logging in nowhere, so core's own retries never raise an SSO
prompt; `collie machine connect` reopens the master and calls `machine.connect`, which
dials at once. `test/machines-core.test.ts` proves it with a fake core that runs each `via`
through the fake `ssh`.

The listener sends a heartbeat every fifteen seconds. Silence past that interval ends a
control link. Reconnection backs off from one second to one minute, resetting after a
live link. `doctor` reports a listener whose port is occupied, as does `machine list`;
it notes a link live over SSH and warns, without failing, about one that waits.
`machine list` reports `live` with its transport, `connecting` with what each way saw, or
`away` with its time and reason. Each host keeps running its local Runs while its peer is away.

`src/channel.ts` is the one declare-then-pipe: `collie bridge` hands it stdio, the listener
a WebSocket, as does the dial-back. The client side is `connectPeer` in `src/host.ts`, which opens the relay, asks
`identity` and refuses a far host of another build, naming both, without ever starting or
stopping it; and `asksRun` in `src/lifecycle.ts`, which asks this host, then each peer, then
each herdr machine not paired yet, for the Run a command names. `test/peers.test.ts` proves
the link with `test/support/peers.ts`: two real hosts, each with its own fake herdr, paired
through a fake `ssh`.

**Pairing.** `ensurePaired` first opens the Machine's SSH connection with
`openConnection`, whose login and SSO approval show on the command's stderr, or finds it
open and asks nothing. `pairWith` resolves the herdr machine's
`HostName` with `ssh -G` and runs
`collie --json machine invite --for <installation> --name <this Machine> --address <HostName>`
there in a session that rides that connection. One that went before the invite fails
with what ssh said, never a login of its own. The invite is bounded to two minutes; a
timeout closes the session and says which Machine did not pair. The invited host makes its certificate with `openssl` the first time,
mints or reuses the installation's secret, keeps the pairing
and starts listening; the asker's host keeps its side and opens the relay. A relay path
longer than a unix socket takes (104 bytes on macOS) is refused rather than truncated.
Only a front door that can show the login pairs (`pairs` on its env): a host's own jobs
are refused with "not paired yet".

Pairing updates are serialized, including the certificate and listener. Changing a
Machine's saved name or connection details replaces its relay and control link.
After freeing an occupied listening port, `collie machine list` retries the listener.

**Forgetting.** When the host that dials a peer starts and herdr no longer lists it, it
tells the peer over the relay as `host` (`forget`, which the peer applies to the
installation the link authenticated) and drops the pairing; a peer with nobody left
dialling in closes its listener.

**Keeping peers level.** `src/flock-settings.ts` holds the latest-edit merge shared with
Desktop. On link-up, and when the host sees `config.json` or `settings-set.json` change,
it takes later peer edits and gives the peer its later edits over a `host` channel.
Each edit keeps its timestamp. `gitlab_host` is excluded in both directions.
The receiving host's `flock.by` names the peer that shared the edits.

On link-up between releases, the newer host runs an upgrade through `shell`, then asks
`refresh` to start the older Machine's own new CLI detached. Awaiting that CLI inside a
shell would let the old host kill it during shutdown. The newer host checks identity
until the new host answers, within thirty seconds. Failures appear in `machine list`
and are retried on the next link-up. Development checkouts never take part.

## The herdr boundary

`herdr.ts` is the only channel to the herdr Collie is running inside: the `herdr` CLI at
`HERDR_BIN_PATH` for the commands that have one, and the socket at `HERDR_SOCKET_PATH` for
the rest. Nothing else in the program shells out to `herdr` or opens that socket. That is
what makes the fake herdr in `test/support/` enough to test everything above it.

A process a test starts still runs a real executable at `HERDR_BIN_PATH` for every call, so
the argv, stdout, stderr and exit code still cross a process boundary. That executable is
only a forwarder (`test/support/forwarder.ts`): it hands its argv, working directory and
environment over a unix socket to the test process, which answers with the same fake core the
in-process fake uses (`test/support/forwarding.ts`). Each shim names its own answerer, so two
fixtures of one fake keep their own state. The fake forge's executable on `PATH` is the same
forwarder. With no test process listening, as for a host that outlived its test, the
forwarder prints nothing, names the socket on stderr and exits 70: it never answers on its
own.

One thing outside the program does run a herdr binary: `tools/herdr-schema.ts` downloads a
named release and asks it to print its bundled schema. It is the exception the invariant
can afford, because it is not talking to the session — no `HERDR_BIN_PATH`, no socket, no
state, and a binary in a temp directory rather than the one the user is running. There is
nothing above it to fake, and routing it through `herdr.ts` would mean asking the running
herdr what some other version's schema says.

The host and the CLI read the list of Machines through `herdr.ts` too (`machineList`):
`herdr machine list --json` on a Machine set to `herdr`, core's `machine.list` on one set to
`core`. It is the list of Machines a pairing may be made with, and on herdr a peer it no
longer names is forgotten ([Reaching another Machine](#reaching-another-machine)).

Desktop's main process runs three more, all on herdr's list of saved machines, while the
Local Machine is set to `herdr`; set to `core`, it reads the list from `collie machine list`
(`rosterOf`), adds with `collie machine add` and removes with `collie machine forget`, and
runs none of these:
`herdr machine list --json`, which machines to reach, and `herdr machine remove`
(`desktop/src/bun/machine.ts`), and `herdr machine add` (`desktop/src/bun/onboarding.ts`),
run in Bun's terminal so herdr has the terminal its questions need. Local Claude and Linear
logins use `src/in-terminal.ts` too. A Claude login over SSH uses `src/script.ts` to pick
util-linux or BSD `script` on that Machine, by `uname`. Where the list fails, it
also asks `herdr --version`, so a herdr too old to have `herdr machine` is named as one. Desktop is another
program, usually on another computer, and it is not talking to a session either: it keeps
herdr's list and nothing else. Routing them through `herdr.ts` would bring Collie's locks
into Desktop, which reaches a Machine only through `collie bridge`. For a paired Machine,
that command runs locally with `--machine <name>` and pipes the Local host's relay; for
SSH it runs on the far Machine. Bounded shell calls carry commands and credentials over
the door. After an upgrade, `refresh` asks the far Machine to run its new CLI and replace
its host. Interactive terminal commands and login forwarding retain SSH, riding the
Machine's shared connection with argv from `src/ssh-argv.ts`, which keeps the host's lock out of Desktop. Desktop opens that
connection only through `collie --json machine connect <label>`, reading SSO lines from
its stderr, and finds one gone with `-O check` before its next use; it never closes it.

Each Machine's `desktop` channel is its _door_, and Desktop holds one per shown Machine, by
installation (`DoorMap` in `desktop/src/bun/machine.ts`), for as long as its board stream
runs. When a door closes under a call, Effect's RPC client ends the call with an interrupt;
Desktop says it as a failure naming the Machine and the request it was made under, where
every call through the door has its refusal said. Only the caller's own interrupt stays an
interrupt. A Run's details are not tied to one door: they ride whichever door the Machine
has now, and when it closes or breaks they wait for the next, woken by the map's change
rather than a poll.

Files reach a Machine the same way. The Flock chat's `collie_read`, `collie_glob`,
`collie_grep`, `collie_write` and `collie_edit` (`desktop/src/bun/file-tools.ts`) are
answered by the host's `readFile`, `glob`, `grep`, `writeFile` and `editFile` over the
chat's channel (`src/host-files.ts`), never by ssh or scp beside the bridge. A file a start, a follow-up or a steer carries goes
the same way: through the Run's Machine's `upload`, once a day per file and Machine
(`desktop/src/bun/carried.ts`, `src/uploads.ts`), so a host only ever receives paths on its
own Machine. The file tools are
Desktop's own tools, not the Toolkit's, so Native chat's reach is unchanged.

Go to pane is the one place Desktop touches a session, and it does so for the human
([ADR-0044](adr/0044-go-to-pane-opens-the-pane-in-desktop.md)): it runs herdr's terminal
controller for the Run's pane, `herdr [--session <name>] terminal session control <pane>
--takeover --cols C --rows R`, through the Machine's route — one more channel on the
Machine's shared SSH connection, or a local process for Local — and draws what it prints in
the drawer's Terminal tab (`desktop/src/bun/terminal.ts`). The human's keys, pastes,
resizes, wheel and clicks go back to it as herdr's own controller commands, and leaving
the tab sends `terminal.release`. Desktop decodes each line only to hand the frame's bytes
to the renderer, and decides nothing from what the pane shows. Where there is no pane to
control, and for **Open in herdr**, it opens `herdr --remote <target> --session <name>` in
a terminal of this computer's instead, a client the human then drives. The focus before
either is the host's, through `herdr.ts`; its reply names the pane it focused.

An agent on core has no pane: the host's focus names its core terminal (`core` in its
reply), and Desktop runs `herdr-core connect` through the same route instead, core's API on
its stdin and stdout, so a local agent is reached through this computer's own core and a
remote one through that Machine's until Machines reach each other's core. On it Desktop
says `hello {framed: true}` and `terminal.attach`, with 1000 lines of history, and draws
the first paint and every DATA after it (`attachCore` in `desktop/src/bun/terminal.ts`).
Keys go back as DATA and a resize as RESIZE; xterm.js keeps the history and sends its own
mouse reports. Each DATA is credited once it is handed on to be drawn. Core streams no more
than 256 KiB ahead of that credit, so a terminal holding a whole window undrawn is that far
behind: Desktop closes the stream and attaches again for a fresh paint rather than draw
core's backlog. Core's CLOSE ends the terminal with its reason and exit code.

### Settings shared across a Flock

Collie's settings are one list, `src/settings.ts`: each key with its kind, its choices, its
default and what it refuses. It is pure, so Desktop's view bundles it, and the TUI's
Settings, its `SetDefault` and the host's `setSettings` all decide through `parseSetting`.
Every write of one goes through `setSetting` in `src/config.ts`, which records the time in
`settings-set.json` beside `config.json`; a value written before anything recorded one is
dated by the file's own time.

Desktop keeps the Flock's settings in `flock-settings.json`
(`desktop/src/bun/flock-settings.ts`). On each board Snapshot — a Machine connected or
reconnected — and after an edit in its Settings, it reads the Machine's `settings`, takes
each key whose edit is later than the one it holds (`takeFrom` in
`desktop/src/shared/flock-settings.ts`), and gives the Machine what it lacks with
`setSettings`, which the host writes only where that edit is later than its own. The latest
edit of a key wins everywhere ([ADR-0043](adr/0043-a-shared-setting-is-its-latest-edit.md)).
A Machine whose collie has no `settings` yet fails the read, is left alone, and is synced
once Desktop has upgraded it and it connects again.

### The Flock chat's Machine rule

The Machine rule (`machineRule` in Desktop's own `settings.json`, beside `proactive`) is not
one of the Flock's settings: only the Flock chat chooses between Machines, so no Machine is
given it. Every turn's `UserPromptSubmit` hook (`desktop/src/bun/session.ts`) adds it as
context, built fresh from the saved text and the Machines Desktop reaches at that moment,
named as the cards name them, with Local marked as this computer; a turn Desktop starts
with News goes through the same hook. An empty rule adds nothing. The system prompt says
what the chat does with it, and Collie never parses it: a start still names
`<machine>:<workspace>`, and one that names no Machine while several are reachable is
refused as before. `collie_machine_rule` (`desktop/src/bun/flock-tools.ts`) reads the rule
back or replaces it, through the one write Settings uses; it is in the Flock chat's toolkit
only, not among the Collie tools both chats share.

### The Standing direction

`standing_direction` is one of the Flock's settings, so its text and last edit come from
Desktop's Flock settings on every turn. `standingDirectionContext`
(`src/standing-direction.ts`) words the block for every chat, and an empty direction adds
none; the Flock chat puts it in the `UserPromptSubmit` hook on Claude and in the bracketed
note on Pi, beside the Machine rule. `collie_direction` reads it or replaces it through
Settings' edit path. A host refuses an edit of it from the `agent` front door
(`setSettings` in `src/host.ts`), and nothing that decides Authority, a Go, a Confirmation or
admission reads it
([ADR-draft-a-humans-standing-direction-outlives-the-chat](adr/draft-a-humans-standing-direction-outlives-the-chat.md)).

### Settings shared across a Flock

Collie's settings are one list, `src/settings.ts`: each key with its kind, its choices, its
default and what it refuses. It is pure, so Desktop's view bundles it, and the TUI's
Settings, its `SetDefault` and the host's `setSettings` all decide through `parseSetting`.
Every write of one goes through `setSetting` in `src/config.ts`, which records the time in
`settings-set.json` beside `config.json`; a value written before anything recorded one is
dated by the file's own time.

Desktop keeps the Flock's settings in `flock-settings.json`
(`desktop/src/bun/flock-settings.ts`). On each board Snapshot — a Machine connected or
reconnected — and after an edit in its Settings, it reads the Machine's `settings`, takes
each key whose edit is later than the one it holds (`takeFrom` in
`desktop/src/shared/flock-settings.ts`), and gives the Machine what it lacks with
`setSettings`, which the host writes only where that edit is later than its own. It asks
even with nothing to give, since that is what tells the host a Desktop shares its settings,
which its TUI then says. It takes no value `parseShared` refuses, and never `gitlab_host`,
whose token Desktop holds. A Machine's reply is taken into the settings as they are by then
(`flockSync`), so an edit made during a sync survives, and an edit taken from one Machine
goes on to every other connected one. Opening Settings syncs every connected Machine too.
The latest
edit of a key wins everywhere ([ADR-0043](adr/0043-a-shared-setting-is-its-latest-edit.md)).
A Machine whose collie has no `settings` yet fails the read, is left alone, and is synced
once Desktop has upgraded it and it connects again.

### Checking the boundary against herdr

The reply structs in `herdr.ts` are hand-written, and herdr releases often. `herdr api
schema --json` prints the JSON Schema of the socket API the binary bundles, and the CLI
answers with the same envelope, so that one document describes every reply Collie decodes
and every socket request it sends. `test/herdr-contract.test.ts` walks the structs against
it in the one direction that matters: Collie must accept everything herdr may send, and
extra fields herdr sends are never a failure. `herdr.ts` exports the shapes it decodes as
one `replySchemas` record, and the test asserts its table covers every key of it, so
adding a decoded call without a row turns that test red rather than going unchecked.
The one exception is `agent explain --json`, which herdr's schema gives only as `explain:
true`, so there is nothing to check its struct against. `promptBox` reads one field of it,
the `prompt_box_body` rule's `evidence.region_preview`; the pinned 0.9.3 answers it
(`herdr agent explain --file <screen> --agent claude --json` checks a binary without a
server), and a reply without it reads as a box nobody can see, which asks a
human rather than pressing Enter.

`machine list --json` is the third: a bare array of saved machines. Its struct,
`HerdrMachine` in `src/peers-model.ts`, is what Desktop decodes too, and
`test/herdr-contract.test.ts` holds it to what the pinned 0.9.3 prints.

`session list --json` is the second: it answers with a bare `{ sessions }` rather than an
envelope, so it is not in the socket schema either. The host reads it to find every running
session on the Machine (the pinned 0.9.3 has the command), and an answer it cannot decode
reads as the one session the host inherited. Each
session's agents come from `agent list` with that session's `HERDR_SOCKET_PATH`, and its
changes from `events.subscribe` on its socket: pane lifecycle events and each agent pane's
status, subscribed again after every event so a new pane is watched too.

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

Where a checkout goes is Collie's own setting, `worktrees_directory`
(`worktreesDirectory` in `src/config.ts`), not herdr's config.

One gotcha the engine works around rather than reports: `tab create --cwd` and
`pane split --cwd` echo the directory back but leave the pane's shell in the workspace
directory (probed against herdr 0.8.2; not yet probed against the pinned 0.9.3). So every
pane the engine opens is `cd`-ed into
`run.record.cwd` explicitly before its agent starts, and that `cd` is what puts a run's
tabs in one workspace and its work in another directory. Keep both: the `--cwd` is
harmless and right if herdr ever honours it, and the `cd` is what actually works.

The second gotcha it works around is submission itself. `agent prompt` writes the text
and an encoded Enter and reports success once both are written — which is not the same as
the agent having read them. A harness whose TUI takes the pane over just after that write
keeps the text in its editor, unsent: probed against pi 0.85.1 under herdr 0.9.0, where
about one launch in three lost the Enter that way and the step then sat silent until its
quiet clock ran out.

The same race happens earlier, at start. `herdr agent start` returns once herdr calls the
agent ready for input, but under load Claude's REPL has been seen to come up two seconds
after that, with the pointer already typed into a pane that was not yet its prompt. So the
first prompt to a newly started agent waits for the harness's own sign, through the
controls Collie installed (`ready` on its port in `compactors.ts`): Claude's first
status-line call and Pi's `session_start` sample, both in the agent's control directory;
Codex's App Server accepting a connection; OpenCode's TUI, which is its
own server, answering for the session Collie made. An agent launched without controls —
compaction off, or a harness Collie has no port for — has no such sign, and herdr's word
is all there is. The wait is two minutes past herdr's own; running out parks the step,
naming the agent and its pane, with nothing typed. `tools/prompt-race-live.ts` checks this against a real
herdr and Claude: at most four agents started at once in a scratch herdr session, each
shown to have taken its first prompt by its submit hook's record of the delivery.

So `agentPrompt` answers a `Submission` — what herdr could actually tell us — rather than
nothing. It reads the agent's status first, because only a submission that started from a
settled agent can be told apart from a turn that was already running; then it submits with
herdr's own gate, `--wait --until working --until blocked`. A turn observed after a settled
start is `observed`. A prompt to an agent that was already working is `unobserved`: the
text and the Enter were written, and nothing at this boundary can say whether the agent
took them. The engine records that line against the
variant, because a step that goes quiet later is explained by it.

Settled means a status herdr actually gave — `idle` or `done`. A status it could not
give rules nothing out, so it is treated like a turn already running: no evidence.

`agent_prompt_stalled`, and a gate that times out, are herdr saying it saw no turn come
of the submission, and both have one recovery: one `agent send-keys <agent> enter`. A
freshly started agent is the usual case — herdr has no status for it yet, so there is no
stall to detect and the wait simply runs out with the text in the editor — which is why an
agent with no status yet is waited for, up to ten seconds, rather than read as mid-turn.
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
against the variant, a boundary item composed into that prompt inherits the note, `run deliveries` shows it beside
the state, and a compaction request records it, so an unresolved compaction can be told
from one whose request may never have arrived.

`unobserved` never stays silent, though. While a step's Output is awaited, the Dispatcher
checks its unobserved prompt or repair (`confirmSubmitted`) until something says it was
taken: a turn herdr saw start from a settled agent, or Claude's `UserPromptSubmit` hook
recording that delivery's id — every prompt carries its `collie-delivery:<id>` line near
the top for this, where herdr's few-hundred-byte view of the prompt box can see it. A settled agent whose prompt box still holds that line — herdr's `prompt_box_body`
region, read with `agent explain` — gets one Enter, recorded on the ledger so it is never
pressed twice, and never the text again. A settled agent showing neither for fifteen
seconds parks the step: nothing can prove sending it again is safe, so the Run waits for
a human, naming the agent, its pane and the delivery. The human settles it with `run
deliveries --reconcile <id> --as sent|not-sent`; after `not-sent` the resume sends the same
words once more, from the `<operation>.step.md` or `.repair.md` beside the launch, as the
next attempt; one herdr refuses parks again, and the next resume tries again. Only the
delivery the wait is for is checked: the step's, or the repair's once one went out. A wait parked that way is still a
pending Run, and reads as waiting on you rather than working. An agent `blocked` at a
dialog is not settled, and is left to clear.

`env.ts` is the plugin environment herdr provides — state directory, socket path, plugin
root — and the user's own layer, `<plugin root>/user`, which `COLLIE_USER_DIR` overrides
for a test or an embedder. `COLLIE_CLAUDE_MANAGED_DIR` does the same for where Claude Code's
managed settings are read, so a test's bypass does not depend on the machine's. `HERDR_PLUGIN_ROOT` is what pins the baseline definitions to the
installation the runner came from; the `collie` on PATH is a two-line shim that sets it.
Without the pin the compiled runner falls back to its own installation (`process.execPath`
is the binary when bun runs it from `/$bunfs/`), so a `bin/collie` started from another
directory still finds its workflows and the host it starts. Only `bun src/main.ts` in development
falls all the way through to the current directory.

### Checking core against its schema and live

Collie is moving its agents to herdr-core (`hc`,
[ADR-draft-collie-runs-its-agents-in-herdr-core](adr/draft-collie-runs-its-agents-in-herdr-core.md)).
`src/hc.ts` is its client: plain JSON-RPC on the session socket, frames after
`hello {framed: true}`, and one decoder per method it calls, in `replies`. A Machine whose
`terminal_backend` is `core` runs its Runs' agents there ([Agents on core](#agents-on-core)).
`hc-pin.json` names the `hc` release and its archive checksums, and the
`released.openrpc.json` of that release, committed as `hc.openrpc.json`.

The wire is checked twice, because each check misses what the other catches:

- `test/hc-contract.test.ts` builds every reply `hc.openrpc.json` allows for each method in
  `replies` — each object with only its required fields and with all of them, and each
  alternative of each field — and every one has to decode.
- `bun run probe:hc` (`tools/hc-probe.ts`, in the `ci` workflow's `static` job) downloads the
  pinned `hc`, checks it against the pin, starts it on `HC_SESSION=collie-probe` with
  scratch XDG directories, and drives run, list, get, read, send, keys, events and attach
  through the decoders. It fails if a reply does not decode, if a process of that binary
  outlives the core it stopped, or if an entry appeared in or left core's default state,
  config or runtime directory. Only this caught hc 0.1.14's `terminal.list` without the
  `machines` its schema requires, which `replies` therefore allows to be missing.
- `bun tools/hc-probe.ts --harness claude|codex|pi`, run by hand, starts that installed
  harness in a terminal of the same scratch core and sends it a prompt as Collie does, with
  no `caller` to a terminal started with `no_parent`. It passes once the prompt is on the
  harness's screen without core's `<hc from="…">` mark, which 0.1.14 puts on no plain send,
  and the harness has answered it and reported `idle`, `working` and `done`. A pin that
  starts marking sends fails it. It costs one turn of the harness's model, and asks for an
  answer rather than a file because Codex's sandbox cannot write where the host restricts
  unprivileged user namespaces.

The test rig's fake core (`rig.startCore()`, `test/support/fake-hc.ts`) records each call in
the rig's log beside the fake herdr's, and checks each of its own replies against
`hc.openrpc.json`: one the schema forbids is answered as an error naming it, so the test
that caused it fails. Bumping the pin is editing `hc-pin.json`, copying that release's
`released.openrpc.json` over `hc.openrpc.json`, and passing both checks.

### Agents on core

`terminal_backend` is read when an agent is launched, so switching it mid-Run moves the
next agent and leaves the running ones where they are. The core socket is `HC_SOCKET`,
else the `socket` core's own `config.toml` names (under `XDG_CONFIG_HOME`, else
`~/.config/herdr-core`), else `<session>.sock` under core's runtime directory, `HC_SESSION`
naming the session (`default` when unset). All of it goes through `src/herdr.ts`, as herdr's calls do:

- **Launch** is one `terminal.run` with the agent's name, the labels `run`, `operation`
  and `task`, its cwd and `no_parent`: it is the Run's agent, not a child of whatever
  started core. Its env is the launch env herdr's agents get, with the profile's file-held
  values read in, and `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` blanked, so `collie` in that
  terminal knows itself by `COLLIE_AGENT`, which the host confirms against its Runs.
  Every `terminal.run` Collie sends, the board's and chat's too, carries the host's own
  `PATH` under that env: core finds the program on the `PATH` it is handed, and a core that
  another Machine's SSH dial started has a bare system one, without the harness.
- **The board and chat** (`keepTerminals` in `src/side-jobs.ts`) are started again on each
  terminal core says ended or was removed. A round that leaves either unstarted waits before
  the next — a second, doubling to five minutes — since core says a terminal it could not
  start was `removed`, and retrying on that is a start a few milliseconds, for good.
- **Delivery** is `terminal.send`. One that answers `started: false` gets one Enter
  (`terminal.keys`), and the Run's log says so. Core's `blocked` refusal is herdr's
  `agent_blocked`, so the Dispatcher holds the send as it does on herdr.
- **Status** is read from one `events.subscribe` per socket, kept for the host's life.
  OpenCode reports none of its own, so its launch adds Collie's reporter plugin
  (`opencodeReporter` in `src/harness.ts`) to `OPENCODE_CONFIG_CONTENT`, after the
  operator's plugins, and edits no settings file. It reports its own session's OSC 7501,
  and writes that session's id once to `<step>.session` in the Run's directory, skipping a
  subagent's. Collie records the id as the launch record's `agentSession`.
- **The first prompt** of an OpenCode agent goes in at launch, as `--prompt`, since it
  reports no readiness to wait for. Its later prompts are sends.
- **A Claude or pi agent** is launched with `--session-id` and a fresh id, which the launch
  record keeps as its `agentSession`; the registry's incarnation keeps none, since core
  lists none. A Codex agent's is the thread its App Server has for it, read once its first
  prompt is in; an OpenCode agent's is the one its reporter writes.
  pi has no question tool, so its per-launch `.tools.ts` registers Collie's
  `ask_user_question` (`piQuestionTool` in `src/compactors.ts`). The tool hands its call to
  `collie herdr compaction <control dir>` as the payload Claude's `AskUserQuestion` hook
  gets, so it is recorded in the same `questions.jsonl` and becomes the same Decisions, and
  a call short of standard gets the hook's repair as the tool's result. A call repaired
  rather than posted is recorded with `repair` (`in-reply`, or `by-delivery` for a Codex
  call whose repair goes as a Delivery), so the call after it is posted whatever it holds.
- **Stop** at the Run's end is `terminal.kill`.
- **Resume.** What each agent was started with, less its credentials and its Run's
  authority, is kept in `relaunch/<run>/<agent>.json` under the state directory until it is
  ended. The host follows core's events, and on subscribing and on each terminal that ends,
  starts again every agent of a running Run that `terminal.list` no longer has: a new
  `terminal.run` under its name, in its cwd, with its harness's resume of the recorded
  session (`claude --resume`, `codex resume`, pi's `--session-id`, `opencode --session`).
  Codex gets a new App Server, and no permission flags: the thread keeps its own, and
  Codex 0.166 refuses them on a remote resume. Once every lost agent is back, one whose
  Output is still out and that has no question open is told it was restarted and to carry
  on, then its step's pointer. OpenCode 1.18.30 ignores `--prompt` beside `--session` on a
  session with a conversation, and its TUI takes no keys for a while after its server is
  up, so its reporter, loaded on the resumed session, reports it idle first. The message is
  then posted to `/session/<id>/prompt_async` on its own server where compaction gave it
  one, or sent through core where it has none, and kept in the Dispatcher's ledger like any
  delivery. No idle within the launch wait, or a refused post: the Run's log says it was
  not resumed, and nothing is typed. The Run's own revival leaves such an agent to the host.
  Starting one again and ending one take the Run's `relaunch/<run>.lock`: an end waits out
  a start already under way and ends the terminal it started, read from the operation's
  launch record, and a start after an end finds no record and starts nothing.
  Recovery follows the started generation's recorded terminal and session, including
  later operations that reused it. Older generations keep their own launch records;
  a missing session never borrows one from an earlier generation with the same name.
- **A Task** is its record and the `task` label: placement opens no workspace, and a
  Task's `workspace` is null. Cleanup's pass over Task workspaces writes the record's
  `closed_at` an hour after the Task is Finished, which ends a start's join by branch;
  rename, focus and close ask neither herdr nor core. A Run that asked for a workspace of
  its own gets a git checkout (`checkoutFor` in `src/worktree.ts`).

The incarnation of an agent launched on core is its terminal's address, marked `core`, and
what is sent to it goes to core. A Machine set to core also lists herdr's agents while
`HERDR_SOCKET_PATH` is set, so an agent launched on herdr before the switch is still
reached there; one set back to herdr lists only herdr's, and its agents on core are gone
to it. The host's Herds on a Machine set to core are its core Herd as well as each herdr
session still running, so its board and News keep the core Herd's Runs while Herdr 1 stays
open.

Agent names reserve space for both their leading letter and generation suffix, including
long numbered ticket names. Older launches may have truncated that suffix. Replay,
revival, role reuse and steering retain those persisted names. A matching saved core
start can also bind its name before the launch record exists. If another spelling is
already listed without enough identity to reconcile it, the launch waits with an explicit
reason instead of starting another worker.
A rollback after new names have been recorded must retain this persisted-name binding;
an older binary that only recomputes the truncated name cannot safely revive that work.

## The forge boundary

Collie reaches GitLab and GitHub through one interface, `Forge` in `src/forge/forge.ts`,
with an adapter per forge: `src/forge/gitlab.ts` runs `glab`, and `src/forge/github.ts`
runs `gh` ([ADR-0050](adr/0050-a-merge-request-is-its-forges.md) D1), or asks its forge
over HTTP with that CLI's token (below). Each forge's doctor
checks sit beside its adapter, in `src/forge/gitlab-checks.ts` and
`src/forge/github-checks.ts`, and a workflow's content file for one forge
(`<name>.gitlab.md`, `<name>.github.md`) may name that forge's CLI. A caller asks the
forge of the merge request in front of it (`forgeOf(ref)`, from the reference's host), and
gets answers rather than CLI calls: whether the CLI is ready for a host, who it is logged
in as, one merge request as the panel, how far a merged commit is deployed, the commit a
tier's newest successful deployment has (`deployed`, which a Release Run reads stage and
production by, a rollback included, since the release rolled back to is older than the
merge), and a note. A pipeline read whole by its address (`pipeline`) names each job with
its state and address, a job waiting to be started by hand as `manual`: GitLab's manual
job, or a GitHub job waiting on its environment's approval.
An operation is added to the interface when its first caller moves onto it.

### The calls that go over HTTP

These calls go to the forge in-process through the [`forges`](https://forges.link) library,
pinned to one exact version, rather than through `gh` or `glab`
([ADR-draft-a-forge-is-asked-over-http-with-its-clis-login](adr/draft-a-forge-is-asked-over-http-with-its-clis-login.md)):

- The CI job reads a check left to CI is proved by: `job`, `baseJob`, `retryJob` and
  `runStatus`. Each sends the REST requests its CLI sent, a merge request's head included.
  On GitHub a job's id is its Actions run and job, `<run>/<job>`, read from the check
  run's URL. `retryJob` reruns that run's failed jobs (`rerun-failed-jobs`), and `jobLog`
  is `gh run view <run> --log-failed`. A gate job, such as Collie's own `test`, needs the
  jobs that ran the work: rerunning only the gate re-reads the same failed results, and its
  own log shows none of the failing tests.
- The merge request reads: `details`, the panel, and `forBranch` and `fromBranch`, a
  branch's merge requests. GitHub's `details` is one GraphQL query for every field `gh pr
  view --json` asked for, its check contexts paged; GitLab's reads the merge request, its
  `/approvals` and its `/discussions` together, and says it has unresolved threads when a
  resolvable note is unresolved. A branch's merge requests are the REST list filtered by
  source branch (GitHub's `head=<owner>:<branch>`, so a fork's same-named branch is not
  one), read page by page until a short page.
- Branch protection, `protects`, and deploy status, `liveTier`. GitHub pages its
  deployments and reads their latest statuses and commit comparisons; GitLab reads
  environments, successful deployments and their merge-bases on the same routes as glab.
- Stage's `stagingEnvironments` pages environments and deployments through the same
  transport. Selected-job attribution includes earlier attempts, and a refused read
  leaves the deployed environments unknown so their claims cannot be given back.
- Issues, review posting, my open merge requests and the login: `issues`, `fileIssue`,
  `commentIssue`, `post`, `mine` and `login`. These use the library's modelled thread and
  user operations. A review posts one note, then an approval only where asked. Lists are
  read to the end; GitHub's issues exclude pull requests.
- Review reads, replies, merging and release reads: `readReview`, `reply`, `merge`,
  `deployed`, `tagPipeline` and `pipeline`. They keep their REST routes; GitHub reads the
  pull request, review threads and default merge method through GraphQL. Comments,
  reviews, threads, deployments and pipeline jobs are read to the end. A failed merge is
  read back to distinguish one that landed, a moved head and a refusal; a timeout,
  network failure or 5xx never resends the merge.

The CLI keeps readiness and the doctor's checks,
cloning, the credential helper, opening a browser, and commands an agent or reviewer is
told to run, including job logs: the Machine still needs its CLI logged in. Only
`src/forge/` imports `forges`, and
`test/forge-boundary.test.ts` fails on an import anywhere else.

**ForgeHttp** (`src/forge/http.ts`) is the Effect service that sends them. It keeps a
`forges` provider per forge host, provided live in both front doors: the host's
`foundationLayer` and the `collie` CLI. Its token is the CLI's login for that host, read
by **credential reads**, the only commands it runs:

- GitHub: `gh auth token --hostname github.com`. The token is kept until a 401.
- GitLab: `glab config get oauth2_expiry_date --host <host>`, then `glab config get token
  --host <host>`. An empty expiry is a personal access token, kept until a 401. An OAuth
  token is kept until its expiry, checked against Effect's Clock before each request.
  `glab config get` never refreshes one, so once the expiry has passed, ForgeHttp runs `glab
  auth status --hostname <host>` first: that builds glab's API client, which refreshes the
  token and writes it back. A refresh that fails answers as not ready.

One credential read per host is in flight at a time, so concurrent calls on a cold cache
share one, and two refreshes never race. A host whose CLI gives no token answers as not
ready, with the reason `ready` gives, and is sent nothing. After a 401 the token is read
again once and the rejected request sent once more, a write's included, since a forge that
answers 401 applied nothing. A second 401 answers unavailable, naming the login command.
No other request is resent by Collie: a write that times out, fails on the network or gets
a 5xx may have been applied. A failure is an answer, never a defect: its reason names the
forge, the HTTP status and the forge's message, and a rate limit's reset. Interrupting a
call aborts its request.

`runStatus` and `pipeline` take their addresses from agent text. GitHub accepts only
github.com. GitLab's is asked only where glab's own
config or keyring holds a token for that host, read with `env -u GITLAB_TOKEN -u
GITLAB_ACCESS_TOKEN -u OAUTH_TOKEN glab config get token`: glab hands an environment token
to every host, and that token is never sent to a host an agent named.

The fake forge (`test/support/forge.ts`) answers from one model through three faces: the
Runner face (argv), the FakeBin face (an executable on `PATH`) and the **HTTP face**, a
`fetch` answering the same routes, accepting only the token the CLI hands out, and logging
every request. In-process tests give `fakeForge(...).layer`, ForgeHttp over the HTTP face
and the Runner face, to the operation. A spawned host's credential reads go to FakeBin, and
`COLLIE_FORGE_API`, read only by ForgeHttp, points every forge host at the HTTP face
`serveForges` serves on loopback. Baseline workflow scenarios serve both fake forges for
the whole scenario, and replacing a forge's model on `PATH` switches its HTTP face too.
Their host sessions are bounded to 30 seconds, so a missing fake response cannot leave
the suite waiting for the test harness's longer timeout.

A test that runs a merge request read through the CLI's
`PATH`, rather than a model, gives it `forgeHttpOnPath` (ForgeHttp over whatever `glab` or
`gh` is on `PATH`, answering each request as `<cli> api <route>`), or runs it with
`runOnPath`. `tools/forges-benchmark.ts` times `job` or `details` over the CLI and over the
library against a live pull request and merge request.

A checkout Collie clones keeps a credential helper for its forge's host in its own git
config, and no token: GitLab's asks `glab config get token --host <host>` at each use and
answers as `oauth2`, and GitHub's is gh's own `gh auth git-credential`. An empty helper
entry before it drops whatever helper a global config named, so a stale credential there
never answers first. Setting it again changes nothing.

`protects(project, branch)` says whether a branch, pushed or not, is protected: `true`
where it is the default branch or matches any protection rule or ruleset, whatever the rule
allows, and `null` where the forge cannot say. Both forges are read over HTTP with their
CLI's login. GitLab reads the project's default branch and every page of its protected
branches, matching their wildcards; GitHub reads the default branch, the rules active for
the name (`rules/branches/<name>`), and the classic protection rules' patterns through
GraphQL. A Claude agent's launch reads it for the branch its Run created,
and only `false` gives the agent the history allowance
([What a Claude agent's auto mode is told](using.md#what-a-claude-agents-auto-mode-is-told)).

Three operations carry a merge request through its review and merge. Collie decides on
what the review read says, never on an agent's Output
([ADR-0050](adr/0050-a-merge-request-is-its-forges.md) D4):

- **`readReview(ref)`** reads the state and head, the merged commit with who merged it and
  when, approval, whether an external reviewer asks for changes, mergeability, the
  pipeline at the head, and every comment. GitLab reads the merge request, its approvals
  and every page of its discussions; GitHub reads the pull request and every page of its
  issue comments, review comments, reviews with a body, and review threads. A comment is
  `person`, `bot` or `system`, and one rule in `src/forge/review.ts` decides for both
  forges which are **external** (a person's, not by Collie's login) and **answered** (a
  later comment by Collie's login in its thread, any comment by Collie's login linking it,
  or a resolved thread). **Approved** means the forge's rules are met without Collie's
  own approval: GitLab counts each approval rule again without Collie's login (the
  approvals read is one rule where the tier has no approval state). Where GitLab returns
  approval rules, the reported approvers are the distinct usernames recorded on those
  same rules, excluding Collie's login. This binds a release go to the approvals used for
  readiness without mixing snapshots from two endpoints. Approvals outside all rules are
  not included; with no rules or no approval-state endpoint, the approvals endpoint still
  supplies the names. See GitLab's [approval details](https://docs.gitlab.com/api/merge_request_approvals/#retrieve-approval-details-for-a-merge-request).
  GitHub's `APPROVED`
  stands where Collie's login has no approving review, else only where others reach the
  base branch's required count, from its protection and rulesets. A count that cannot be
  read, or code owners' review, is not approved, and the read says why.
- **`reply(ref, comment, body)`** posts `body` as it is: in the comment's thread where it
  has one (a GitLab discussion, a GitHub review comment's replies), else as a new comment.
  It never resolves a thread.
- **`merge(ref, head)`** merges through the forge's REST merge endpoint at `head`, never
  `glab mr merge`, whose `--auto-merge` defaults to on. GitLab passes no squash, so the
  project's setting stands; GitHub uses the repository's `viewerDefaultMergeMethod`. It is
  never an admin merge or auto-merge. It answers merged (with the merged commit, read
  back), already merged (with the commit, head, who and when), head moved, or refused with
  the forge's reason.
- **`pipeline(url)`** reads a pipeline (a GitHub workflow run) by its URL: whether it
  succeeded, and each job's state. A job waiting for somebody to start it by hand — a
  GitLab `manual` job, a GitHub job `waiting` for approval — reads as manual, and
  `host.readTag` counts it as not finished.

A Run merges through `host.merge`, never through `merge` itself, so that it lands with a
**landing record** (`src/landing.ts`), kept as `landing.json` and log lines in the Run's
own directory. The attempt, naming the merge request, the head and when, is written before
the forge is asked; it becomes landed with the merged commit when the forge answers that
this call merged it, and withdrawn on a refusal, a moved head, or a merge someone else made
first.

**The merge watch** (`settleMerges` in `src/merges.ts`) stops every running or waiting Run
whose work is a merge request, and that began before it merged: the work landed, so what is
still building it is done. A Run's work is that merge request, by MR id and whatever Task it
is in, when it opened it, was given it as its target, or is on its source branch in the
owner's checkout. A Run waits on that work too when every child of it still going is that
work, as a plan waits on its builder, unless it is a fan-out, whose later waves may not have
started; a sibling working on another merge request, or on none
yet, is not stopped, however many of the Task's merge requests are recorded. It leaves running the Run that landed it, and every Run up that Run's
parent chain, since a Release Run under an implement Run has more to do after the merge
(tag, stage, production), and its parents wait on it. It decides this from the recorded
landing and the parent chain, never from a workflow's id
([ADR-0029](adr/0029-one-host-acts-for-a-run-and-a-workflows-name-decides-nothing.md)): a
landed record for that merge request spares, and so does an attempt this host process is
making now, since the watch can read the merge before the call records landed. A withdrawn
record, or one for another merge request, spares nothing.

An attempt with no outcome, left by an earlier host process, is settled on the forge's word
before it spares anything, by one rule (`settleAttempt`) that a replayed `host.merge` uses
too. A merge request still open has nothing to settle: the replay withdraws the attempt and
merges. One merged by Collie's login at the attempt's head, no earlier than a minute before
the attempt was written, is the merge whose answer the restart lost, and becomes landed.
Any other merge is someone else's: the attempt is withdrawn, the replay answers merged
outside this Run, and the watch stops the Run and its parents. Where the forge cannot be
read, the watch stops nothing for that merge request until it can. Collie's login is the
operator's own, so a hand merge by that login, at the very head that was approved, after
the attempt, cannot be told from Collie's, and is taken as the merge the go asked for.

The interface decodes the library's issues into the shared issue shape. Filing an issue
uses the returned number and URL. An issue or review write that fails is not sent again,
apart from the single resend after a 401; its reason asks the caller to inspect the issue
or merge request before retrying, since a lost answer may have followed a successful write.

The Host service chooses the forge of the Run's recorded checkout. Before publishing,
it applies Conversation redaction and checks text against other checkouts, including
their remote paths. A refusal is a `WorkflowError`, with no issue call sent. This privacy
inventory is the checkouts under the Projects root and herdr's worktrees directory, to
six levels and including hidden, nested and linked ones, plus every checkout a Run in the
store or an open workspace is in. The walk never looks into `node_modules`, `.git` or tool
directories such as `~/.cache`, `~/.local` and `~/.claude`, and keeps eight filesystem
calls in flight at most. The walk is kept for two minutes per Projects root, so a batch of
findings shares one; the Runs, the workspaces and every checkout's remotes are read
on every check. Building the inventory propagates
inspection failures, and taking longer than a minute refuses the issue. Git's common directory decides which
checkouts belong to the Run's own repository. Remote paths and host-qualified identities
are checked, including URLs with ports and SCP syntax. The registry lends each workflow
its Machine report using the same Run views and `reportOf` reading as the CLI, including
Run identity, parent and status.
Recovered workflows read reports after every saved generation has been registered, the same
gate a Run's lookup of its own generation waits on.

An adapter runs its commands through a `Runner` (`src/mr.ts`), the same seam the tests
fake. `test/support/forge.ts` is a fake of each forge built on one model of a forge, with
three faces: a Runner answering the argv its adapter uses, a `FakeBin` executable on
PATH, and HTTP served on loopback for host-driven tests, all answering from the same model.
`test/forge.test.ts` runs one
contract against both. `test/forge-boundary.test.ts` fails on a `glab` or `gh` invocation
in `src/` or `workflows/` outside its adapter, and on workflow content that names either; its
allowlist names each file that still does, with the ticket that moves it.

## Definitions and layers

`discovery.ts` owns where a workflow module is found: project `.collie/workflows/`, then the
user's `~/.collie/user/workflows/`, then the installation's `workflows/`. Two entries with
one id in a layer are an error, and a broken override is reported rather than fallen
through. `authoring.ts` reads a module without running it — it loads, constructs and
typechecks it — which is what `collie workflow check` and `workflow show` report.

`definitions.ts` owns persona layer lookup, `extends:` overrides and validation; `yaml.ts`
splits a persona's frontmatter from its body over Effect's YAML parser and writes a key back
when forking. The merge semantics are canonical there and in
[Authoring](authoring.md#forking) — change both together.

An unknown harness, model or effort, and a persona or skill that is not
installed, are refused before an agent's tab opens.

## Trust

`trust.ts` handles a harness's own "may I work in this directory" question, answering it
where that harness looks for the answer rather than driving its dialog. For claude that is a
read-modify-write of `~/.claude.json`, a file claude owns — which is why it is done once per
directory, atomically, and with a backup. `start` in `agents.ts` calls it before each
agent's harness starts, for the agent's own directory, and only once per directory and
harness in a Run. What the user sees and how they configure it:
[Using Collie](using.md#trust-the-first-run-in-a-repo).

## Compaction at a work boundary

`compaction.ts` owns one policy and `compactors.ts` the four harness adapters behind it
([ADR-0007](adr/0007-compact-a-reused-agent-at-a-work-boundary.md)). Two places call it,
and they are the only two places a reused agent is given new work: `engine.ts`'s prompt
loop, for a step that keeps an earlier agent, and `handoff.ts`, for a Run handing its
result to another Run's live agent. A liveness nudge and a mid-step recovery message go
through neither, which is why neither is a boundary.

A reused agent is given work only once herdr reports it `idle` or `done`. At a step's
boundary `turnEnded` in `agents.ts` polls herdr's status first, with no budget while the
agent is `working` or `blocked`, and only then samples its context, asks it to compact or
sends the step. A status herdr cannot give ends the wait, and so does a stop of the Run,
which sends nothing. The wait is outside the Dispatcher's transaction, because that holds
the agent's ledger and a steer would otherwise wait for the turn to end. The Run log
says once that the step waits, and how long it waited.

Only sending the compaction request takes the Dispatcher's transaction. Reading the
context and polling an attempt run outside any, with a channel that refuses to send, so a
steer is never refused behind them: the transaction refuses a second one for the same agent
in the same process. A compaction is waited on for five minutes (`COMPACTION_WAIT_MS`, the
host's `compactionWaitMs`). Past them `settle` answers `waiting` rather than parking:
`boundary` in `agents.ts` shows the reason through the host's `parked`, which raises
needs-you once, and goes on polling the same attempt with `pollCompaction` at the poll
interval. Only the harness's correlated outcome ends it; on either outcome the attempt and
the note are cleared and the step is sent, through its own transaction. A stop of the Run
ends the wait and sends nothing, and a host restart finds the attempt on the control record
at the next boundary and waits there.

An agent's controls live in `<state>/compaction/<agent>/` rather than in its Run's
directory, because the agent outlives the Run that launched it — the same fact the
registry exists for. That directory holds the control record, the helper the launch
generated, and the telemetry the harness's own interface appends; an unresolved
compaction attempt is on the record, so whichever process reaches that agent next
refuses to dispatch past it. That telemetry is a bounded file independent processes all
write — a status line, a hook, the host — so every write takes the file's own lock, and
the cap drops the oldest lines while keeping the session line and the newest few
compaction events. Those are what a waiting Run polls for: a file the cap had taken the
binding out of reads as an agent nothing is known about, and the Run waits out its budget
for an answer that had already arrived. Installation through agent startup holds a per-agent PID
lock outside the controls directory. Cleanup takes the same lock and rechecks `agent
list` before removing controls or stopping an endpoint. A parallel launch therefore
cannot mistake an agent still starting for a stale one; a failed launch releases its
lock, and the existing PID-lock recovery handles a process that crashes. An endpoint is
stopped only while its recorded pid still runs the recorded command, read from
`/proc/<pid>/cmdline`, or from `ps -ww -o command=` where there is no `/proc`, as on macOS.

A Codex agent's work runs in its App Server, not its pane, so a Run's stop goes through
`stopAgent` in `src/compaction.ts`, under the agent's control lock, before its pane is
closed: the port's `stop` (`src/compactors.ts`) proves the server by its recorded pid,
start time (`/proc/<pid>/stat`, or `ps -o lstart=`) and command, and by its threads being
in the agent's directory; notes its running turns and its session (or, without `/proc`,
its descendants); sends it one SIGTERM, which drains it; sends `turn/interrupt` for each
turn; waits for it to exit; and gives each noted process of its session still running one
SIGTERM. A thread no user message has materialized has no in-progress turn: its turns are
read as none only when `thread/read` reports it `idle` with no turns and
`thread/turns/list` refuses it with JSON-RPC `-32600` and Codex's "not materialized yet"
text, after its directory has been checked. Codex has also refused such a thread with
`-32601`, "list_turns is not supported yet", while `thread/read` reported it paginated: its
turns are read as none only when `thread/read` reports it `idle` with no turns,
history mode `paginated` and an empty preview, after the same check. Any other refusal, or
either one on a thread that fails its conditions, fails the stop before any signal is sent. Nothing gets a second signal: the record keeps what was signalled and what was
noted of the server's session, and a later stop of the same record interrupts again and
signals only what it has not, proving survivors from that note after the server has gone.
Every sweep stops a kept record again. The record is removed only once the agent is
Quiet; otherwise it keeps the state reached, what was still running, and every step is a line in the Run's
`agents.log` with the full thread and turn ids, the endpoint, the pid and the transcript.
The stand-in server the tests run in its place is `test/support/codex-server.ts`.

Every end of a Run's agent goes through `endAgent` in `src/agent-end.ts`: a Run's stop
(`halt`), a Fallback's retirement, closing a Finished Task's workspace, and the worktree
sweep's close of a dead tab. It proves the agent is this Run's from its launch record,
stops it where its work runs, requires Quiet, keeps the Task's workspace, closes its pane
and writes the end, with why, on the Run's `agents.log`, in that order; the workspace sweep
and the tab close do their own closing once every agent has answered. An agent it cannot
prove is this Run's is left running, and named.

Every path that replaces an agent or releases what it worked in goes through the same stop
first. `installControls` stops a record left under the name it installs and fails
`NotQuiet` rather than delete it; the Agents service turns that into a parked launch. A
Fallback's retirement stops the agent that ran out whether or not herdr lists it, and parks
where it cannot prove the agent is its own. A launch
checks for a stop before it starts an agent and again after, and starts it and writes its
launch record as one uninterruptible step, so a stop that lands in between finds the agent
and stops it. The stale-controls put-down at launch and the Cleanup sweep run the stop for
an agent herdr no longer lists and keep a record that is not Quiet, with its reason, and
`collie cleanup`'s listing says so from the record; closing a Finished Task's workspace
stops its agents first and keeps the workspace when one is not Quiet. Each of them tells
the Run that launched the agent, in its agents log. Until a record is gone, `mayWrite`
makes its directory in use, for a takeover and for Settled, while its server or anything
its last stop left running is still alive.

## The registry and sessions

A **session** is one herdr session and one workspace, taken together; a Run's own worktree
does not move it out of the workspace it was started from.
`registry.ts` records which long-lived agents a session still has, per workspace and repo:
one entry per agent, whatever its Run or role, so a panel's seats and every Run started
from the same place are all there. The register is `collie_agents` in `host.db`, written
only by the host when it launches an agent
([ADR-draft-collies-own-records-live-in-the-hosts-database](adr/draft-collies-own-records-live-in-the-hosts-database.md)):
other processes, `collie doctor` and the board's Enter among them, read it through the
host's `registered` request, and the first host on a state directory imports every
`agents/<register>.json` once and leaves the files in place. Registering an agent drops the entries registered before
its launch listed herdr's agents that the listing did not have; one registered since is kept,
since it may be a seat that started alongside it. A question or a hand-off looks only at the asking Run's lineage —
`Place.lineage`, the Run and the Runs it was started from or whose `runs/<id>/plan` it builds — so `handoff.ts` gives one run's
result to a live agent of the Run it came from rather than starting a second one, and
never to an unrelated Run's agent in the same role.

Each entry also records an **incarnation**: herdr's own `terminal_id` for the process in
the pane, and the harness session it is driving where herdr knows one; for an agent on
core, its terminal's address and `backend: "core"`. An agent name is
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
the others, so a hand-off from the board and a nudge could land in one pane
in either order.

`Dispatcher.transaction(deps, entry, body)` holds one agent's ledger for the whole of
what a caller wants to do with it: it revalidates the incarnation against a fresh
`agent list`, hands `body` a `Channel` bound to that identity, and lets the ledger go when
`body` returns. Only the host writes a ledger, so holding one is the host's own: a second
transaction for that agent fails at once, saying the ledger is already open, and a channel
used after its transaction closes is a defect.

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

A human's steer is a delivery like any other: the host sends it to the Run's agent through
the Dispatcher, with the same incarnation and harness-capability checks, and says whether
it was delivered rather than that it was accepted for sending. Nothing is typed into a pane
on another Run's behalf.

## The Herd and its Home

A **Herd** is one herdr session — every workspace in it — keyed by the canonical path of
its socket. On a Machine set to core, it is that Machine's core session, keyed by core's
socket. Never by a directory: a cwd would key two sessions in one repository to the
same Herd, and one session across two repositories to different ones. Everything shared
across a session's workspaces lives under `<state>/herd/<herdKey>/`: the conversation, the
budget and the elections. That directory has no checkout, and it is where the Home works.
The proposals journal is the Herd's rows of `collie_proposals` in the host's `host.db`,
written only by the host and read by other processes through its `proposals` and
`proposal` requests; the first host on a state directory imports each
`herd/<herdKey>/proposals.jsonl` once and leaves the file in place.

The **Home** is two core terminals the Machine's host keeps, whatever its
`terminal_backend`: `collie-board`, which runs `collie board --draw`, and `collie-chat`,
which runs the chat's harness. `keepTerminals` in `src/side-jobs.ts` starts each that core
does not list as live, once when the host starts and again on every tick of
`terminalsEnded`, core's event stream, so one that ends — a crash, a rebuilt binary, a
human quitting it — is started again under the same name, with `no_parent`, so it is no
other terminal's child. Chat starts on a new session each time, with the harness
`chat_harness` names then. There is no layout, record or proof: a name core lists as live
is the terminal. Both need core answering and a Herd;
without either, the host logs a warning and keeps going. A start drawn on the board runs
with the Herd's directory as its cwd, and that is what places it
([ADR-0033](adr/0033-a-run-started-from-the-home-is-placed-not-asked.md)).

A herdr restart cannot take the Home away, because none of it is herdr's.

A launch record is a row of `collie_launches` in `host.db`, keyed by Run and operation
(`<operation>.r<n>` past an agent's first), with its place in the Run's launch order, and
written only by the host: by the launch, by the session its harness reports, by a restart on
core, and by the Cleanup sweep. Every reader asks the table, or the host's `launches` request
from another process; the first host imports every `agents/<run>/*.launch.json` and
`agents/<run>/launches` once and leaves the files in place
([ADR-draft-collies-own-records-live-in-the-hosts-database](adr/draft-collies-own-records-live-in-the-hosts-database.md)).

A Run's agents on herdr come back when herdr restores its session, each resumed in its harness session on a new
terminal, and sometimes without its name. A launch record keeps the terminal and the
harness session herdr reported for its agent, and the Cleanup sweep fills the session in
while the agent is still on that terminal. A restored pane is proved to be that agent by
its session alone, in kind and value, whatever its terminal, name or pane id: the idle
close ends it as that agent, and the Task workspace sweep counts it as Collie's pane. The
sweep records the session for a live Run's agent too. Where another agent has since been
started on its name, its stop controls are that agent's: a restored pane whose harness works
outside the pane cannot be made Quiet, and is left open. A pane with no session, or one no
launch recorded, proves nothing
([ADR-draft-a-finished-runs-idle-agent-is-closed](adr/draft-a-finished-runs-idle-agent-is-closed.md), D4).

## Steering ledgers

Two append-only records, both written only by `steering.ts`, both read by deriving state
from their lines rather than by rewriting them:

- `collie_deliveries` in the host's `host.db` — one row per state change of one message to
  one agent, in one ledger per incarnation, written only by the host
  ([ADR-draft-collies-own-records-live-in-the-hosts-database](adr/draft-collies-own-records-live-in-the-hosts-database.md)).
  Other processes read it through the host's `deliveries` and `overridden` requests; the
  first host on a state directory imports every `agents/<incarnation>/deliveries.jsonl` once
  and leaves the files in place. When retention forgets a Task, the ledgers that name only
  its Runs go with it. `reserved` is written **before**
  herdr is called, so a crash leaves a durable record that something may have been sent;
  `submitted` and `acknowledged` are separate facts and are never collapsed.
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

The build also embeds the release tree, everything an installation reads at runtime
([ADR-draft-an-installation-is-the-release-its-runner-carries](adr/draft-an-installation-is-the-release-its-runner-carries.md)): the plugin
manifest, `install.sh`, `prepare.sh`, the shipped workflows, personas, prompts, the operator
skill, the notification logo and `release-p256.pub`. `tools/build.ts` stages that list as
one directory and passes it to Bun's compile `assets`, so a compiled runner reads it at
`/$bunfs/root/release`. The build refuses an artifact that does not carry every staged file,
as it refuses one without its native renderer. It also stages the `hc` archive that
`hc-pin.json` names for the target, as `hc/herdr-core.tar.gz` (`bundleHc` in
`tools/hc-release.ts`): fetched from `HERDR_RELEASES_URL` (upstream's by default), kept in
`node_modules/.cache/collie-hc`, and refused, failing the build, where it does not hash to
the pin or the pin names no `hc` for the target. hc's licence notices travel inside its
binary (`hc --licenses`). `placeRelease` in `src/release.ts` writes the
tree and the runner into `<Collie directory>/release.new` with `placed.json`, each file's
sha256, copies every file of the current `release/` that differs from its own record into
`kept/`, then swaps the two. `placeHc` in `src/hc-install.ts` then installs the carried
`hc` where upstream's installer would, or, where the archive it last placed without a
failure (`<Collie directory>/hc-placed.sha256`) is another, runs `herdr-core update --from` it. In a placed release `install.sh` and `prepare.sh` leave
`bin/collie` as it was placed. `tools/smoke.sh` checks the built runner places its release
at its own version. Its forge check asks the compiled runner for a missing review target
against a temporary checkout: the missing-input response must offer the pull request
served by the fake forge over HTTP. This exercises the lazily loaded provider without
starting a Run.

`install.sh` authenticates that download with `COLLIE_TOKEN` where it is set, and otherwise
borrows the token `glab` or `gh` already holds for the release host — see
[Using Collie](using.md#install). A private project answers an unauthenticated download
with a sign-in page and HTTP 200, so the install checks the first bytes for an ELF or
Mach-O header instead of trusting `curl -f`.

Every release asset is published with two detached signatures beside it
([ADR-0048](adr/0048-collie-is-released-for-macos-on-apple-silicon.md), D3): Ed25519 as
`<asset>.sig`, and ECDSA P-256 over SHA-256 (DER, base64) as `<asset>.p256.sig`. The
release job signs with `tools/sign.ts`, which reads the private keys from the
`COLLIE_SIGNING_KEY` and `COLLIE_SIGNING_KEY_P256` secrets (PKCS#8 PEM). It refuses to run
without either key, and refuses a key that does not match its public key built into
`src/signing.ts`: `release.pub` and `release-p256.pub`. Desktop's onboarding and `collie upgrade`
download a runner through one function, `verifiedRunner` in `src/releases.ts`, which checks
it with `verifyRelease` against `release.pub` before it is used. `install.sh` checks one with
`openssl dgst -sha256 -verify` against `release-p256.pub`, which any OpenSSL or LibreSSL can
do, fetching `<asset>.p256.sig` with the same token as the asset, before it replaces
`bin/collie`. A download that is unsigned, does not match, or whose signature cannot be
fetched is never installed or run, and the runner already there stays. `COLLIE_OPENSSL`
names the `openssl` to use; without one that answers `version`, the download is refused as
unchecked rather than mismatched.
So a Machine without bun can install a release only once it is signed. The check is the
target release's own `install.sh`, so `upgrade --to` or `onboard --to` a release from before
it installs that release's runner unchecked. Rotating a key means changing both its secret and
its public key file, and
releases signed with the old key stop verifying.

### Numbering a branch's ADRs

A new ADR on a branch has no number: it is `docs/adr/draft-<slug>.md`, and text names it
`ADR-draft-<slug>`, whether a document, a code comment or a test. Two branches open at once
would otherwise both take the next number, and whichever lands second renumbers its ADR and
every reference to it by hand.

Whoever lands the branch numbers its drafts first, from the branch's checkout:

```sh
bun run tools/adr-number.ts            # against origin/HEAD, or master without one
bun run tools/adr-number.ts --base master
```

Each draft takes the next number above the highest on the default branch and on this
branch, in slug order. Every reference to it in the repository follows: the link to
`draft-<slug>.md` becomes `NNNN-<slug>.md` and `ADR-draft-<slug>` becomes `ADR-NNNN`.
It changes only the drafts and the files that name them, and commits nothing; review the
working tree and commit it with the landing. With no drafts left it changes nothing. A
number the default branch already has twice is reported and left as it is.

`test/docs-links.test.ts` fails on a plain-text `ADR-NNNN` or `ADR-draft-<slug>` in the
docs, `src`, `workflows`, `test` or `desktop` that names no ADR file.

Collie's native desktop is built from the release tag by `desktop-native`, which calls
`.github/workflows/rune-bundle.yml` on Linux and macOS. The Rune shell and compiled
TypeScript core share the existing stable identity, `dk.cego.collie.desktop`, and the
existing installer and update artifact names. The installed product is named **Collie**.
`desktop-rune/scripts/bundle.ts` supplies the official brand icons, USTAR update archives,
and metadata the old app's updater accepts, so its next update replaces the webview app in
place. Credentials, saved Machines, conversations and settings keep their existing paths.
See [the cutover decision](adr/0067-collie-replaces-the-webview-desktop-in-place.md).

On macOS the bundle is signed with `ELECTROBUN_DEVELOPER_ID` (ad hoc without one) and
notarised when the Apple credentials are complete. `desktop/scripts/mac-signing.ts` owns
that policy. `tools/verify-mac-app.sh` checks both the built app and the update archive's
app with `codesign --verify --deep --strict`. The legacy environment variable names are
retained for the release's existing secrets.

`tools/sign.ts` signs the installers, update manifests, compressed archives and the
decompressed update tar. The one-line installer verifies its signed download; both the
legacy updater and the native updater verify the tar against `release.pub` before it can
replace the installed bundle. Native launches hold an installation lock while verifying
and swapping a staged update. A refused update leaves the existing app runnable.
Machine onboarding verifies its runner before upload and reuse (`desktop/src/bun/onboarding.ts`).
`COLLIE_DESKTOP_RELEASES` can name another release URL, but downloads still require the
release signature. `COLLIE_DESKTOP_GITLAB` and `COLLIE_HELLE_URL` supply test endpoints;
the defaults remain `https://gitlab.cego.dk` and `https://helle.cego.dk`.

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

`check` runs `check:static`, which is formatting, lint, and type checking in parallel, then
tests after all three pass. Keeping those phases separate avoids CPU contention with the subprocess-heavy tests.
The individual scripts in `package.json` still work for focused feedback.

Lint enables Effect's correctness, effect-native, and strict presets. Effect findings
fail the check, including native collection helpers, synchronous schema decoders,
untyped error channels, and resources started outside their Effect context. `lint:ts`
uses `effect-tsgo oxlint` directly so lint cannot silently lose Effect rules when a
package installation skips the patch hook. Root typechecking also covers `tools/`.

Typechecking runs tsrs, a Rust port of TypeScript 7.1, with `--fast`: it reports what
`tsc` does in a fifth of the time and under half the memory. The Effect language service's
diagnostics are off in `tsconfig.json`, so typechecking needs no Effect plugin; lint
reports them.

`lint:vue` prepares Nuxt's declarations and projects Vue scripts and template expressions
through Vue's compiler before running the same rules. Diagnostics map back to the Vue
source. Static attribute and slot names are excluded because their generated JavaScript
bindings are not expressions written by the author. Both lint commands run in CI through
`lint` and `check:static`.

An exception names the missing equivalent or compatibility boundary where it applies.
Examples include callback string replacements, synchronous process-exit cleanup,
Ed25519 signing, erased errors from authored workflows, and the public `HostApi.usage()`
method. Numeric schemas require finite values; measurement ratios and interval bounds
retain infinity where the statistical model requires it. Electrobun's Cottontail config
loader cannot parse Effect's modules, so its signing-config helper remains native.
Pinned Hutch also starts build hooks in Cottontail. Their small native launchers run the
Effect implementations under Bun, preserving environment, output, and exit status.

Workflow and cluster modules remain architectural dependencies under ADR-0014, so their unstable-API rule is
disabled. Vendored lint sources and author workflow fixtures keep their separate
toolchains; first-party build scripts and process fixtures are linted.

The suite builds its SSH and Codex protocol fixtures with the runner and forwarding
fixture. A focused source test builds each needed protocol fixture once under its
isolated home. This keeps repeated process starts within their existing test budgets.

Root tests import Desktop modules and libraries, so the root `bun install` installs
Desktop's dependencies too, frozen to `desktop/bun.lock`. After changing Desktop's
dependencies, run `bun install` in `desktop/` first: the root install refuses a stale
Desktop lockfile. CI relies on that one install before its root gate.
The core's TypeScript is checked by `cd desktop && bun run typecheck`. The Rune
workspace has its own format, clippy, tests and bundle jobs; the required CI gate includes
both native platform bundles. The removed Nuxt app needs no Vue compiler or lint plugin.

A test leaves nothing behind. `test/support/hosts.ts`, a preload, gives each test file a
temporary root of its own, `TMPDIR` inside it, and removes it when the file ends. Every
process a test starts carries `COLLIE_TEST_ROOT` naming that root, and every host is told
(`COLLIE_HOST_WATCH_PID`) to live no longer than the test process. After each test, a host
still holding a directory under the root is killed and whatever the test made directly
under the root is removed; either fails the test, naming what it left. After the file, a
process still carrying the marker is killed and fails the file, as does what a `beforeAll`
made and left. A test that failed or timed out is cleaned up the same way, because Bun
does not interrupt a timed-out test's own scope. `bun run test` first removes every
`collie-test-<pid>-*` root whose pid is dead, and kills what still carries its marker, so
a killed suite is cleaned up by the next one; a live pid's root is another suite's and is
left alone.

The root is made on a memory filesystem, `/dev/shm` (`COLLIE_TEST_MEMORY` names another),
while that is writable and has 2 GB free, and under `tmpdir()` otherwise, as on macOS. A
test's hosts commit to SQLite and its fixtures write git objects, and on a disk each of
those waits for an fsync: on vm-mk a baseline shard took 33.6 s on `/dev/shm` against
40.4 s on `/tmp`. The sweep looks in `tmpdir()`, `/tmp` and the memory filesystem. Every
git a test starts runs with `gc.auto=0` and `maintenance.auto=false`, set through
`GIT_CONFIG_*` and the test home's `.gitconfig`: housekeeping in a repository a test is
about to remove is work nobody reads.

The same preload keeps the suite out of the operator's herd. Before any test file loads it
drops `COLLIE_USER_DIR`, `COLLIE_CWD` and every `HERDR_*` variable but `HERDR_API_SCHEMA`,
which the contract check is given on purpose, and sets `HOME` to a directory under that
root. So a suite run from a herdr pane neither reaches the live session's socket nor
resolves the default state directory under the real home. A host a test starts inherits
that environment. A test that needs herdr sets up the fake under `test/support/`;
`test/isolation.test.ts` fails if the live socket or home gets through.

`bun run test` (`tools/test.ts`) takes the per-user suite lock, then compiles `collie` the
way a release does, and the fakes' forwarder the same way, into `.scratch/test-bin/`, and runs the suite with
`COLLIE_TEST_BINARY` and `COLLIE_TEST_FAKE_HERDR` naming them: the suite starts well over a
thousand hosts, commands and herdr calls, and a bytecode build starts in a fraction of the
time the sources take to load. A fixture's own Config provider carries that binary choice,
the process marker, the watched pid and the test's stop grace into its commands too;
isolating its installation must not lose the suite's process settings. It uses [Bun's process-parallel
runner](https://bun.com/docs/test/parallel) with a fresh global per file, and as many
workers as the Machine has cores free (see [Keeping the suite and a start
fast](#keeping-the-suite-and-a-start-fast)). The lock also covers
builds so a queued suite cannot replace the executables an active suite runs. Tests within
each file stay sequential: fixtures
change environment variables and prototypes, so `--concurrent` is not safe here. A test's
default timeout is 30 seconds rather than Bun's five: a test that starts processes is
slower on a busy machine, and that is not a hang. The `test/support/hosts.ts` preload sets it,
so every `bun test` gets it, the gate's and an agent's alike. For debugging, `bun test
./test/engine.test.ts` runs one file against the sources, without workers.

One whole suite runs at a time on a Machine, per user. `bun run test` takes a lock,
`collie-test-suite-<uid>.lock` in `TMPDIR`, and a second waits its turn: it prints once who
holds the lock — the pid, its command line and when it started — and then, every 30
seconds, how long it has waited (`tools/suite-lock.ts`). Which forms take the lock:

- `bun run check`, `bun run test`, and `bun run test <args>` whose arguments name no
  existing file or directory and no `--changed` — `-t <name>` alone, or a filter that is
  not a path — run the whole suite and take the lock.
- A targeted `bun run test`, one naming an existing file or directory or passing
  `--changed[=<ref>]`, does not (`tools/test-run.ts`). The lock guards the cores and the
  executables in `.scratch/test-bin/`; a run of a few files needs few cores, builds into a
  temporary directory of its own that it removes when it ends, and reads
  `.scratch/test-timings.json` without updating it. One that names a directory, or more
  files than the budget keeps for small runs, needs a suite's cores: it builds and reads
  the timings as a targeted run, but takes the lock and its workers as a whole suite.
- `bun test <file>`, `bun test -t <name>` and `bun run test:live` do not: they run the
  sources directly, and join the budget as a small run (see [Keeping the suite and a start
  fast](#keeping-the-suite-and-a-start-fast)).

`bun tools/suite-bench.ts` is the benchmark harness a [Measurement](cli.md#measure) of the
suite runs: one whole `bun run test`, its output on stderr and its exit code kept, then a
last stdout line of `own_ms` (built plus ran), `queued_ms` (the wait behind another suite or
the budget), `passed` and `failed`. Output without the runner's `test: queued` line or
Bun's summary is an error, never a zero.

### Tests against an installed harness

A handful of tests ask the installed Claude, Codex, OpenCode and Pi whether they still take what
Collie's adapters pass them, Pi's version floor among them. Their answer depends on the
version installed on the machine, so they are never part of `bun run test` or `bun run
check`: `onMachineWith` (`test/support/live.ts`) runs them only where
`COLLIE_LIVE_HARNESSES=1` is set and the harness is on `PATH`, and the suite runner drops
that variable. `bun run test:live` sets it for the files that hold them, and `test/live-tests.test.ts`
fails where a file of them is missing from that script. A harness
that is not installed is skipped even then, so a machine with some of them checks those.

Run them when a change touches a harness adapter — how an agent is launched in
`src/agents.ts` or `src/harness.ts`, or a harness's controls in `src/compactors.ts` — or
compaction in `src/compaction.ts`, and after upgrading a harness.

`bun run tools/tautology-probe.ts` checks the reviewer's wording rather than a harness. It
runs the shipped reviewer, three times by default, over the change in
`tools/tautology-fixture/`, told what a review Run's reviewer is told. It fails unless most
runs raise every Tautology in the fixture's key and none of its honest items
(ADR-draft-a-tautology-proves-nothing). Each run is one full review on a real model, so it is
never part of the suite. Run it when a persona or a review step's instructions change.

Bun records file durations in `.scratch/test-timings.json` and uses them to schedule slow
files first next time. When that file is absent, the runner seeds it from the measured
durations in `tools/test-timings.json`, so a fresh checkout starts its longest files first
too. Bun's merge keeps every file it ever timed, so before a whole suite runs, the runner
drops the entries for test files that no longer exist (`prepareTimings` in
`tools/test-run.ts`); otherwise the report would name a deleted file as the longest. A
targeted run leaves the file alone. Refresh that seed from a successful complete run when
the suite changes substantially.
Missing or stale entries cannot skip a test; deleting the scratch file restores the seed.

CI runs `bun run check` in two halves. The `static` job runs `bun run check:static`
(format check, lint and typecheck), then the build, smoke and contract check. The `suite`
job is a matrix of three shards, each running `bun run test --shard=i/3` on a runner of its
own. Bun splits the files by their recorded durations, and no shard restores a timings
cache: each balances on the committed seed alone, so all three split a commit's files
alike, and every file runs in exactly one. The required `test` job needs both, runs even
when one of them failed, and fails unless each succeeded.

`bun run test --shard=2/3` reproduces shard 2 locally. It is a whole suite, so it takes the
suite's lock and share, and agents do not run it. To split as CI did, delete
`.scratch/test-timings.json` first, so the runner starts from the seed, and again after,
since the run leaves only its shard's files in it.

Each shard uploads the timings it updated as the artifact `test-timings-shard-<i>`. Bun
rewrites that file with only the files it ran, so each holds its own shard's durations. To
refresh the seed, download them from the latest three green runs (`gh run download <run-id>
-p 'test-timings-shard-*' -D <dir>/<run-id>`) and run `bun tools/timings-seed.ts
<dir>/*/*/test-timings.json`, which writes each file's mean. One run is not enough: a
runner can be about 20 % faster than its siblings, and a seed copied from one run carries
that into every later split. Bun cuts the path-sorted files into contiguous ranges of equal
seed time, so no seed evens out runners that differ in speed on the day. Quiet-agent tests
use a controlled Effect clock so machine load cannot consume their nudge windows. A test
whose work waits out timers runs under `fastForward` (`test/support/effect.ts`): a test
clock a fiber of its own keeps moving many times faster than the wall's, from the wall's
now.

Workflow-authoring tests still install real packages and run the real compiler. Their
isolated homes use [Bun's cache preference](https://bun.com/docs/runtime/bunfig#installprefer)
against `.scratch/test-packages/`, so each fixture does not refresh registry metadata.
An uncached package is fetched normally. Bun may hardlink an installed package to the
cache, so a fixture removes the file's directory entry before writing altered bytes. A
regression keeps a hardlinked copy and checks that it stays unchanged. `XDG_CONFIG_HOME` is removed before
tests load so the operator's Bun configuration cannot replace these settings. Neither
package caching nor scheduling data caches test results.

Documentation changes in the same merge request as the behavior it describes. There is no
docs lint to catch a page that fell behind — a stale page is a defect like any other.

### Keeping the suite and a start fast

Each of these, where it crept in, cost the suite minutes or every start a large share of
its time.

- **The suite shares the Machine.** Every `bun run test` takes its workers from one budget
  of test processes per user per Machine
  ([ADR-draft-test-processes-share-one-budget-per-machine](adr/draft-test-processes-share-one-budget-per-machine.md);
  `tools/budget.ts`). The budget is two thirds of the cores, at least 2, and
  `COLLIE_TEST_BUDGET` sets it. A quarter of it, at least 2, is kept for small runs: a
  targeted run of no more files than that, with no directory among them, or `--changed`. A
  targeted run naming a directory or more files is the size of a suite and takes from the
  rest, as a whole suite does, so a small run never waits behind it. A whole suite asks for
  all the rest, so whole suites run one at a time. A targeted run asks
  for 2, and a `--parallel=N` before any `--` asks for N. A run gets no more than its kind's
  share, and says so when it gets fewer than it asked for. On vm-mk that is 12 workers for a
  whole suite out of 16. Each of CI's suite shards sets a budget of 6 on its 4-core runner,
  giving it 4 workers. Two thirds of 4 cores is a budget of 2, and a budget of 4 would still keep
  2 for targeted runs, which never run on a dedicated runner. At 4 workers the suite ran in
  692 s, against 1,003 s at 2. More workers than cores there is unmeasured. Where the rest would be under 2, as on two or three cores, every
  run takes from the whole budget in turn. A run is admitted as soon as its share has the
  workers it asks for free, whatever waits before it; arrival order decides only between
  runs that do not fit, and an earlier one that fits once workers free up is never
  overtaken. A run asking for many workers can so wait behind a stream of smaller ones.
  A wait names who it is behind once, then says every 30 s how long it has waited. The store
  is `collie-test-budget-<uid>` under the temporary directory, changed under
  `src/lock.ts`'s lock. A hold names its runner and the `bun test` it started, and it is
  reclaimed only once both are gone, each known by pid and start time. An interrupted run
  gives back what it held. A whole suite admitted by the budget also takes the old
  `collie-test-suite-<uid>.lock`, so a checkout from before the budget still takes turns
  with it. The `bun test` a run starts is told its hold in `COLLIE_TEST_HOLD`. A run ends
  with a report: seconds queued, built and run; workers and budget; for a whole suite, the
  longest file, its share of the run, and the per-file time summed from the updated timings;
  the processes started; and `/proc/pressure/cpu`'s `some avg60` and the 1-minute load at
  admission and at the end. Where there is no `/proc/pressure`, as on macOS, the pressure is
  not available. This replaces #135's one-second idle sample, which picked one worker per
  idle core and so oversubscribed the Machine whenever the moment after the builds was idle.

  A bare `bun test`, one `bun run test` did not start, joins the same budget as a small run
  (`test/support/budget-preload.ts`). Three things Bun 1.4.4 does decide how:
  - under `--parallel` with more than one file, only the `--test-worker` processes run the
    preload, never the coordinator; a run of one file stays in one process, which runs it
    once;
  - a top-level `await` in the preload delays the first test and counts against no test's
    timeout;
  - `--isolate`, which every worker runs with, runs the preload and its `afterAll` again for
    each file, and resets `process.env` between files.

  So each run of the preload takes one worker from the reserve, in turn with the other small
  runs, and gives it back when its files end: once per file in a worker, once for a whole
  plain `bun test`. A worker holds nothing between files, so the reserve goes round in turn.
  A wait says whom it is behind and how long it has waited, as a run of `bun run test`
  does, and an admission says how long it queued and how many of their workers small runs
  then hold. One that dies is reclaimed like any other hold. The preload runs before
  `hosts.ts` points `TMPDIR` at the file's own root, so it finds the same store as
  `bun run test`. A process with `COLLIE_TEST_HOLD` set already runs on a hold, and takes
  nothing.

- **A test starts a process.** Each start costs the Machine, and an endpoint sensor more
  again. `bun run test` sets `COLLIE_TEST_STARTS` to a fresh file, and the compiled
  `collie` and each call of the fake herdr and fake forge append a line naming themselves
  and what they were asked, such as `herdr agent list` or `collie host` (`src/starts.ts`);
  a fake's line is written by the test process that answers it. Before each test the
  preload sets `COLLIE_TEST_FILE` to the file running, every process the test starts
  inherits it, and each line ends with a tab and that file. The suite ends with
  `test: <N> processes started` and the ten largest sources, then the ten files that
  started the most, each with its three largest sources. The count leaves out what never
  reaches those entry points: `collie` running as bun under `BUN_BE_BUN`,
  real `git`, `ps` and `sleep`, the `sh` shims and stubs, and the fake `ssh` and the
  master it keeps. It first showed `herdr session list` as the largest source, at 3,970 of
  11,125: every board build read the sessions again, and a build then followed every write
  under the state directory. A host's board now reads them once a minute, as often as its
  event watch does (`SESSIONS_EVERY` in `src/herds.ts`), so a session that starts later
  is on the board within that minute, and News and the Homes' restating read them as
  often. A sweep still reads them fresh: cleanup must never judge a newer session's agents
  gone. Attributed by file, the board's builds were then most of the `agent list` and
  `pane list` starts: a write or a Run recorded built the board again, and each build read
  herdr's agents and panes, though neither moves an agent. A build now reads them again only
  after herdr's own event or the board's 5 s tick (`herdrMoved` in `src/host.ts`), and a Run's
  drawer takes the agents the board last read, rather than reading herdr itself. `run show`
  still reads herdr, since the board can be up to a tick behind on an agent herdr has
  dropped, and its reading becomes the board's: a drawer opened after it draws what it said.
  The event watch opens its socket before it lists the agents it subscribes to, so a session
  it cannot watch is not listed every 5 s for nothing.
  A timer tick requests a board refresh without advancing its write coverage. Readers
  wait for writes the host has seen, while an idle timer refresh can finish in the
  background. A write during that refresh still requires a subsequent covering build.
  The board is read from the host's Run model (`src/run-model.ts`,
  [ADR-draft-a-runs-record-is-read-from-its-hosts-run-model](adr/draft-a-runs-record-is-read-from-its-hosts-run-model.md)).
  It keeps each Run's disk inputs in memory, and a change dirties only the Runs it names:
  host writes before and after the write; the state directory's watch, before the
  board's debounce; another process's SQLite commit, seen within 250 ms through
  `PRAGMA data_version`; and a branch moving in a checkout whose head a card reads, through
  a watch on that checkout's git directories. When all checkout watches are registered,
  the model invalidates its earlier head reads and publishes a change, covering commits
  made before registration. It retains one change for a board that subscribes after the
  first build, so that refresh cannot be lost. A read overtaken by invalidation retries.
  A missing file is kept as its error's data, not as
  the error, since every live `Error` slows each collection of the heap. If the recursive watch
  fails, the model reads from disk, and every read takes a new revision, so nothing derived
  before is reused. Engine status and clock-derived
  fields remain live. Each change to a Run takes the next number of the host's one sequence,
  and each board item carries the highest of its Runs' as its revision. `run_model: false`
  restores the from-disk build at the next host start; the model is then never filled. The
  Run views `collie run list`, `run show` and the `runs` RPC answer still read from disk;
  the Flow that `run show` and `collie_run` carry is the record's, below.
- **A Run's record is read from the model** (`src/record.ts`, D3 to D5 of that ADR). It
  reads only the Runs its Task's rows name (`related` in `src/engine.ts`): the Task's, their
  parents and children, Runs they asked for, and the Runs sharing its plan. A `runDetail`
  request with `parts` is sent the Flow first, at a revision, with `pending` naming the parts
  still coming: `texts` (review and plan), `diff`, `mr` and `tail`. Each part then arrives in
  a frame of its own, and the frame with `pending` empty is stamped with the record's
  revision. A record that moved while none of its Runs did, as a merge request or an agent
  moves it, moves its own Run. After that a frame is sent only when a write the host saw
  changes what the record carries; the 5 s tick is not one of them. A minute count is sent
  as a `clock` beside a `said` left empty, and the front door says it (`timedFlow` in
  `src/flow-timing.ts`). A going Run's diff is taken again for every frame, so an edit not yet committed shows; a
  settled Run's is kept until its checkout's git directories move. A request with `held` at the current epoch and revision is answered
  `Unchanged`; any other is sent the record. `act` and `control` take the revision an act
  was `shown` at, and refuse one whose Step has finished since that revision with `StaleAct` (a Step a record
  shows going again finishes anew; one already finished when shown is not stale), which the CLI
  says as `invalid_state`; each act's result carries the Run's revision after it, which the
  caller's next frame is at least. A request without `parts` is sent whole records, their
  minutes said, on every change and tick, as an older Desktop expects.
  The native view keeps records subscribed after they close (`desktop-rune/board/src/record.rs`
  owns their lifetime): the open one, the last 8 opened and a
  card pointed at for 150 ms, at most 16 MB of frames as Desktop weighs them, the least
  recently opened going first and never the open one. A kept record opened again has its
  frame as it mounts. Desktop's main process holds a record's host subscription for as long
  as the view does (`desktop/src/bun/records.ts`). Its door gone, a record is sent with the
  time its host last confirmed it, and the record says so and takes no action, until the
  next door answers its `held` revision with `Unchanged` or a frame. A host that ends a
  record its door still serves leaves it current.
  A host's `collie_run` answer uses one local Run listing for its facts and Flow, with
  local offers and the same write-covered readiness as `progress`. Flow relationship
  indexes, installation identity and usual Step times are shared across a board build.
- **Records are read on the host's door thread**
  ([ADR-draft-the-host-reads-records-on-a-thread-of-its-own](adr/draft-the-host-reads-records-on-a-thread-of-its-own.md)).
  `src/door.ts` is a Bun Worker. It owns `host.sock` and answers `identity` and `runDetail`
  itself, on a heap and a loop of its own. It passes every other frame to the engine on the
  main thread, by its connection, so the engine's collections and Steps never hold a record
  back. The door keeps a second Run model:
  - Its revisions come from the same counter in shared memory as the engine's.
  - It forgets what the engine's model invalidates.
  - It takes each Run the engine listed, with the revision its view was read at, and the
    offers the engine's board read since the last listing (a plan ready to implement's).
  - It asks the engine (`doorFeedLayer` in `src/host.ts`) when a record's Runs are older than
    their revision, or still going, when a record's Run has a merge request, or for the
    offers of a Run the board has not read.
  - A store write moves the revision of the Runs it names.
  - A Step a record first showed finished is told to the engine, which judges acts.
  - At its first listing it reads the first ten Runs' records, for its JIT, and the engine
    logs how long that took ("the door has read 10 records to warm it").
- **Interactive reads come first** (D6 of that ADR). The board keeps each Task's card with the
  key it was derived from (`KeptCards` in `src/board.ts`): its Runs' revisions, markers,
  agents, pending work and merge request states. A build derives a card again only when its
  key moves or the time it shows is due to change, so a write derives one card and a tick
  none. The Run views are kept the same way once their execution has finished (`KeptViews`
  in `src/engine.ts`). A pass over many Runs (the model's fill, a board re-derive, the
  engine's sweep, `tendQuestions`, Cleanup) takes `Foreground`'s `boundary` before each Run
  (`src/foreground.ts`). A record's first frame and parts, an offer, an answer, a control and
  an act run under `serve`, and while one does, every boundary holds its pass, for at most
  250 ms. The host runs on `TurnScheduler` (`src/turns.ts`), which ends a turn of the event
  loop once its fibers have run for 8 ms. A fiber under `serve` queues its tasks ahead of
  every other fiber's, and the others yield while one waits, so a Run start's work steps
  aside for a read at its next yield. Cleanup's sweepers judge and remove through the
  model's reading (`sweepingWith` in `src/cleanup.ts`), so a sweep reads from disk no Run
  file the board has not, beyond those it removes. A record takes herdr's agents as the board
  last read them, rather than waiting on a read in flight. What lag is left is
  JavaScriptCore's Eden collections, 11 to 27 ms each about once a second at a ~100 MB heap;
  the ADR says why no worker thread was built.
- **A test waits for a state.** It waits with `until` (`test/support/host.ts`) for what it
  needs: a run `suspended`, a file written, a pane gone. Real IO takes the time it takes,
  and a fixed sleep is too long on an idle machine and too short on a busy one. Work that
  waits out its own timers runs under `fastForward`, test by test: a file whose time goes
  to real IO runs slower under a fast clock, because its polling keeps firing.
  Before adjusting `TestClock`, wait for the actual sleep to be registered. A lock
  release can precede that registration, so observe the Clock service's sleep rather than
  assuming a filesystem event means the timer is ready.
- **A test starts the build.** A helper that starts `collie` or its host runs
  `COLLIE_TEST_BINARY` when it is set, as `test/support/host.ts` does, and the sources only
  without it. A start from source is most of a second of CPU, and the suite makes over a
  thousand.
- **A host is stopped while its run waits.** Production has a five-second stop grace;
  fixture hosts use 500 ms. Cleanup waits for process exit as well as lock release: a
  host can give back its lock before its final write finishes.
  On Linux, a world's cleanup also waits for processes carrying its exact fake-herdr log
  binding: a herdr call can outlive its host and recreate a removed log directory. This
  uses the preload's existing `/proc` process markers; its marker-specific regression runs
  on Linux.
- **A fixture runs a command.** `test/support/command.ts` uses asynchronous `Bun.spawn`,
  drains stdout and stderr together, and closes the process group when its scope ends.
  A nonzero exit remains visible; an interrupted fixture cannot leave its child running.
  The fake herdr's and fake forge's executable is one forwarder, compiled once and named by
  both `COLLIE_TEST_FAKE_HERDR` and `COLLIE_TEST_FAKE_FORGE`. The test process answers each
  call with the fake's core, under the caller's environment and with only filesystem, path
  and that environment as Config, so it keeps the same state, model, call log and exit
  codes. An isolated world's environment carries that executable through its Config
  provider. A focused `bun test` still runs the forwarder's source with this process's Bun
  executable, without needing `bun` on the fixture's PATH.
- **A test can go red.** Break `src/` the way its name says and watch it fail before relying
  on it. A test that cannot fail, or whose every failure another test already has, is
  deleted.
- **A run is one baseline scenario.** Each scenario runs in one of `SHARES` shares, a hash
  of its name, and each share is two files: `baseline-NN` as shipped and
  `baseline-unrelated-NN` under unrelated ids. Handing all of them to a serial
  `bun test -t` took 8–11 minutes for one scenario (#233). `bun run scenario "<pattern>"`
  (`tools/scenario.ts`) matches the pattern as `-t` does, against each pass's full test
  names, and runs only the files holding a match through `bun run test`, with
  `--parallel=<files>`. A pattern matching no scenario runs nothing and exits non-zero. For
  more than a few other files, run `bun test --parallel=N <files>`.
- **A test is flaky.** Measure it with `bun test --rerun-each N <file>`, narrowed with
  `-t "<name>"`, run through `collie verify` under the Machine's own load. Each run of the
  file gets a fresh root, `TMPDIR`, `HOME` and marker from the preload, and is checked and
  cleaned as a single run is. Never add load to provoke it: no busy loops, no stress tools,
  and no script that starts processes of its own. A builder's own loop for #130 left 16
  busy loops orphaned on the Machine.
- **An installed harness creates temporary files.** Give a server probe a scoped
  `TMPDIR`, including its extracted native libraries, and wait for the server to exit
  before removing it.
- **A front door loads what it runs.** `src/main.ts` imports each front door with
  `import()` once it knows which one runs, and `src/` imports `@effect/platform-bun` and
  `effect/http` by module rather than through their index. `test/startup.test.ts`
  holds the first and keeps the engine and the board out of the compaction helper; lint
  holds the second.

### Measuring a record open

The native app's Settings has **Record timing** (off by default), which appends view and
core marks to `record-timing.log` in the existing desktop state directory, one JSON line
each. `bench/record-open/summarize.ts` summarises those logs; `desktop/README.md` describes
the workflow. `bench/desktop-start/` retains the isolated host fixture for startup measurements.

The Nuxt/CDP benchmark driver was retired with the webview app. Its reusable fixture,
statistics, comparison and log analysis remain in `bench/record-open/`. Historical browser
measurements are not measurements of the native renderer.

### Test-suite measurements, 26 October 2026

Measured on vm-mk (24 cores, Bun 1.4.4) on ef9b4555, under the Machine budget of 16 with 4
kept for small runs
([ADR-draft-test-processes-share-one-budget-per-machine](adr/draft-test-processes-share-one-budget-per-machine.md)).
Each experiment started only once `/proc/pressure/cpu`'s `some avg60` was under 10 %, and
none ran beside another. None had to be abandoned for pressure over 50 % for two minutes.
Each suite ran through `collie verify`; the logs are run-a0ff8856.implement's
`09-*` verifications, and the driver and its samples are that Run's
`handoffs/09-measure/`. Every suite had 4,633 tests in 314 files. The base, 5a479a85, took
753 s at 12 workers, with one file at 739 s.

**Workers.** One whole suite at each worker count, one after another
(`bun run test --parallel=N`; 16 with `COLLIE_TEST_BUDGET=21`):

| Workers | Including builds |     Ran | Summed test time | Per test | Tests per second | Ran ÷ (summed ÷ workers) |
| ------: | ---------------: | ------: | ---------------: | -------: | ---------------: | -----------------------: |
|       4 |          911.5 s | 900.8 s |          3,602 s |   0.78 s |             5.13 |                     1.00 |
|       8 |          574.4 s | 563.7 s |          4,409 s |   0.95 s |             8.20 |                     1.02 |
|      12 |          473.6 s | 464.0 s |          5,310 s |   1.15 s |             9.96 |                     1.05 |
|      16 |          438.1 s | 428.0 s |          6,615 s |   1.43 s |            10.80 |                     1.04 |

Sixteen workers finish 8 % sooner than 12 for 25 % more test time, and use more cores than
a whole suite's share of 12. The share stays at 12. No file is the critical path any more:
the longest, `test/placement.test.ts` or `test/agents.test.ts`, took 40 to 45 % of a run at
12 workers.

**Cores per worker.** One whole suite at 12 workers in a cgroup of its own
(`handoffs/redesign/cpu-of.sh`) used 5,505 CPU-s in 497 s: 11.1 cores, or 0.92 a worker.
At `--parallel=8` on 9263ba29, before tickets 06 to 08, it was 5,582 CPU-s and 9.2 cores.
Sampled every 250 ms, which misses most processes shorter than that, the test processes took
2,438 CPU-s, 529 test hosts 1,346, 773 CLI starts 459, and 3,583 fake herdr and forge starts
39, where 11,448 fake herdr starts had taken 12 % before.

**Queueing.** Whole suites from separate worktrees on the same commit, started together,
with targeted runs of `test/yaml.test.ts` started 120 s in and every 360 s after:

| Case     | Suite |    Queued |  Built |     Ran | Ended after the start |
| -------- | ----- | --------: | -----: | ------: | --------------------: |
| 1 suite  | 1     |    0.06 s |  9.9 s | 464.2 s |               474.1 s |
| 2 suites | 1     |    0.07 s | 10.2 s | 462.8 s |               473.6 s |
|          | 2     |   473.2 s | 10.4 s | 458.9 s |               943.0 s |
| 4 suites | 1     |    0.06 s | 10.1 s | 464.4 s |               475.1 s |
|          | 2     |   474.6 s | 10.3 s | 469.7 s |               955.0 s |
|          | 3     |   954.6 s | 10.1 s | 445.6 s |             1,410.8 s |
|          | 4     | 1,410.3 s |  9.6 s | 473.8 s |             1,894.2 s |

Four suites all finished in 4.0 times one alone. The six targeted runs queued 0.06 to
0.19 s, each while no other small run held the reserve, and took about 15 s to build their
own executables. Sampled once a second, the budget's store held at most 14 workers of 16
(12 whole, 2 small), and at most 12 `--test-worker` processes ran.

**Responsiveness.** `git rev-parse HEAD` in the checkout, once a second: on an idle Machine
for 5 minutes, p50 4.99 ms and p95 7.72 ms; throughout the four-suite case, p50 6.87 ms and
p95 16.34 ms, 2.12 times the idle p95.

**Flakes.** Ten whole suites one after another took 457 to 498 s each including builds,
477.6 s at the median. Eight passed. Two failed one test each, and each passed when run
alone: two Flakes, both the self-improve scenario "a day's findings are filed or commented,
all-new Improvements start, and the summary says so", once under an unrelated id
(`test/baseline-unrelated-09.test.ts`) and once under its own (`test/baseline-09.test.ts`).
The workflow starts its Improvements concurrently, and the scenario expects them started in
order. The check logs of 14 to 26 October averaged about two Flakes a suite. No timeout was
raised and no retry added. The tenth suite first waited 432 s for the old suite lock, held
by a suite from a checkout without the budget.

Against the goals: a whole suite alone takes 474 s including builds, over the 6 minutes
aimed for, though it now runs at 1.03 times its summed test time over its workers (1.79 on
the base). Four queued suites finish within 4.4 times one; targeted runs are admitted at
once; the budget was never exceeded; and the suite fits its 12 cores. The probe's p95 under
four queued suites is over twice its idle p95. Ten suites had two Flakes, over the one
aimed for.

### Test-suite measurements, 29 October 2026

Run `run-af99447d` revalidated #246 (`4cc438f7`) and #253 (`68d583e1`) on master before
measuring `c56e9486455b33a6d3a74f131019e4a18020f980`, on vm-mk with Bun 1.4.4.
The targets remain 360 s including builds and a probe p95 at most twice its idle value.

The windows below were later invalidated as performance baselines. During the first
fix round, the shared Bun cache was found to contain filesystem and SQL counters left
by another Run. The filesystem counter normalized and counted every read, directory
listing and stat, and periodically sorted and wrote its results. Hard-linked installs
carried that instrumentation into both measured checkouts and their compiled binaries.
The owner confirmed the contamination and restored the shared files. The old numbers
remain here as historical observations, not evidence about pristine Collie performance.
This Run reinstalled dependencies in both its checkouts using a private cache and
`--backend=copyfile`. Its FS and SQL files match the published 4.0.1 tarballs, verified
against the lockfile's SHA-512 values, and have private inodes. Raw integrity records
and the invalidated profiles are kept in `handoffs/profile/dependency-integrity/`.

The driver and raw samples are in that Run's `handoffs/measure/`. `drive.ts` runs
`git rev-parse HEAD` once a second, recording wall time, child CPU time, involuntary
context switches, CPU/I/O/memory pressure, load, and the budget's held and waiting suites.
It also runs `sar -u -q -w -d 1`. A measured suite has its own systemd scope, whose
`cpu.stat` separates its CPU use from the rest of the Machine. Both the idle window and
the suite hold the host's Measurement lock, to take turns with run-2a1e10fe's measurements.
No competing load is started for the measurement; other Runs continue.

| Window (UTC)                  | Samples | Probe p50 | Probe p95 | Median load | Mean CPU pressure |
| ----------------------------- | ------: | --------: | --------: | ----------: | ----------------: |
| Idle, 10:44:46–10:49:46       |     300 |   5.07 ms |   7.79 ms |       15.74 |           10.35 % |
| Base suite, 10:49:47–10:59:38 |     591 |   5.90 ms |   9.95 ms |       32.55 |           36.00 % |

The base took 590.58 s including builds (10.45 s build, 580.13 s run): 5,069 passed,
11 skipped, and one timed out, across 324 files. The timeout was
`run-paths.test.ts`'s changed-claim test, which passed in a targeted verification afterward.
The suite used 6,252.81 CPU-s in its cgroup, averaging 10.60 cores; the Machine averaged
17.53 busy cores. I/O pressure averaged 0.55 %, and memory pressure was zero.
The probe's own CPU time stayed near 4.4 ms; its mean wall time rose from 5.46 to 6.36 ms,
with more involuntary context switches. This supports CPU scheduling delay as the
observed slowdown, with both suite and other Machine work contributing.

The probe p95 was 1.28 times idle, but only one suite waited behind the running suite.
This does not prove #216's four-suite target. The suite also misses #215's 360 s target.
Neither issue is resolved by these baseline numbers, and no budget or scheduling change
is justified by a window that does not reproduce the responsiveness failure.

Two per-test costs are removed without sharing mutable test state. The test preload
loads the Solid compiler only when a file imports JSX or Solid's server modules; other
files avoid loading Babel. The handlers still come from the installed Solid plugin.
A clean committed tree's fingerprint needs only `git status`, rather than three Git
starts. Dirty trees and failed status reads retain the diff and untracked-content reads.
Status explicitly includes untracked files even when the user's Git config hides them,
and the fingerprint of an ordinary unchanged tree retains its previous value.

The candidate, `621e7c3a1e753e3da511127b994138c44e00ec37`, ran at
11:09:20–11:23:33 UTC with the same budget, dependencies, and measurement driver.
It passed all 5,074 enabled tests, with the same 11 skips, across 325 files: four tests
were added. It took 850.52 s including builds (10.46 s build, 840.06 s run).
The probe's 851 samples gave p50 8.71 ms and p95 19.73 ms, 2.53 times the earlier idle p95.
No suite waited behind this one. The additional ten-minute passive observation also
caught no four-suite window; at most one suite waited in any recorded window.

Background CPU load was substantially different. The candidate's scope averaged
7.84 cores while the Machine averaged 21.93 busy cores, against 10.60 and 17.53 for the
base. Mean CPU pressure was 53.81 %, I/O pressure 0.10 %, and memory pressure zero.
The sampled cgroup ancestors had no CPU quota throttling. The final cgroup disappeared
before its closing `cpu.stat` read; its interval samples and `/usr/bin/time -v` remain
in `candidate-1/`. No other Run or workload was stopped to obtain these numbers.

These measurements show no elapsed-time gain and meet neither original target.
The differing background load also prevents attributing the elapsed-time difference to
the patch. The compiler-load and Git-start reductions have targeted regression proofs;
their whole-suite performance benefit remains unproved. #215 and #216 stay open, and
the full correctness gate remains CI's `test` job.

The first fix round adds a candidate scheduling mechanism for ticket 02. The old windows
showed scheduling delay, but the contaminated dependencies prevent treating them as an
attribution of pristine Collie's cost. The policy still needs fresh measurements.
A whole-suite child now
starts at nice level 10, or keeps an already lower priority, before the runner opens
its execution gate. Workers and the hosts and commands they start inherit that priority;
small runs retain their caller's priority. Admission, worker counts, and the reserve do
not change. `suite-priority-red` observed the whole-suite descendant still at nice 0;
`suite-priority-green` covers both kinds with real children, alongside the existing
hold and cleanup tests. The effect on probe latency remains to be measured.

The JSX regression was also run with JSX registration temporarily removed from the
lazy preload. `jsx-transform-disabled-red` failed because Bun's default JSX output
lacked Solid's `_$createElement`; restoring registration made both preload cases pass
in `jsx-transform-restored-green`. The temporary mutation is not part of the patch.

A fresh, uninstrumented profile of three placement scenarios still identified module
scanning and filesystem work as costs: `scanImports` accounted for 4.4% of self samples.
Registration was copying its generation again through the general entry loader.
It now imports the already unique generation through the same contract validation,
preserving separate module state and fresh imports when a host recovers work. The
directory is unique on every registration, including recovery in the same process;
`registration-recovery-red` and `registration-recovery-green` cover an edited external
helper across two Registries using the same state directory. The
`registration-copy-red` proof observed three directory copies for the first registration;
`registration-copy-green` observes two, then one for another generation: the shared
catalogue copy is reused and each registration keeps its own single copy. No persistent
source-content cache or weaker edit detection is introduced. Full-suite timings must
be repeated with pristine dependencies before claiming a gain or closing either issue.

Pristine qualification ran at 13:08–13:34 UTC, after run-bd4539a0's final completion
notice, using private FS and SQL dependencies checked against their published tarballs.
The original performance targets remain unmet or unproved:

| Window    | Revision                                   | Whole-suite time with builds | Tests                       | Probe p95 |
| --------- | ------------------------------------------ | ---------------------------: | --------------------------- | --------: |
| Idle      | —                                          |                            — | 300 probes                  |  9.219 ms |
| Control   | `c54a40b88eb57e1bd22faaaab6b6d5b8f10de387` |                     622.40 s | 5,076 pass, 11 skip         | 11.731 ms |
| Candidate | `0716a73754b1339e2de6138c1c9c879dad0771e0` |                     663.71 s | 5,078 pass, 11 skip, 1 fail | 12.974 ms |

Neither suite had another whole suite waiting. The candidate's probe p95 is 1.41 times
idle for the observed window, but that does not establish the required four-suite
condition or a benefit from the priority change. The control and candidate used
6,128.28 and 6,323.28 CPU-s respectively in their complete cgroups. Mean Machine use
was 18.60 and 19.08 cores, versus suite use of 9.86 and 9.53 cores. Mean CPU pressure
was 40.49% and 43.63%, with I/O pressure below 0.10% and negligible memory pressure.
There is no demonstrated whole-suite gain. The candidate's board-stream test failed
when a removed fake agent was still listed; it passed in the isolated diagnostic run.
That failure is retained, not counted as a green measurement. Raw evidence and the
qualification result are in `handoffs/measure/fix1-qualification.json` and the three
`fix1-*-pristine/` directories. The lock was released at 13:34:49.902 UTC.

Further module-load work removes the initial import that only learned an entry's id
before staging and importing it for registration. Registration now stages once and
uses that validated definition directly. `registration-single-import-red` and
`registration-single-import-count-red` exposed the extra copy and top-level import;
the green proof still checks separate registrations and external-helper recovery.
Revision calculation also reuses source bytes between import scanning and hashing
within one calculation. `revision-read-once-red` observed duplicate reads; its green
proof checks one read per source and an edited helper on the next calculation. This
cache ends with each calculation; dependency resolution and edit detection remain
fresh. These cuts need a new measured qualification, coordinated after the other
Run's next announced final-tree study; no further window was taken ahead of it.

On 30 October, the other Run's actual final-tree completion notice opened the next
qualification on `aedcd26dd6821134d1887e7c06780a8f0532dd71`. Both new attempts failed
to obtain an idle baseline while ordinary work continued on the shared Machine:

| Attempt | UTC window        | Probes | Probe p95 | Samples with a whole suite held | Samples with one waiting |
| ------- | ----------------- | -----: | --------: | ------------------------------: | -----------------------: |
| `fix1b` | 07:12:27–07:17:27 |    300 |  10.80 ms |                             199 |                      191 |
| `fix1c` | 07:32:13–07:37:13 |    300 |   9.14 ms |                              78 |                        0 |

These are contention observations, not qualifying idle measurements. `fix1b` was
interrupted after its control entered its initial phase; it completed no suite and
never started the candidate. The collector's new guard rejected `fix1c` before either
suite started. All 600 probes, the partial control log, and the rejection record are
retained in the Run's handoffs. No completed observation was repeated or discarded,
and no other Run was stopped or reprioritized. No measurement job remains running
from this fix step.

The collector now waits for live whole-suite requests to clear and rejects an idle
window if a whole suite runs or queues during it. Four-suite evidence additionally
requires the candidate's held budget entry to name a PID in its measured cgroup;
a candidate waiting behind another branch cannot prove its own scheduling policy.
Both guards have failing-first self-checks. The raw sampler retains this ownership
as an additive field; older observations are unchanged.

A separate whole-suite timing on the latest runtime, committed as
`d5710ea2e9d0de4704682a1e30ed6495479cfbfa`, started at 08:06:23 UTC. The host upgrade
to Collie 0.107.1 stopped its check at 08:14:41, before a suite summary or the driver's
final result. Its log ends with exit 130. Raw samples and the host interruption record
are retained under `handoffs/measure/fix1-final-head-suite/` and
`fix1-final-head-suite-interrupted.json`. It ran beyond 360 seconds, but it is an
interrupted observation, not a completed timing or correctness result. No replacement
measurement was started.

At the end of fix round 1, the source had targeted cost and preservation proofs, but
no qualifying whole-suite measurement. Its last completed pristine candidate took
663.71 seconds on `0716a737`. No required four-suite responsiveness window has been
observed. Both remain blocking findings, with no claimed performance gain or issue
closure. Further per-test cost reduction and a qualifying natural queue observation
are still required. The supplied plan forbids starting load solely to create
contention; a controlled-load exception or different infrastructure requires the
human's decision. The CI correctness gate remains the `test` job.

Fix round 2 shares one source-tree read between a Registry registration's revision
and staging. The failing-first `fix2-registration-source-red` observed four root
directory listings for one registration; its green check observes one listing and
one read of each source, while retaining separate imports and copies per generation
and fresh external-helper recovery. The source snapshot lasts for that registration
only. The six focused loader suites pass, including entry, helper and prompt edits
while older work keeps its generation. These operation counts establish the removed
duplication; they do not establish either whole-suite performance target.

Three fixed AB/BA pairs profiled the same three placement cases on `e51af012`
and `cdd63d94`, using the isolated checkout, Measurement lock and private dependencies
checked before and after every process. All six processes passed. Median wall time
was 7.215 versus 6.963 seconds; median CPU time was 11.25 versus 10.77 seconds. One
candidate process took 10.640 seconds, so these observations do not establish a gain
beyond noise. Every observation and profile is retained under
`handoffs/measure/fix2-placement-pairs/`.

The filesystem-boundary check also found attempts to read ordinary source files
as directories. The source walker now checks file type before a
directory read. `fix2-file-directory-red` observed one such attempt; its green check
observes zero. Directory links remain named without traversal, and the revision
proof retains that behavior while checking fresh reads after an external-helper edit.

Qualification `fix2a` completed on `b193bbe9840fb29e4da277a9cc7cecb2e0ff4827` without
a host interruption. Its 300 idle probes had no whole suite held or waiting and a
p95 of 8.957 ms. The whole suite took 592.60 seconds including builds, used 5,676.67
CPU-s in its cgroup, and reported 5,213 pass, 11 skip and one failure. Its 592 owned
samples had no second whole suite held and no waiter; overall probe p95 was 9.86 ms.
There were zero qualifying four-suite samples. Both targets remain unmet or unproved;
these different revisions and workloads do not establish a causal suite gain. Raw
logs, samples, integrity checks and the result remain under `handoffs/measure/fix2a-*`.

The board-stream failure was reproduced with diagnostics: generic-title naming
overwrote the test's external `Renamed` task label with `Hi`, so its first subscriber
correctly received the wrong title. Naming had checked the task before a herdr call
and later written that stale record. Two deterministic tests change the task during
workspace listing and renaming; both failed before the fix. Naming now checks the
current task after those calls and preserves newer edits and metadata. The original
board-stream assertions and timeouts are unchanged; no delay, skip or retry repairs
the failed measurement, which remains recorded as a failure.

A fresh trace of three placement cases recorded 18,140 file opens, including at
least 5,912 `ENOENT` results. Absent Run metadata files were repeatedly opened. An
experiment used fresh directory listings to skip eight missing-file reads per view;
its preservation checks and 166 affected tests passed. In three fixed AB/BA pairs,
however, median wall time worsened from 6.956 to 7.174 seconds and CPU time was
effectively unchanged, 11.00 versus 10.96 seconds. The experiment was reverted.
Every observation is retained under `handoffs/measure/fix2-view-pairs/`; fewer
file reads alone did not justify the added complexity.

The placement tests now poll the existing status API while waiting for completion,
then read the full Run once for their assertions. Three fixed AB/BA pairs on
`943649c5` and `973a35c2` passed all three selected cases in each process. Median
CPU time fell from 11.11 to 10.45 seconds; the candidate range, 10.27–10.54 seconds,
was below the control range, 10.81–11.33 seconds. Median wall time fell from 7.416
to 7.309 seconds. The complete placement and finished-poll files retained all 75
tests and 305 assertions. Wait schedules, limits and final assertions are unchanged.
Raw observations remain under `handoffs/measure/fix2-status-pairs/`; this focused
CPU reduction does not establish either whole-suite acceptance target.

Qualification `fix2b` ran on `196d68609294168d215fd2c1cc8c48b325f39237`.
Its 300 idle probes had no whole suite held or waiting and a p95 of 9.012 ms.
The whole suite took 719.34 seconds including builds: 5,215 passed, 11 skipped
and one failed, across all 5,227 tests. Its cgroup used 6,309.39 CPU-s. The 718
owned samples had no whole-suite waiter and no qualifying four-suite sample.
Mean Machine and suite use were 20.66 and 8.78 cores. CPU stalls averaged 51.60%;
I/O and memory stalls averaged 0.214% and 0.079%. The scope's ancestors had no
CPU quota, restricted CPU set or recorded throttling. These shared-Machine
observations establish no causal suite speedup.

The failure was Helle's resume test: it granted the fake claim after 30 ms before
the client had necessarily read the pending state. The fixture now waits for the
client's first status output before that same 30 ms wait and grant. Every assertion
is retained. The case passed 20 repetitions; its full file passed all 54 tests and
138 assertions. This repair does not turn the failed whole-suite observation green.

The installed CLI changed from 0.108.0 to 0.108.2 five seconds before `fix2b` ended;
the measured suite used its own executables built from the frozen candidate.
The host stopped afterward, at 10:18:54 UTC, and restarted at 10:19:00 UTC.
That stop interrupted the separate passive observer after 1,324 of its planned
1,800 samples. None showed a whole-suite waiter. Every sample and the exit-130
record remain in `handoffs/measure/fix2-natural-queue-interrupted.json` and its raw
directory. The completed whole-suite result, context and integrity checks remain
in `handoffs/measure/fix2b-*`; no completed observation was retried or discarded.
Both original acceptance targets remain unmet or unproved. The CI correctness
gate remains the `test` job; no local `check` gate was run.

Fix round 3 revalidated prerequisites #246 and #253 against freshly fetched
`d410ba3ec60f6f39c35f237317d85da17705dab9`. Qualification used merged revision
`efeb6a54ff6e4df7d1188993c4130abfdd98be26`, the existing isolated checkout,
and the Machine Measurement lock. Private copyfile installations of the new
Effect 4.1 filesystem and SQLite dependencies matched integrity-verified published
tarballs before and after each process. Earlier dependency manifests remain unchanged.

The 300 idle probes had no whole suite held or waiting; their p95 was 8.433 ms.
The complete suite took 888.56 seconds including builds, with 5,280 passes,
11 skips, and one failure across 5,292 tests. The failed stage claim give-back
scenario expected suspension but observed completion. A focused diagnostic also
failed one of its two variants; its cause remains unresolved. Neither observation
is counted as a green suite result or repaired by a retry.

The suite's 887 owned samples contained no whole-suite waiter. Overall probe p95
was 16.005 ms, which cannot prove the required four-suite condition. Mean Machine
and suite use were 21.49 and 8.79 cores; median load was 50.35. CPU, I/O, and memory
stalls averaged 56.92%, 0.423%, and 0.064%. These observations do not isolate an
exclusive external cause or prove a benefit from the worker priority change.
The final cgroup CPU total was unavailable after the scope disappeared;
`/usr/bin/time` retained 4,744.26 user CPU-s and 1,767.01 system CPU-s.
Raw data, context, protocol, and dependency checks remain under `handoffs/measure/fix3-*`.

A separate shutdown experiment removed process-table scans when a host had no
checks to signal. Its failing-first regression observed three scans, then zero;
all 32 shutdown safety tests passed. Three fixed AB/BA pairs compared `efeb6a54`
with `20a6a0e9`, using separate compiled binaries and the same three engine cases.
All six processes passed. Median CPU time fell from 12.24 to 11.97 seconds,
but the ranges overlapped: 12.02–13.51 versus 11.82–12.18 seconds. Median wall
time fell from 7.884 to 7.544 seconds. The recorded retention rule required
a CPU gain beyond observed variation, so the experiment and its regression were
reverted in `207c823d`. Every observation remains under
`handoffs/measure/fix3-shutdown-pairs/`; no replacement pair or candidate suite was run.
Both original performance blockers remain accepted and unresolved.

Fix round 4 revalidated #246 and #253 on fetched master `e8d02a5d` and used the
merged runtime `90ca541f`. A direct-entry loading experiment reused the source
traversal already needed for its revision. Its failing-first regression observed
two reads instead of one; the changed loader read once and imported an edited
outside helper freshly. The complete discovery file passed all 14 tests.

Three fixed AB/BA pairs compared `90ca541f` with `0af9f7a9` on the full
`baseline-unrelated-03` scenario file. Each of the six processes passed 35 tests
and 379 assertions. Control CPU times were 86.36, 89.88, and 86.72 seconds;
candidate times were 91.25, 89.34, and 86.76 seconds. Median wall time was
73.160 versus 78.037 seconds. The recorded retention rule failed, so the
experiment and its added regression were reverted in `f720b8a4`. No replacement
pair was run. `dc7acd15` replaces four native array calls in an existing revision
regression to satisfy Effect 4.1 lint. Its runtime matches `90ca541f`.

The final qualification attempt used frozen revision
`dc7acd1553660a3e395a28fa7d0ab977b7a5b5f7`.
All 300 idle probes remain recorded, but the entire baseline is unqualified:
another Run reported targeted checks from 12:42:34 to 12:43:00 UTC within that
window. Its descriptive p95 of 10.578 ms is not used for acceptance. No sample
was selected out, and no replacement idle window was collected.

The whole-suite attempt began at 12:47:17 UTC. Its last retained sample was at
12:59:46 UTC, and the host log records version 0.109.1 starting at 12:59:52 UTC.
The command ended with exit 130 and four files still running. Its 749 samples
span 749.119 seconds; this exceeds the target but is not a completed suite time.
There is no final test summary. Before interruption, two stage claim give-back
cases expected suspension but observed completion; their cause remains unresolved.
The attempt was not retried or labeled green.

The 748 owned samples contained no whole-suite waiter or qualifying four-suite
sample. Their descriptive probe p95 was 14.172 ms. Mean Machine and suite use
were 20.80 and 9.72 cores; CPU, I/O, and memory stalls averaged 50.588%, 0.327%,
and 0.002%. These observations establish no exclusive external cause or timing
acceptance. A later report of prototype work from 13:15 onward does not overlap
the retained samples and does not invalidate them.

The passive phase could not start before the host interruption. Collected
separately from 13:41:58 to 14:11:58 UTC, it retained 1,799 observations with no
whole suite running or waiting. The gap is explicit; this was neither a whole-suite
retry nor a replacement idle window. No four-suite condition was manufactured.

All protocols, raw observations, dependency-integrity guards, the idle
invalidation, and the interruption assessment remain under
`handoffs/measure/fix4*` in Run `run-af99447d`. No completed observation was
retried or discarded. Both original performance requirements remain unmet or
unproved; the full correctness gate remains CI job `test`.

### Test-suite measurements, 2 November 2026

Run `run-40796ebf` followed up `run-af99447d` on vm-mk (24 cores, Bun 1.4) at
`956e73dbee4658d356418664c7ba2e6982937034`, against the same targets: a whole
`bun run test` alone in at most 360 s, green (#215), and the probe's p95 with four whole
suites queued at most twice its idle p95 (#216). The driver (`drive.ts`, the 29 October
method) and raw samples are in that Run's `handoffs/measure/`. Each window held the
Measurement lock; other Runs' work outside the lock continued. Suites ran from four
separate checkouts of the same commit.

Attribution on e95d5fd8 showed the suite's CPU going to child processes and SQLite
rather than test code: 6,473 CPU-s and 13,520 process starts in one suite, and 44,616 SQL
statements in `test/baseline-01.test.ts` alone, 13,500 of them per-shard lock deletes.
The branch therefore runs the engine on one shard
([ADR-draft-one-runner-holds-one-shard](adr/draft-one-runner-holds-one-shard.md)).

| Window (UTC)                          | Samples | Probe p50 | Probe p95 | Result                        |
| ------------------------------------- | ------: | --------: | --------: | ----------------------------- |
| q1 idle, 09:48:09–09:53:08            |     300 |   5.32 ms |   9.03 ms |                               |
| q1 alone, 09:53–10:03:43              |     633 |   5.39 ms |   8.89 ms | 633.56 s, 5,342 pass, 0 fail  |
| q1 four, ≥ 4 suites 10:03:44–10:15:53 |     729 |   6.28 ms |  12.31 ms | interrupted 10:17:31          |
| q2 idle, 10:19:43–10:24:43            |     300 |   5.11 ms |   9.33 ms |                               |
| q2 four, ≥ 4 suites 10:24:45–10:35:59 |     674 |   5.59 ms |  10.27 ms | completed 11:09:10, see below |

The alone suite used 6,594.9 CPU-s, 13,561 process starts, and per-file time summing to
6,894 s at 12 workers; `test/agents.test.ts` was the longest file at 200 s. At 12 workers
that sum alone is about 575 s, so #215 needs roughly a third less work in the suite, not
better scheduling. **#215 remains unmet.**

The q1 four-suite window ended when the host restarted for Collie 0.110.1, with suite 1
green and suites 2–4 cut off; over its 729 samples the ratio was 1.36. The q2 rerun
completed: its 674 samples with four whole suites held or waiting give a p95 of 10.27 ms,
1.10 times its idle 9.33 ms (mean 18.4 busy cores, 38 % CPU stall), so **#216 is met at
956e73db**. Its suites took 675, 1,372, 2,039 and 2,666 s, queued one behind another.
Three passed 5,342; one failed 1 of 5,342: `test/verify.test.ts`'s "a tree git cannot
stage is no tree" test, which is master's (#284) and passed in the other four suites.

The branch later took master's herdr-core migration (#289), which rewrote the fakes most
of the suite runs on. Neither window above measured that tree.

### Test-suite measurements, 4 November 2026

Run `run-8afaffc4.implement` took #215 to the host's Measurement on vm-mk (24 cores, Bun
1.4.4). Its plan is ticket 05's benchmark plan: `tools/suite-bench.ts` (harness commit
`7b4af6da`) runs one whole `bun run test`, 3 samples a side, `suite.own_ms` primary and
`suite.cpu_ms` and `suite.passed` as guardrails. The base is master `4be825d2` plus the
harness. Its attribution, on `b314b578`, is `handoffs/215-attribution.md` in that Run.

Neither Measurement got past the base's first sample, because master's own suite went red
there. A failed sample is not recorded, so neither has a median or a verdict. The load
figures are the suite's own report, at admission and at its end. The second was started
only once the lock was free and the 1-minute load was below 8, the lowest vm-mk's
background (dockerd, kubelet, Falcon, the Collie host) allowed in two hours of waiting.

| Measurement                                        | Pass        | Candidate  | Load       | Base suite                                 |
| -------------------------------------------------- | ----------- | ---------- | ---------- | ------------------------------------------ |
| `run-8afaffc4.implement-measurement-1793784587902` | calibration | `b314b578` | 10.3, 24.2 | `Failed`: ran 753.25 s, 5,496 pass, 1 fail |
| `run-8afaffc4.implement-measurement-1793793402735` | calibration | `14a02889` | 7.5, 29.5  | `Failed`: ran 832.21 s, 5,493 pass, 4 fail |

The tests that failed on the base:

- In both: "a plan chained into implement writes a speed-up ticket's criterion as a
  Measurement…", at 31.9 s and then 32.5 s, and in the second, 31.8 s under an unrelated
  id. Its timeout is 120 s, so what ran out is most likely its `until()` wait for the
  implement Run's first build prompt (1,000 tries 20 ms apart). The Measurement keeps
  only the last 4 KiB of output, so the error itself was lost.
- In the second only: "a tune-up whose last rally fix lands after the last review proves
  its outcome on the fresh review delivery took", under an unrelated id, at 45.4 s; and
  `test/verify.test.ts`'s "a tree git cannot stage is no tree", at 0.25 s. That test
  also failed once on 2 November.

Per-file time summed to 8,501 s and 9,318 s in these two suites, against 6,894 s on
2 November, on a busier vm-mk.

Cuts: one was made, and it is not yet measured. A fingerprint now takes three git starts
once its checkout is known, not five (`14a02889`); it is kept. No `final` Measurement was
taken: with the base red under a quiet start, the Run stopped measuring, and the human then
gave the measurement and the 360 s proof to another Run already doing that work. **#215
remains open until that Run's `final` Measurement.**

### Test-suite measurements, 12 October 2026

Measured with `/usr/bin/time bun run test`, Bun 1.4.3, Linux and 20 available logical CPUs.
Wall time includes both executable builds. The package cache is warm unless stated; no
suite results are reused. Queuing behind another suite adds waiting time.

| Change                                                                   | Wall time | Result                                        |
| ------------------------------------------------------------------------ | --------: | --------------------------------------------- |
| Initial tree                                                             |  110.65 s | 2,369 passed; four fixture-isolation failures |
| Compiled binary retained by isolated worlds; harness cleanup fixed       |  100.43 s | 2,374 passed                                  |
| Controlled client timeout clocks and package metadata reuse              |   65.35 s | 2,375 passed                                  |
| All available CPUs, smaller fake CLI runtime and native fixture commands |   56.17 s | 2,379 passed                                  |
| Command lifecycle regressions and complete group cleanup                 |   56.63 s | 2,381 passed                                  |
| Same suite with no scheduling estimates                                  |   70.85 s | 2,381 passed; slow files started later        |
| Seeded scheduling estimates, no saved timings                            |   54.15 s | 2,381 passed                                  |
| Seeded estimates, empty fixture package cache and no saved timings       |   56.08 s | 2,381 passed                                  |
| World command cleanup, empty fixture package cache and no saved timings  |   58.10 s | 2,382 passed                                  |
| Final world cleanup and exact binding matching, warm cache               |   55.53 s | 2,382 passed                                  |

Every original test title is still present. Nine regressions were added for binary and
lifetime settings, toolchain validity, installer environment and temporary files, host
exit and surviving commands before fixture removal, command output and environment, and process-group cleanup.
The workflows still use the real engine and SQLite; host proofs still drive the shipped
executable. Installed harness checks and real compiler checks still run.

Experiments discarded after measurement:

| Experiment                                      | Measurement                                     | Decision                                                                            |
| ----------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| Shared package cache without offline preference | 7.51 s fresh versus 7.45 s shared for authoring | Metadata refresh still dominated; use offline preference with normal fetch fallback |
| Split the four longest files into eight         | 67.26 s and 73.55 s                             | More simultaneous engine work increased CPU cost                                    |
| CPU affinity for long files                     | 59.26 s best, excluding builds                  | Little margin and machine-specific allocation                                       |
| Lower priority for the other files              | 56.86 s, excluding builds                       | No useful gain over the simpler final runner                                        |
| Fixture stop grace reduced from 500 ms to 1 ms  | 70.33 s after fixing an exposed exit race       | No overall speed gain; keep 500 ms and wait for process exit                        |

The fake CLI's minimal runtime reduced 50 isolated starts from 1.724 s to 1.318 s. Native
fixture command execution reduced 100 `/bin/true` calls from 131 ms to 110 ms; full-suite
measurements, rather than those microbenchmarks, decide whether the changes stay.

### Follow-up measurements, 13 October 2026

The same runner remains at 20 workers. A fresh green baseline took 55.25 s with 2,382
tests passing. Two fixture races were repaired: a world's cleanup awaits the child's
exit promise, and the Home proof waits for each real sleep registration before moving
its test clock. The Home proof still covers seven restatements over 24 hours and now
also checks each four-hour sleep. Delaying the filesystem operation by 100 ms reproduced
the old failure and passed with that synchronization.

The final complete verification passed all 2,382 tests in 60.98 s including builds
(57.98 s reported by the test runner). This follow-up improves reliability; the timing
variation does not establish a further speed gain.

| Experiment                         | Measurement                              | Decision                                                     |
| ---------------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| 12 workers                         | 58.83 s; all passed                      | Keep 20 workers                                              |
| 28 workers                         | 63.06 s; all passed                      | More workers did not help                                    |
| Elapsed-time clock pacing          | 53.96 s; two failures                    | Reject IO-sensitive stop/resume regressions                  |
| Append Git fixture config directly | 71.13 s; a Home timeout                  | No gain established; restore real Git configuration commands |
| Larger SQLite statement cache      | Focused suite 21.28 s versus 21.11 s     | Too little gain to justify a production change               |
| Precompiled Solid compiler preload | 68.28 s; all passed                      | Faster isolated starts did not improve the suite             |
| Lazy Solid compiler preload        | 56.63 s; all passed                      | No useful gain over the existing preload                     |
| Minified compiled CLI              | Help-start median 50.0 ms versus 54.4 ms | Smaller binary started more slowly                           |

### Measurements with the peer and forge coverage, 13 October 2026

After merging the latest master, the suite has 2,642 tests. On the local Linux machine
with Bun 1.4.3 and 20 available logical CPUs, the first complete green baseline took
113.05 s including builds. These measurements cover more tests than the earlier table.

The peer-settings proof now waits for both the model's timestamp and the Flock sender,
then asserts that snapshot. The timestamp and sender are written separately; observing
the first write is not evidence the whole update finished. A temporary 100 ms delay
between those writes reproduced the old failure and passed with that synchronization.
The delay was removed from production code.
The synchronized suite passed all 2,642 tests in 101.05 s including builds; lint,
formatting and type checking also passed. The variation from the first baseline is
larger than the I/O-thread experiment's apparent gain, so no gain is established there.

| Experiment                     | Measurement                         | Decision                                                    |
| ------------------------------ | ----------------------------------- | ----------------------------------------------------------- |
| 10 workers                     | 124.25 s; all 2,642 passed          | Keep 20 workers                                             |
| Two Bun I/O threads per worker | 106.06 s; one peer-settings failure | No default change; exposed the incomplete settings snapshot |

The forge fake's original source wrapper took 3.174 s for 30 sequential, validated
`--version` calls (103.76 ms median). Its minimal source runtime took 2.751 s
(87.27 ms median); the compiled fake took 0.380 s (12.68 ms median). Each call's output
and exit were checked. The same fake still answers both forges, records notes and exposes
nonzero exits; new regressions cover executable selection, literal arguments and the
source fallback with no Bun command on PATH.

With that compiled fake, two full runs passed all 2,644 tests in 96.46 s and 94.78 s
as reported by Bun. The latter took 97.28 s including builds. The first queued behind
another suite, so its external wall time is not a useful execution comparison. The
runner now prints its time including builds after it takes the suite lock, excluding
queuing. Startup improved, but the overall gain is within the full suite's observed
variation. Reporting and resume are now the longest files, each about 94–95 s.

A further split moved the three reporting harness cases and the first resume collection
case into two more files, with shared fixtures and every assertion and timer retained.
All 2,644 tests passed, but the suite took 105.34 s including builds (102.57 s in Bun).
The workflow files and remaining reporting file slowed under that distribution of work.
The split was reverted.

The old checked-in scheduling seed covered 183 files and omitted both reporting and
resume. Starting with that seed and no saved timings passed all 2,644 tests in 143.36 s
including builds (140.82 s in Bun). Refreshing the seed from measured durations for all
196 current files, again with no saved timings, passed in 97.79 s including builds
(95.32 s in Bun). This improves a fresh checkout by 32%; durations only are saved, and
every test still runs. Later runs continue replacing those estimates with local timings.

The remaining executor fixture now uses `fakeHerdrCommand` too. Its ten unchanged tests
passed in 0.680 s versus 2.04 s with the source-only shim (3.23 s versus 4.49 s including
builds). Final verification from the committed scheduling seed passed all 2,644 root
tests in 100.11 s including builds (97.41 s in Bun), with every original test title still
present. Formatting, lint, type checking and the compiled CLI smoke check passed.
Desktop's separate suite passed all 122 tests in 0.723 s after its frozen dependencies
were installed; its initial errors were missing local packages.

Release CI exposed a cache-isolation bug masked locally by `/tmp` being on a different
filesystem from `.scratch/test-packages`. The `backend = "copyfile"` Bun configuration
did not prevent hardlinks on CI. Changing the stale-Effect fixture's installed manifest
therefore changed the cached manifest too, breaking the later real authoring proofs.
Running that file with `TMPDIR` under `.scratch/` reproduced both failures. The fixture
now detaches the manifest before editing it and asserts a hardlinked copy stays unchanged;
the unsupported backend configuration was removed. All 15 authoring tests passed with a
fresh cache and the fixture directories on the cache's filesystem after that correction.

## Retained Run material

The catalogue and exact-revision receipts live in `host.db`, migrated by `src/store.ts`.
`src/artefacts.ts` discovers only approved Run collections and keeps immutable SHA-256
blobs under each Run's `.artefacts/`. It checks source stability before committing a
revision. Original readers keep their references; catalogue operations do not alter proof.

Receipt requests and results commit in the same transaction as the receipt. Retried
requests return their saved result without overwriting later choices. The existing
Actor audit records the front door and requesting agent. Catalogue writes notify
StoreWrites for that Run; unchanged observations produce no notification or audit.
Content revisions are durable integers, independent of the Run model's epoch and sequence.

The native record reads bounded revision parts, verifies their digest, and fences worker
and RPC completions by opening serial and selection generation. Video owns one bounded
frame queue. Linux decoding, seeking, and audio synchronization run through GStreamer
away from the UI thread. macOS uses the pinned Rune player. Linux's existing bundle step
copies the required plugins, dependency closure, scanner, and copyright notices into the
bundle. Its private plugin path is installed before threads start.

See [the material guide](artefacts.md#evidence-by-layer) for the checks at each layer and
the native operator observations that remain pending.
