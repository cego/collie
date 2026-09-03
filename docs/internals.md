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

## Worktrees and the settled rule

`worktree.ts` owns the checkout a mutating run works in. The unit is the **branch**: git
allows exactly one worktree per checked-out branch, so nothing has to invent an identity
for a directory — `herdr worktree list` is the index, `open` gives an existing checkout
its workspace back, and `create` cuts a new one from the default branch. The run records
`worktree.path`, `worktree.branch` and `worktree.created_by_collie`, and its cwd,
workspace and Driver are that worktree's. `startRun` resolves it for a run started here;
`chain` resolves it for a chained one, which is how `plan` and `architecture` get one.

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

Removal goes through herdr, always: a checkout whose workspace a human has since closed
is opened again to be removed, rather than taken out from under herdr with a bare
`git worktree remove`. Once the checkout has gone the entry is a removal whatever
happens to the branch — a branch `git branch -d` refuses is what is left to look at, so
the board says which branch and what git said about it, for as long as a removal is news.

Note what condition 2 does not do on its
own: a checkout with no upstream is still only removed once 3 and 4 hold too, so the
branch has to be gone from the remote — or its merge request merged or closed — before
"holds no commit of its own" removes anything. Removal is `herdr worktree remove` — which
closes the workspace with the checkout — and then `git branch -d`. Never `--force`, never
`-D`: git's refusals are the last guard, so a wrong judgement here can only fail to clean,
never delete work. Only paths some run recorded with `created_by_collie` are candidates.

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

`herdr.ts` is the only channel to herdr: the `herdr` CLI at `HERDR_BIN_PATH` for the
commands that have one, and the socket for the rest. Nothing else in the codebase shells
out to `herdr` or opens that socket. That is what makes the fake herdr in `test/support/`
enough to test everything above it.

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

Validation runs before a single tab opens: unknown harnesses, models and efforts, missing
personas and skills, malformed choices, unknown `extends:` parents, cycles, and placeholders
no declared input can fill. `collie workflow check` is the same validation without a run.

## Trust

`trust.ts` handles a harness's own "may I work in this directory" question, answering it
where that harness looks for the answer rather than driving its dialog. For claude that is a
read-modify-write of `~/.claude.json`, a file claude owns — which is why it is done once per
directory, atomically, and with a backup. What the user sees and how they configure it:
[Using Collie](using.md#trust-the-first-run-in-a-repo).

## The registry and sessions

A **session** is one herdr session, one workspace and one repo cwd, taken together.
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
