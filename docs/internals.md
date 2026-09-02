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

## The herdr boundary

`herdr.ts` is the only channel to herdr: the `herdr` CLI at `HERDR_BIN_PATH` for the
commands that have one, and the socket for the rest. Nothing else in the codebase shells
out to `herdr` or opens that socket. That is what makes the fake herdr in `test/support/`
enough to test everything above it.

`env.ts` is the plugin environment herdr provides — state directory, config directory,
socket path, plugin root. `HERDR_PLUGIN_ROOT` is what pins the baseline definitions to the
installation the runner came from; the `collie` on PATH is a two-line shim that sets it,
which is why a `collie` without that pin would take its workflows from whatever directory it
is standing in.

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
