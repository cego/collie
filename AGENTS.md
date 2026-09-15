# Collie

Collie codifies agent workflows for herdr — `plan`, `implement`, `review`, `architecture`,
`renovate` — as markdown definitions executed by one Effect v4 program with two front
doors: herdr actions, and the `collie` CLI.

## Where to look

- **Where this is going, and why the next thing is the next thing** → [`PRODUCT.md`](PRODUCT.md).
- **A term you are unsure of, or one you are about to redefine** → [`CONTEXT.md`](CONTEXT.md).
  It is canonical for vocabulary; docs pages link to it rather than restating a definition.
- **Which file owns what** → [`src/README.md`](src/README.md).
- **Changing workflow or persona frontmatter, `extends:`/`use:` merge semantics, or layer
  lookup** → [`docs/authoring.md`](docs/authoring.md), alongside `src/definitions.ts`.
- **Changing the CLI surface, an error code, or a `--json` envelope** →
  [`docs/cli.md`](docs/cli.md), alongside `src/envelope.ts` and `src/operations.ts`.
- **Claiming a change works, or reviewing one that claims to** →
  [`docs/acceptance.md`](docs/acceptance.md), alongside `bun run acceptance`. A green
  suite is not evidence that a promise was kept; that gate says which are.
- **Adding a herdr call, or a red `contract:stable` pipeline** →
  [`docs/internals.md`](docs/internals.md#checking-the-boundary-against-herdr), alongside
  `herdr-pin.json` and `test/herdr-contract.test.ts`.
- **Changing the compaction threshold, the work-boundary policy, or a harness's
  compaction controls** → [`docs/using.md`](docs/using.md#compaction-between-pieces-of-work),
  alongside `src/compaction.ts` (the policy) and `src/compactors.ts` (the four adapters).
  Where it is called from: [`docs/internals.md`](docs/internals.md#compaction-at-a-work-boundary).
  What each installed harness actually supports, and what the release gate still needs:
  [ADR-0007](docs/adr/0007-compact-a-reused-agent-at-a-work-boundary.md).
- **Changing what a Run is steered against, how a message reaches an agent, or what a
  harness has been shown to do about one** → [`docs/steering.md`](docs/steering.md),
  alongside `src/intent.ts`, `src/dispatcher.ts`, `src/steering.ts` and
  `src/steering-caps.ts`. A capability moves to `proven` only from a recorded live result
  in the Run's `CAPABILITIES.md`.
- **Changing what the board draws, what it is a board of, or which workspace owns it** →
  [`docs/using.md`](docs/using.md#the-control-plane), alongside `src/home.ts` (ownership),
  `src/live.ts` (what the Live region is given) and `src/ui/live.tsx` (how it is drawn).
  One board per Herd, in the Home ([ADR-0009](docs/adr/0009-the-collie-tab-is-the-herds.md));
  a workspace is a filter over it, never a board of its own.
- **Changing what a Run must prove, or what counts as proof** →
  [`docs/cli.md`](docs/cli.md#outcomes) and
  [ADR-0010](docs/adr/0010-a-run-proves-its-outcome.md), alongside `src/outcome.ts` (the
  table), `src/verify.ts` and `src/verify-spec.ts` (collection and what Collie may run),
  and `src/metrics.ts` (what a Run produced). Evidence is collected at a revision; an
  Output field is a claim.
- **Changing the Home's panes, the chat harness, or what native chat may read** →
  [`docs/using.md`](docs/using.md#talking-to-collie-about-the-flock), alongside
  `src/chat.ts` (the harness and the session), `src/tools.ts` (the read contract) and
  [ADR-0011](docs/adr/0011-the-conversation-is-a-native-harness.md).
- **Changing how a run is executed, coordinated, or recorded** →
  [`docs/internals.md`](docs/internals.md) and [`docs/adr/`](docs/adr).
- **Changing install, keybindings, the Control Plane, or a toast** →
  [`docs/using.md`](docs/using.md).

## Commands

`package.json` scripts are the source of truth — read them there rather than from here.

The one pairing they do not record: before touching anything on the release or install
path, run `bun run build && bun run smoke`. The build alone does not prove the compiled
binary still starts.

## Invariants

1. Every capability ships in both front doors: the CLI and the herdr actions are thin
   adapters over the same Effect services ([ADR-0003](docs/adr/0003-collie-is-one-effect-program.md)).
2. All herdr communication goes through `src/herdr.ts`. The one exception is
   `tools/herdr-schema.ts`, which runs a downloaded release offline to print its schema
   and never touches the session — see [`docs/internals.md`](docs/internals.md#the-herdr-boundary).
3. One Driver owns a run's state. Mutate a run through the schema-validated inbox with
   request ids ([ADR-0004](docs/adr/0004-coordinate-runs-through-the-filesystem.md)).
4. Plan artefacts live in the run directory ([ADR-0002](docs/adr/0002-plan-artefacts-live-in-the-run-directory.md)).
   Glossary and ADR changes belong in the repository.
5. Definition merge semantics (`extends:`, `use:`, layers) are canonical in
   `src/definitions.ts` and `docs/authoring.md` — change both together.
6. Docs change in the same merge request as the behavior they describe.
7. A Run proves its outcome ([ADR-0010](docs/adr/0010-a-run-proves-its-outcome.md)): the
   definition is frozen per Run, evidence is collected against a revision, and no gate is
   satisfied by an Output field. Usage is recorded and never enforced.
8. Steering's design decisions are [ADR-0008](docs/adr/0008-collie-steers-through-the-driver.md)
   (the Driver is the only actor over agents) and
   [ADR-0009](docs/adr/0009-the-collie-tab-is-the-herds.md) (one board per Herd, in the
   Home). ADR-0009 supersedes only ADR-0006's sentence about where the Collie tab is
   created; a Run still stays in the workspace it was started from.
