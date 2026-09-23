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
is told to restart the host rather than served.

A workflow is a TypeScript module, and the host runs it on Effect's own engine
([ADR-0014](adr/0014-native-workflows-run-on-effects-own-engine.md)): a
`ClusterWorkflowEngine` over a `SingleRunner`, with execution state in `host.db`, a Bun
SQLite file. The registry in `engine.ts` loads a module into a generation of its own
(`<id>@<n>`), admits a start under its request id and hands it to the engine; the store in
`store.ts` keeps what Collie adds to a Run — its Task, project, entry, input and where each
value came from, its options, its decisions and its receipts. The request id is the claim:
the same request twice is one Run, and a Run recorded and not yet handed to the engine is
handed over when the host starts again ([ADR-0017](adr/0017-one-request-is-one-run.md)).

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
pane that will not take a prompt, nothing approved to prove it, a workspace closed with its
checkout gone — parks with the reason and the repair, and `run resume` picks it up.

Beside the database, a Run's files are its audit trail: `agents/<run>/<operation>.prompt.md`
with the Output it came back with, `evidence/<run>/` with the verifications it was granted
and the ones collected, and `runs/<run>/` with its cards, its `plan/` and the review it left.
A Run an older Collie recorded is a row `history.ts` imported once, with its directory left
exactly as it was ([ADR-0027](adr/0027-one-engine-and-history-is-imported-once.md)).

<!-- prettier-ignore -->
> [!IMPORTANT]
> The run directory is internal mechanics, not an interface. Its layout can change
> without notice. Coordinate with a run through the CLI ([CLI](cli.md)) — `run show`,
> `run wait`, `run answer` — and never by reading or writing run-directory files.

Plan artefacts are the same story from the other side: `SPEC.md`, tickets, wayfinder maps
and architecture reports go into the run's `plan/` directory and never into the repository
([ADR-0002](adr/0002-plan-artefacts-live-in-the-run-directory.md)). Glossary and ADR changes
made while planning _are_ written into the repository — those are domain knowledge, not
plans.

A plan can also move while it is being built. `implement` reads its tickets by name each
time it reaches its list, so a ticket edited since is built as it reads now and a completed
one is not built again
([ADR-0024](adr/0024-a-list-of-work-is-known-by-its-names.md)).

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

A worktree is **settled**, and only then removed, when all four hold:

1. `git status --porcelain` in it is empty;
2. it holds no commit of its own: `git rev-list @{u}..HEAD` is empty where the branch
   has an upstream, and `git rev-list origin/<default>..HEAD` is empty where it does
   not — a branch merged and deleted loses its upstream ref to the next
   `git fetch --prune`, and condition 4's second half would otherwise be unreachable
   in exactly the case it names;
3. nothing is in it: no live agent's pane (its start directory, the directory it has
   moved to, or its workspace) other than the idle agents of the runs that finished there,
   and no run still going there;
4. its merge request is merged or closed, or its remote branch is gone.

The checks run in that order and the first failure is what the board reports, so a kept
worktree always says which condition kept it — including a round that could not ask
herdr what is live, which reports every candidate as held and records nothing, so the
next refresh asks again instead of standing on a verdict it never reached.

Removal follows the checkout. A git-managed one is `git worktree remove` from the
repository's own checkout, and then the tabs of the panes the finished runs' agents were
registered in, where every pane of the tab sits inside the removed path, are closed — dead shells nothing else would ever close, and
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
against the variant, a boundary item composed into that prompt inherits the note, `run deliveries` shows it beside
the state, and a compaction request records it, so an unresolved compaction can be told
from one whose request may never have arrived.

Because the submission settles all of this, nothing waits again after it: the engine
watches a prompted agent straight away rather than keeping a readiness wait of its own.

`env.ts` is the plugin environment herdr provides — state directory, config directory,
socket path, plugin root. `HERDR_PLUGIN_ROOT` is what pins the baseline definitions to the
installation the runner came from; the `collie` on PATH is a two-line shim that sets it.
Without the pin the compiled runner falls back to its own installation (`process.execPath`
is the binary when bun runs it from `/$bunfs/`), so a `bin/collie` started from another
directory still finds its workflows and the host it starts. Only `bun src/main.ts` in development
falls all the way through to the current directory.

## Definitions and layers

`discovery.ts` owns where a workflow module is found: project `.herdr/workflows/`, then the
user's `~/.collie/user/workflows/`, then the installation's `workflows/`. Two entries with
one id in a layer are an error, and a broken override is reported rather than fallen
through. `authoring.ts` reads a module without running it — it loads, constructs and
typechecks it — which is what `collie workflow check` and `workflow show` report.

`definitions.ts` owns persona layer lookup, `extends:` overrides and validation; `yaml.ts`
splits a persona's frontmatter from its body over Effect's YAML parser and writes a key back
when forking. The merge semantics are canonical there and in
[Authoring](authoring.md#forking) — change both together.

An unknown harness, model, effort or permissions mode, and a persona or skill that is not
installed, are refused before an agent's tab opens.

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
write — a status line, a hook, the host — so every write takes the file's own lock, and
the cap drops the oldest lines while keeping the session line and the newest few
compaction events. Those are what a waiting Run polls for: a file the cap had taken the
binding out of reads as an agent nothing is known about, and the Run waits out its budget
for an answer that had already arrived. Installation through agent startup holds a per-agent PID
lock outside the controls directory. Cleanup takes the same lock and rechecks `agent
list` before removing controls or stopping an endpoint. A parallel launch therefore
cannot mistake an agent still starting for a stale one; a failed launch releases its
lock, and the existing PID-lock recovery handles a process that crashes.

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
the others, so a hand-off from the board and a nudge could land in one pane
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

A human's steer is a delivery like any other: the host sends it to the Run's agent through
the Dispatcher, with the same incarnation and harness-capability checks, and says whether
it was delivered rather than that it was accepted for sending. Nothing is typed into a pane
on another Run's behalf.

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
