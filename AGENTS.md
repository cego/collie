# Collie

Collie codifies agent workflows for herdr — `plan`, `implement`, `review`, `architecture`,
`renovate`, `release`, `general`, `investigate`, `self-improve` — as TypeScript modules run by one Effect v4 program with two front doors:
herdr actions, and the `collie` CLI.

## Where to look

Each entry: the area you are changing, then where it is decided. Source files not named
here are in [`src/README.md`](src/README.md).

- **Direction** → [`PRODUCT.md`](PRODUCT.md). **Vocabulary** → [`CONTEXT.md`](CONTEXT.md),
  canonical; link to it rather than restate a term. **File ownership** → [`src/README.md`](src/README.md).
- **Personas, layers** → [`docs/authoring.md`](docs/authoring.md), `src/definitions.ts`, `src/discovery.ts`.
- **Workflow authoring commands** (`list`, `show`, check, `needs_input`) → [`docs/authoring.md`](docs/authoring.md),
  [`docs/sdk.md`](docs/sdk.md), `src/authoring.ts`, `src/commands/workflow.ts`.
- **Go to pane** → [ADR-0044](docs/adr/0044-go-to-pane-opens-the-pane-in-desktop.md),
  `desktop/src/bun/terminal.ts`, `test/desktop-terminal.test.ts`, `desktop/test/terminal-input.test.ts`.
- **Placement** of a start → [ADR-0033](docs/adr/0033-a-run-started-from-the-home-is-placed-not-asked.md),
  joining a Task: [ADR-draft-a-tasks-work-is-what-its-runs-worked-on](docs/adr/draft-a-tasks-work-is-what-its-runs-worked-on.md),
  `taskWorking` in `src/engine.ts`, `test/placement.test.ts`, `src/flows.ts`, `src/route.ts`, `src/projects.ts`, `src/agent-start.ts`.
- **CLI surface, error codes, `--json`** → [`docs/cli.md`](docs/cli.md), `src/envelope.ts`, `src/operations.ts`.
- **herdr calls, red `contract`** → [`docs/internals.md`](docs/internals.md#checking-the-boundary-against-herdr),
  `herdr-pin.json`, `test/herdr-contract.test.ts`.
- **Compaction** → [`docs/using.md`](docs/using.md#compaction-between-pieces-of-work),
  [`docs/internals.md`](docs/internals.md#compaction-at-a-work-boundary),
  [ADR-0007](docs/adr/0007-compact-a-reused-agent-at-a-work-boundary.md), `src/compaction.ts`, `src/compactors.ts`.
- **Steering, delivery** → [`docs/steering.md`](docs/steering.md), `src/intent.ts`, `src/dispatcher.ts`,
  `src/steering.ts`, `src/steering-caps.ts`, the host's `steer` in `src/host.ts`
  ([ADR-0051](docs/adr/0051-a-review-comment-is-written-on-desktops-own-views.md)).
- **Steering a finished Run** → [ADR-0041](docs/adr/0041-a-finished-run-still-takes-steering.md),
  `admit` in `src/proposals.ts`, `src/engine.ts`, `steerRun` in `src/lifecycle.ts`, `test/finished-steer.test.ts`.
- **Task names, labels** → [`docs/using.md`](docs/using.md#what-a-task-workspace-is-called),
  `src/tasknames.ts`, `prompts/namer.md`, `src/naming.ts`.
- **Board** → [`docs/using.md`](docs/using.md#the-control-plane),
  [ADR-0009](docs/adr/0009-the-collie-tab-is-the-herds.md), [ADR-0013](docs/adr/0013-the-board-is-cards-of-tasks.md)
  (supersedes [ADR-0005](docs/adr/0005-collie-tab-is-an-application.md) on what it draws),
  `src/board-model.ts`, `src/board.ts`, `src/ui/Board.tsx`, `src/ui/Drawer.tsx`, `src/home.ts`.
- **Agent to agent, agent reports** → [ADR-0058](docs/adr/0058-an-agent-speaks-to-another-as-itself.md),
  `src/harness.ts`, `src/tools.ts`, `asksRun` in `src/lifecycle.ts`, `src/dispatcher.ts`, `src/handoff.ts`,
  `src/reports.ts`, `requestedBy` in `src/engine.ts`, `src/agent-start.ts`, `workflows/investigate.workflow.ts`,
  `test/agent-origin.test.ts`, `test/mcp.test.ts`, `test/reports.test.ts`.
- **Machine to Machine** → [ADR-0057](docs/adr/0057-a-machine-reaches-another-over-a-paired-link.md),
  [`docs/internals.md`](docs/internals.md#reaching-another-machine), `src/peers.ts`, `src/peers-model.ts`,
  `src/channel.ts`, `connectPeer` in `src/host.ts`, `test/peers.test.ts`, `test/support/peers.ts`.
- **Desktop**, its Flock chat, record and Diff tab → [`desktop/README.md`](desktop/README.md),
  [`docs/using.md`](docs/using.md#collie-desktop), `test/desktop-*.test.ts`, `test/flock-*.test.ts`.
- **Agent launch profile** → [ADR-0060](docs/adr/0060-a-managed-agent-runs-with-the-operators-profile.md),
  [`docs/using.md`](docs/using.md#what-collies-agents-get), `src/profile.ts`, `src/agents.ts`,
  `test/profile.test.ts`, `test/agents.test.ts`.
- **Attachments** → [ADR-0046](docs/adr/0046-an-attachment-is-uploaded-once-and-belongs-to-the-run.md),
  `src/attachments.ts`, `src/uploads.ts`, `src/host-files.ts`, `test/attachments.test.ts`, `test/host-files.test.ts`.
- **Usage, fallbacks** → [ADR-0049](docs/adr/0049-work-goes-to-an-agent-with-usage-left.md),
  [`docs/using.md`](docs/using.md#usage), `src/usage-model.ts`, `src/usage.ts`, `src/commands/usage.ts`,
  `resolveWithRoom` in `src/harness.ts`, `choose` in `src/agents.ts`, `test/usage-model.test.ts`,
  `test/usage.test.ts`, `test/fallback.test.ts`.
- **Review comments** → [ADR-0051](docs/adr/0051-a-review-comment-is-written-on-desktops-own-views.md),
  `desktop/src/shared/review-comments.ts`. **Desktop Zoom** → [ADR-0047](docs/adr/0047-desktop-draws-at-its-monitors-own-scale.md).
- **Schedules** → [ADR-0052](docs/adr/0052-a-schedule-is-a-saved-start-its-host-fires.md),
  [`docs/using.md`](docs/using.md#schedules), `src/schedule-model.ts`, `src/schedules.ts`,
  `src/schedule-move.ts`, `src/commands/schedule.ts`, the `schedule_*` actions in `src/actions.ts`,
  `desktop/src/shared/schedules.ts`, `test/schedule*.test.ts`, `test/desktop-schedules.test.ts`.
- **`self-improve`** → [ADR-0053](docs/adr/0053-collie-files-and-fixes-what-its-own-runs-show.md),
  [`docs/using.md`](docs/using.md#self-improve), `workflows/self-improve.workflow.ts`,
  `workflows/retrospective.ts`, `personas/retrospective.md`, `test/support/baseline.ts`.
  Its triage uses the installed `retro` skill.
- **Settings** → [ADR-0043](docs/adr/0043-a-shared-setting-is-its-latest-edit.md), `src/settings.ts`,
  `setSetting` and `takeShared` in `src/config.ts`. The user Layer's files are shared by the same rule:
  [ADR-0061](docs/adr/0061-a-users-definitions-are-the-flocks.md),
  `src/shared-definitions.ts`, `src/peers.ts`, `desktop/src/bun/flock-settings.ts`,
  `test/shared-definitions.test.ts`, `test/peer-definitions.test.ts`, `test/desktop-settings.test.ts`.
- **Outcomes, proof** → [`docs/cli.md`](docs/cli.md#outcomes), [ADR-0010](docs/adr/0010-a-run-proves-its-outcome.md),
  `src/outcome.ts`, `src/verify.ts`, `src/verify-spec.ts`, `src/metrics.ts`; a check left to CI:
  [ADR-draft-a-check-left-to-ci-is-proved-by-its-pipeline-job](docs/adr/draft-a-check-left-to-ci-is-proved-by-its-pipeline-job.md),
  `src/check-proof.ts`, `src/ci-job.ts`, `test/ci-job.test.ts`.
- **Measurement** → [ADR-draft-a-performance-gain-is-proved-by-the-hosts-measurement](docs/adr/draft-a-performance-gain-is-proved-by-the-hosts-measurement.md),
  [`docs/cli.md`](docs/cli.md#measure), `src/measurement.ts`, `src/measurement-model.ts`,
  `src/measurement-verdict.ts`, `test/measurement.test.ts`, `test/measurement-verdict.test.ts`.
- **Checks Collie runs, as seen** → [ADR-0042](docs/adr/0042-a-check-collie-runs-is-seen-while-it-runs.md),
  `src/checks.ts`, `src/verify.ts`, `src/commands/run.ts`.
- **Home chat** → [`docs/using.md`](docs/using.md#talking-to-collie-about-a-herd),
  [ADR-0011](docs/adr/0011-the-conversation-is-a-native-harness.md), [ADR-0032](docs/adr/0032-a-chat-starts-new-on-the-latest-opus.md),
  [ADR-0012](docs/adr/0012-the-boards-selection-is-an-explicit-chat-input.md), `src/chat.ts`, `src/toolkit.ts`,
  `src/selection.ts`, `src/statusline.ts`.
- **Workflow module contract**, Steps and the Flow → [`docs/sdk.md`](docs/sdk.md),
  [ADR-draft-a-step-is-declared-where-its-work-is-written](docs/adr/draft-a-step-is-declared-where-its-work-is-written.md),
  `src/sdk.ts`, `src/steps.ts`, `src/flow.ts`, `src/flow-read.ts`, `src/output.ts`, `test/flow.test.ts`.
- **Engine, loading, recovery** → [ADR-0014](docs/adr/0014-native-workflows-run-on-effects-own-engine.md),
  `src/engine.ts`, `test/engine.test.ts`.
- **Naming, host tests** → [ADR-0028](docs/adr/0028-names-are-the-domains-and-the-proof-drives-the-shipped-host.md),
  `test/support/host.ts`.
- **Slow tests, front-door imports** → [`docs/internals.md`](docs/internals.md#keeping-the-suite-and-a-start-fast).
- **Module discovery** → [ADR-0016](docs/adr/0016-a-workflow-module-is-found-where-it-was-saved.md),
  [`docs/sdk.md`](docs/sdk.md#where-a-module-lives), `src/discovery.ts`, `test/discovery.test.ts`, `test/autoload.test.ts`;
  the user's directory: [ADR-draft-an-installation-is-the-release-its-runner-carries](docs/adr/draft-an-installation-is-the-release-its-runner-carries.md).
- **A project's own files** → [ADR-0031](docs/adr/0031-what-collie-provides-lives-under-collie.md).
- **Host ownership, version mismatch** → [ADR-0015](docs/adr/0015-one-local-host-owns-a-state-directory.md),
  [`docs/cli.md`](docs/cli.md#the-local-workflow-host), `src/host.ts`, `src/lock.ts`, `test/host.test.ts`.
- **Board protocol, actors, only writer** → [ADR-0038](docs/adr/0038-the-host-builds-and-serves-the-board.md),
  [ADR-0039](docs/adr/0039-every-operation-records-who-asked.md), [ADR-0040](docs/adr/0040-the-host-is-the-only-writer.md),
  `FrontDoorRpcs` in `src/board-model.ts`, `src/board-stream.ts`, `src/audit.ts`, `src/run-detail.ts`,
  `test/board-stream.test.ts`, `test/actor.test.ts`, `test/only-writer.test.ts`, `test/run-detail.test.ts`.
- **Admission, recovery** → [ADR-0017](docs/adr/0017-one-request-is-one-run.md), `src/store.ts`,
  `test/store.test.ts`, `test/admission.test.ts`.
- **Run lifecycle** (start, show, list, wait) → [ADR-0018](docs/adr/0018-a-native-run-is-a-run.md),
  [`docs/cli.md`](docs/cli.md#a-workflow-saved-as-a-module), `src/lifecycle.ts`, `src/commands/run.ts`,
  `src/flows.ts`, `test/lifecycle.test.ts`.
- **Inputs, strategies** → [ADR-0019](docs/adr/0019-a-strategy-not-a-field-name.md), `src/strategies.ts`,
  `src/inputs.ts`, `test/strategies.test.ts`.
- **Forge** (`glab`, `gh`, `forges`) → [ADR-0050](docs/adr/0050-a-merge-request-is-its-forges.md),
  [ADR-draft-a-forge-is-asked-over-http-with-its-clis-login](docs/adr/draft-a-forge-is-asked-over-http-with-its-clis-login.md),
  [`docs/internals.md`](docs/internals.md#the-forge-boundary), `src/forge/`, `test/support/forge.ts`,
  `test/forge.test.ts`, `test/forge-boundary.test.ts`.
- **Agent launch, prompt, Output** → [ADR-0020](docs/adr/0020-an-agent-is-launched-once-and-its-output-is-decoded.md),
  [`docs/sdk.md`](docs/sdk.md#having-an-agent-do-the-work), `src/agents.ts`, `test/agents.test.ts`.
- **Controls** (decision, hold, stop) → [ADR-0021](docs/adr/0021-one-host-answers-for-a-run.md),
  [`docs/cli.md`](docs/cli.md#answering-holding-and-steering-one), `src/lifecycle.ts`, `test/control.test.ts`;
  stopping an agent: [ADR-0059](docs/adr/0059-a-stopped-agent-is-stopped-where-its-turn-runs.md),
  `stopAgent` in `src/compaction.ts`, `endAgent` in `src/agent-end.ts`, `src/processes.ts`,
  `test/codex-stop.test.ts`, `test/agent-end.test.ts`.
- **Child workflows, services** → [ADR-0022](docs/adr/0022-a-workflow-is-made-of-workflows.md),
  [`docs/sdk.md`](docs/sdk.md#a-workflow-made-of-other-workflows), `test/children.test.ts`.
- **Release Run** → [ADR-draft-a-merge-request-is-released-on-a-humans-go](docs/adr/draft-a-merge-request-is-released-on-a-humans-go.md),
  sharing it for approval: [ADR-draft-a-release-shares-its-merge-request-on-a-humans-say](docs/adr/draft-a-release-shares-its-merge-request-on-a-humans-say.md),
  [`docs/workflows.md`](docs/workflows.md#release), `workflows/release.workflow.ts`,
  `workflows/release.gitlab.md`, `workflows/release.github.md`, `src/review-wait.ts`,
  `src/releasing.ts`, `src/landing.ts`, `test/release-content.test.ts`, `test/review-wait.test.ts`,
  `test/landing.test.ts`, `test/support/baseline.ts`. A **Stage Run** →
  [ADR-draft-an-open-merge-request-is-staged-by-a-run-of-its-own](docs/adr/draft-an-open-merge-request-is-staged-by-a-run-of-its-own.md),
  [`docs/workflows.md`](docs/workflows.md#stage), `workflows/stage.workflow.ts`,
  `workflows/stage.gitlab.md`, `workflows/stage.github.md`, and the claims and staging both
  share, `workflows/staging.ts`; `test/stage-content.test.ts`.
- **Rallies, checks as proof** → [ADR-0023](docs/adr/0023-a-rally-is-a-loop-and-a-claim-is-not-proof.md),
  [ADR-0055](docs/adr/0055-a-run-never-asks-to-run-its-checks.md),
  [`docs/sdk.md`](docs/sdk.md#reviewing-and-fixing-until-it-converges), `settleRound`, `test/rally.test.ts`.
- **Lists of work, slices, fan-out** → [ADR-0024](docs/adr/0024-a-list-of-work-is-known-by-its-names.md),
  [`docs/sdk.md`](docs/sdk.md#a-list-of-work-one-item-at-a-time), `src/slices.ts`, `src/plan.ts`, `test/listing.test.ts`.
- **Cards, offers** → [ADR-0025](docs/adr/0025-a-card-is-facts-and-an-offer-is-a-declaration.md),
  [`docs/sdk.md`](docs/sdk.md#what-a-definition-declares), `src/standing.ts`, `src/offers.ts`, `src/cards.ts`,
  `test/actions.test.ts`.
- **Shipped workflows** → [ADR-0026](docs/adr/0026-a-shipped-workflow-is-a-module-like-any-other.md),
  `workflows/*.workflow.ts`, `test/support/baseline.ts`, `test/fixtures/workflows/landing.workflow.ts`.
- **Definition, agent choice** → [ADR-0030](docs/adr/0030-a-workflow-is-one-definition-and-its-agent-is-decided-in-scope.md),
  `defineWorkflow`, `Run`, `withAgents`, `registrationOf`, `resolveChoice`, `test/definition.test.ts`,
  `test/harness.test.ts`.
- **Anything in `src/` that reads a workflow id** →
  [ADR-0029](docs/adr/0029-one-host-acts-for-a-run-and-a-workflows-name-decides-nothing.md),
  `test/workflow-names.test.ts`, `test/baseline-unrelated-*.test.ts`.
- **Execution, coordination, records** → [`docs/internals.md`](docs/internals.md), [`docs/adr/`](docs/adr).
- **Install, keybindings, Control Plane** → [`docs/using.md`](docs/using.md).
- **Release signing, installers, macOS** → [ADR-0048](docs/adr/0048-collie-is-released-for-macos-on-apple-silicon.md),
  `tools/sign.ts`, `src/signing.ts`, `install.sh`, `install-desktop.sh`, `src/script.ts`,
  `test/signing.test.ts`, `test/prepare.test.ts`.

## Commands

`package.json` scripts are the source of truth — read them there rather than from here.

The one pairing they do not record: before touching anything on the release or install
path, run `bun run build && bun run smoke`. The build alone does not prove the compiled
binary still starts.

While you iterate, run what covers what you touched, each through `collie verify`:

- `bun run typecheck`;
- `bun test <files>`, which runs the sources and takes no suite lock;
- never the whole suite (`bun run test`, `bun run check`): that is the gate's, which runs
  the Run's Checks on the final tree. Given one of the Run's Checks, `collie verify` runs
  nothing: it answers with that Check's latest record on the tree, or refuses with
  `invalid_state` and names the gate.

Tests are unit tests only: they call the code through its own interface, with fakes at
its edges. No Playwright and no test that drives a built app or a browser — a behaviour
of the view is covered by testing the logic it renders.

## Invariants

1. **Anything a human can do, an agent can do.** Every action on the board, in the CLI or
   in chat has a route an agent can take, through the same validation and executors. The
   agent is recorded as itself; attribution is audit, never a reason to refuse. A
   safeguard binds humans and agents alike, or it names a concrete harm only an agent
   could cause. Everything else is **ceremony** — a confirmation, question, grant or
   human-only step that protects nothing — and ceremony is a defect: it taxes the user and
   defeats what Collie is for ([`PRODUCT.md`](PRODUCT.md): the human should not have to
   manage each agent). `test/chat-parity.test.ts` holds this for chat.
2. Every capability ships in both front doors: the CLI and the herdr actions are thin
   adapters over the same Effect services ([ADR-0003](docs/adr/0003-collie-is-one-effect-program.md)).
3. All herdr communication goes through `src/herdr.ts`. The exceptions never talk to a
   session for Collie: `tools/herdr-schema.ts`, which runs a downloaded release offline to
   print its schema; Desktop's `herdr machine list`, `add` and `remove`, and the
   `herdr --version` that says why a list failed; and, for the human, herdr's terminal
   controller whose pane Go to pane shows in Desktop, and the herdr
   client it opens in a terminal where there is no pane to show — see
   [`docs/internals.md`](docs/internals.md#the-herdr-boundary).
4. One host owns a state directory and everything it is running
   ([ADR-0015](docs/adr/0015-one-local-host-owns-a-state-directory.md)). Mutate a Run
   through it, under a request id, and never by writing its files.
5. Plan artefacts live in the run directory ([ADR-0002](docs/adr/0002-plan-artefacts-live-in-the-run-directory.md)).
   Glossary and ADR changes belong in the repository. A branch's new ADR is a draft,
   `docs/adr/draft-<slug>.md`, named in text as `ADR-draft-<slug>`, and takes its number
   only when the branch lands ([`docs/internals.md`](docs/internals.md#numbering-a-branchs-adrs)).
6. Collie has one engine, and nothing an older one recorded is carried over
   ([ADR-0027](docs/adr/0027-one-engine-and-a-hard-cutover.md)). No code reads a `run.json`.
7. Docs change in the same merge request as the behavior they describe.
8. A Run proves its outcome ([ADR-0010](docs/adr/0010-a-run-proves-its-outcome.md)):
   evidence is collected against a revision, and no gate is satisfied by an Output field.
   Usage is recorded and never enforced.
9. Steering's design decisions are [ADR-0008](docs/adr/0008-collie-steers-through-the-driver.md)
   (one Dispatcher sends; the host is the only actor over a Run's agents, per
   [ADR-0029](docs/adr/0029-one-host-acts-for-a-run-and-a-workflows-name-decides-nothing.md)) and
   [ADR-0009](docs/adr/0009-the-collie-tab-is-the-herds.md) (one board per Herd, in the
   Home). ADR-0009 supersedes only ADR-0006's sentence about where the Collie tab is
   created. A Run no longer stays in the workspace it was started from: it belongs to its
   Task, and a fresh start opens one of its own unless it is about a Task's work: a merge
   request one of its Runs opened or was given, or a branch one of an open Task's Runs was
   placed on ([`CONTEXT.md`](CONTEXT.md), Task).
