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
inputs and where each came from, `steps/<step>[/<variant>]/` with the exact prompt sent and
the output written, `personas/` with the persona as injected, `review.md` where the run
produced one, and `log.txt`. That is the audit trail and what `resume` reads.

<!-- prettier-ignore -->
> [!IMPORTANT]
> The run directory is internal mechanics, not an interface. Its layout can change
> without notice. Coordinate with a run through the CLI ([CLI](cli.md)) — `run show`,
> `run wait`, `run answer` — and never by reading or writing run-directory files. Writing
> one directly races the Driver that owns it.

Plan artefacts are the same story from the other side: `SPEC.md`, tickets, wayfinder maps
and architecture reports go into the run's `plan/` directory and never into the repository
([ADR-0002](adr/0002-plan-artefacts-live-in-the-run-directory.md)). Glossary and ADR changes
made while planning _are_ written into the repository — those are domain knowledge, not
plans.

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
`herdr-plugin.toml` equal to it. Merge-request pipelines run the test against the snapshot
and prove the snapshot is really what the pinned binary prints, so an unrelated merge
request never goes red because herdr released.

A daily pipeline schedule runs `contract:stable` against the newest stable herdr and
`contract:preview` against the newest preview build, which is allowed to fail. Both name
the version and protocol they tested. A red `contract:stable` means the newest herdr moved
something Collie reads: either widen the struct, or — when the field is genuinely gone —
change what reads it. Bumping the pin afterwards is editing the version and checksums in
`herdr-pin.json` and running `bun run contract:regen`. A red `contract:preview` is the same
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
[Authoring](authoring.md#extends-merge-semantics) — change both together.

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

## The registry and sessions

A **session** is one herdr session and one workspace, taken together; a Run's own worktree
does not move it out of the workspace it was started from.
`registry.ts` records which long-lived agents a session still has, per workspace and repo,
so `handoff.ts` can give one run's result to another run's live agent rather than starting
a second one. There is only ever one agent per role in a session, and a session never sees
another workspace's agents — even for the same repo.

## Build and release

The runner is TypeScript compiled by `bun build --compile`, one binary per platform, built
in CI on tag and downloaded from the GitLab release by `install.sh`
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

**Bun 1.4 or newer** — `engines` in `package.json`, `.mise.toml` and the CI image all say
so. The runner is compiled by bun and the tests are `bun:test`, so the version is a
prerequisite rather than a preference.

```sh
bun install
bun run format:check
bun run lint
bun test
bun run typecheck
bun run build          # bin/collie for this platform
bun run smoke          # bin/collie answers --help and returns typed envelopes
```

`bun run build && bun run smoke` is the pairing to run before touching anything on the
release or install path: the build alone does not prove the compiled binary still starts.

Tests live in `test/`, with a fake herdr and shared fixtures under `test/support/`. Because
`herdr.ts` is the only boundary, an end-to-end test drives the real engine against that
fake.

Documentation changes in the same merge request as the behavior it describes. There is no
docs lint to catch a page that fell behind — a stale page is a defect like any other.
