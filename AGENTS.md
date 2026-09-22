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
- **Adding a herdr call, or a red `contract` workflow** →
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
- **Changing how a Task is named, or what a tab or pane label says** →
  [`docs/using.md`](docs/using.md#what-a-task-workspace-is-called), alongside
  `src/tasknames.ts` (the inference and its stand-in), `prompts/namer.md` (what the model
  is asked, and the rule that live labels are data) and `src/naming.ts` (the labels
  themselves, and which of them are still Collie's to write).
- **Changing what the board draws, what it is a board of, or which workspace owns it** →
  [`docs/using.md`](docs/using.md#the-control-plane), alongside `src/board.ts` (the TaskView
  model and the sentence), `src/ui/Board.tsx` and `src/ui/Drawer.tsx` (the cards and the
  record) and `src/home.ts` (ownership). One board per Herd, in the Home
  ([ADR-0009](docs/adr/0009-the-collie-tab-is-the-herds.md)), and it is one card per Task
  rather than a table of Runs
  ([ADR-0013](docs/adr/0013-the-board-is-cards-of-tasks.md), which supersedes what
  [ADR-0005](docs/adr/0005-collie-tab-is-an-application.md) says the tab draws).
- **Changing what a Run must prove, or what counts as proof** →
  [`docs/cli.md`](docs/cli.md#outcomes) and
  [ADR-0010](docs/adr/0010-a-run-proves-its-outcome.md), alongside `src/outcome.ts` (the
  table), `src/verify.ts` and `src/verify-spec.ts` (collection and what Collie may run),
  and `src/metrics.ts` (what a Run produced). Evidence is collected at a revision; an
  Output field is a claim.
- **Changing the Home's panes, the chat harness, or what native chat may read** →
  [`docs/using.md`](docs/using.md#talking-to-collie-about-the-flock), alongside
  `src/chat.ts` (the harness and the session), `src/tools.ts` (the read contract) and
  [ADR-0011](docs/adr/0011-the-conversation-is-a-native-harness.md). What the board has
  selected is an explicit input chat may read, never a filter over the reads
  ([ADR-0012](docs/adr/0012-the-boards-selection-is-an-explicit-chat-input.md), alongside
  `src/selection.ts` and `src/statusline.ts`).
- **Changing what a workflow module exports, its metadata, or the schemas its steps
  write** → [`docs/sdk.md`](docs/sdk.md), alongside `src/sdk.ts` (the contract and what it
  refuses) and `src/output.ts` (the shared Output schemas, beside the parsers the engine
  still reads them with). `docs/authoring.md` is the Markdown interpreter's, which the
  five shipped workflows still use; the two are separate until those are converted.
- **Changing how a workflow module is loaded, which Effect it gets, or what a host may
  assume about suspension and recovery** →
  [ADR-0014](docs/adr/0014-native-workflows-run-on-effects-own-engine.md), alongside
  `src/native.ts` and `test/native-runtime.test.ts`. The two non-default cluster settings
  and the four upstream behaviours the proof measured are recorded there; an Effect
  upgrade rechecks them rather than assuming them.
- **Changing where a workflow module is looked for, which layer wins, or when an edit
  reaches new work** →
  [ADR-0016](docs/adr/0016-a-workflow-module-is-found-where-it-was-saved.md) and
  [`docs/sdk.md`](docs/sdk.md#where-a-module-lives), alongside `src/discovery.ts`,
  `test/discovery.test.ts` and `test/autoload.test.ts`. The user's own directory is
  ignored by this checkout on purpose: `collie upgrade` fast-forwards it.
- **Changing who owns a state directory, how a client reaches the host, or what a
  mismatched build is told** →
  [ADR-0015](docs/adr/0015-one-local-host-owns-a-state-directory.md) and
  [`docs/cli.md`](docs/cli.md#the-local-workflow-host), alongside `src/host.ts` and
  `test/host.test.ts`. The lock is `src/lock.ts`'s, so ownership is decided the same way
  it is for a Run's persistence and a Driver takeover.
- **Changing how a start is claimed, what a host records about a run, or how an
  interrupted start recovers** →
  [ADR-0017](docs/adr/0017-one-request-is-one-run.md) and
  [`docs/cli.md`](docs/cli.md#the-local-workflow-host), alongside `src/store.ts`,
  `test/store.test.ts` and `test/admission.test.ts`. The request id is the claim and the
  un-receipted row is the whole of recovery; there is no outbox or queue to add to.
- **Changing how a native Run is started, shown, listed or waited on from the CLI or a
  herdr action** →
  [ADR-0018](docs/adr/0018-a-native-run-is-a-run.md) and
  [`docs/cli.md`](docs/cli.md#a-workflow-saved-as-a-module), alongside `src/lifecycle.ts`,
  `src/commands/run.ts`, `src/flows.ts` and `test/lifecycle.test.ts`. What an id runs is
  decided by what is saved for the project, never by a flag, and a status is read from the
  engine rather than kept anywhere of Collie's.
- **Changing how an Input is inferred, settled or read back — or adding a strategy** →
  [ADR-0019](docs/adr/0019-a-strategy-not-a-field-name.md) and
  [`docs/cli.md`](docs/cli.md#a-workflow-saved-as-a-module), alongside `src/strategies.ts`,
  `src/inputs.ts`, `src/native.ts` and `test/strategies.test.ts`. What Collie does with an
  Input is the strategy's, never the field's name: read one with `workSourceOf`,
  `diffTargetOf` or `gitlabRepositoryOf` rather than by looking a name up.
- **Changing how a native workflow runs an agent, builds its prompt or collects its
  Output** →
  [ADR-0020](docs/adr/0020-an-agent-is-launched-once-and-its-output-is-decoded.md) and
  [`docs/sdk.md`](docs/sdk.md#having-an-agent-do-the-work), alongside `src/agents.ts` and
  `test/agents.test.ts`. One launch, one collection, one repair, each its own Activity;
  herdr is reached through `src/herdr.ts` and the prompt goes out through the Dispatcher,
  as a Step's does.
- **Changing what a human can do to a native Run — a decision, a hold, a stop, steering** →
  [ADR-0021](docs/adr/0021-one-host-answers-for-a-run.md) and
  [`docs/cli.md`](docs/cli.md#answering-holding-and-steering-one), alongside `src/native.ts`,
  `src/lifecycle.ts` and `test/control.test.ts`. The host settles it whichever door it came
  in; a question is asked with `ask` so the host knows it is open, and a control says
  whether it reached the run rather than confirming what it could not.
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
   created. A Run no longer stays in the workspace it was started from: it belongs to its
   Task, and a fresh start opens one of its own ([`CONTEXT.md`](CONTEXT.md), Task
   workspace).
