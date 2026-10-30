Runner source (Bun/TypeScript). Compiled to `bin/collie` per platform; see ADR-0001.

`harness-choice.ts` owns the model catalogue and layered choice resolution shared with
Desktop. `harness.ts` owns how those choices launch and reexports the shared interface.

| File                   | What it owns                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `main.ts`              | Entry: the `collie` CLI, or the actions and pane entrypoints under `herdr`                                                  |
| `platform.ts`          | The platform services every program runs on: Bun's, plus the ids and hashes Effect 4.1 took out of them                     |
| `collie.ts`            | CLI assembly, help behavior, and process exit handling                                                                      |
| `commands/`            | Workflow, Persona, and Run command handlers plus their shared resolution context                                            |
| `envelope.ts`          | CLI envelopes, stdout, exit statuses, request receipts, and mutation locks                                                  |
| `operations.ts`        | Workspace resolution and Run mutations shared by both front doors                                                           |
| `doctor.ts`            | Every prerequisite an installation needs, checked in one pass, each with its fix                                            |
| `doctor-check.ts`      | What a doctor check is, shared by the doctor and each forge's own checks                                                    |
| `flows.ts`             | What each action and pane entrypoint does                                                                                   |
| `env.ts`               | The plugin environment herdr provides                                                                                       |
| `herdr.ts`             | The only channel to herdr: CLI at `HERDR_BIN_PATH`, socket for the rest, and its config                                     |
| `definitions.ts`       | Layers, personas, and the `extends:` override a persona fork writes                                                         |
| `yaml.ts`              | Frontmatter split and write-back over Effect's YAML parser                                                                  |
| `schema.ts`            | Shared Schema predicates used across boundary decoders                                                                      |
| `journal.ts`           | Append-only JSONL: the read that survives a torn line, and the append that makes its dir                                    |
| `harness.ts`           | Per-harness start, model and effort flags, persona injection, and the Collie MCP tools it wires in                          |
| `inputs.ts`            | Input inference from branch, cwd, earlier runs and glab                                                                     |
| `strategies.ts`        | Which Input carries which strategy, and how a settled Run is read through one                                               |
| `workspace.ts`         | The Control Plane: what the Session's board shows, and the text fallback that draws it                                      |
| `ui/`                  | The Collie tab: the card board and its drawer, plain state and commands, and the bridge                                     |
| `views.ts`             | History, Workflows, Settings and a Run's detail, as state the app renders                                                   |
| `board.ts`             | Builds the board from the files: one TaskView per Task and a card's sentence                                                |
| `board-model.ts`       | The board's Schemas, `FrontDoorRpcs`, pure rules, and the one reading of a merge request reference                          |
| `audit.ts`             | A Run's audit trail: each operation, the Actor that asked for it, and what came of it                                       |
| `attachments.ts`       | Files a Run is given: refused or copied into `runs/<id>/attachments/`, and listed for its prompts                           |
| `bridge.ts`            | `collie bridge`: a front door's stdio piped to this Machine's host, declared as it                                          |
| `board-stream.ts`      | The board a host serves one client: a snapshot, then each Task that changed                                                 |
| `read-model.ts`        | Bounded Run disk inputs, invalidated by host writes and the state directory watch                                           |
| `herds.ts`             | Every running herdr session the host reads, its agents, and the events it pushes                                            |
| `attention.ts`         | Why a run wants a human, and which actions are safe now                                                                     |
| `registry.ts`          | Which long-lived agents this Session still has, per workspace + repo                                                        |
| `handoff.ts`           | Giving one Run's result to another Run's live agent                                                                         |
| `output.ts`            | The Output and Synthesis schemas, their parsers, `review.md`, and which findings the loop still owns                        |
| `run.ts`               | The run directory: audit trail and resume state                                                                             |
| `intent.ts`            | What a Run is for, what bounds it, and what Collie may do about it without asking                                           |
| `intent-model.ts`      | The Intent's Schemas alone, so a browser bundle of the board can carry a start                                              |
| `steering.ts`          | The delivery ledger per live agent, and the Herd's model-call budget                                                        |
| `delivery-queue.ts`    | Durable messages awaiting a supported idle submission, and their receipts                                                   |
| `dispatcher.ts`        | The only sender: one transaction per agent, reserved before the send, ordered                                               |
| `steering-caps.ts`     | What each harness has been shown to do about a delivery, and the gate that fails closed                                     |
| `evaluator.ts`         | The one place a model is asked anything, tool-less and capped, and the closed schemas                                       |
| `proposals.ts`         | Hash-bound proposals, and the Confirmation rule that a yes names its exact payload                                          |
| `executors.ts`         | Which action kinds this build can carry out; an unregistered one is refused, never faked                                    |
| `drift.ts`             | Where the work and the Intent disagree: rules, judgement, and the correction loop                                           |
| `verify.ts`            | A command's result bound to its tree, so a card can say verified; a running check's marker and log                          |
| `bun-tests.ts`         | Which tests a failed `bun test` names, and the command that runs one again alone                                            |
| `verify-spec.ts`       | Which commands Collie may run itself for a Run, and where that permission came from                                         |
| `check-proof.ts`       | A Check's proof on a tree, and which of a Run's Checks it runs itself                                                       |
| `ci-job.ts`            | A check left to CI: its job read through the forge, a failure settled, waited on, its pass recorded                         |
| `landing.ts`           | A Run's merge at a head: its landing record, and the one rule settling an attempt a restart interrupted                     |
| `review-wait.ts`       | Where a merge request's review stands for a Release Run, and the wait's parked line                                         |
| `releasing.ts`         | A Release Run's checkout fast-forward, and its tag, stage and production read from the forge                                |
| `checks.ts`            | The one reading of a Run's running and finished checks that every door uses                                                 |
| `outcome.ts`           | What a Run must prove to close, per kind, and what is still missing                                                         |
| `metrics.ts`           | What a Run produced and when: evidence, slices, rework, context — never pane activity                                       |
| `report.ts`            | Where Runs end across every Run: per workflow, and each that failed, finished or stopped                                    |
| `outcomes.ts`          | The report's measures: rounds, dispositions, steering, verifications, parks, context — each with its Runs                   |
| `issue-privacy.ts`     | The bounded checkout walk and directory aliases inspected before publishing issue text                                      |
| `cards.ts`             | One slice of work as a human wants it handed over, with its readiness and significance                                      |
| `disposition.ts`       | What became of a Run's work, recorded beside its status and never over it                                                   |
| `conversation.ts`      | What the human and Collie have said about this Herd, redacted and reference-checked                                         |
| `redact.ts`            | Credential-shaped values replaced by their kind, the one list chat, cards and every front door use                          |
| `chat.ts`              | The Home's native conversation: which harness, which session, and how it is launched                                        |
| `toolkit.ts`           | `CollieTools`, the Effect Toolkit of everything a chat may ask, and nothing else                                            |
| `actions.ts`           | The closed union of everything a model may propose, with no effects                                                         |
| `tools.ts`             | Native chat's answers to that Toolkit, read from this Machine's own files and host                                          |
| `mcp.ts`               | That Toolkit over MCP on stdio, which is how Claude Code reaches it                                                         |
| `engine.ts`            | Effect's workflow engine, the SDK the binary serves a module, and where generations live                                    |
| `host.ts`              | The one host per state directory: who owns it, the board it serves, every operation                                         |
| `host-files.ts`        | A Machine's files for a front door: read in parts, glob, grep, write and edit, never into its state                         |
| `uploads.ts`           | Files a front door sends this Machine, kept once by sha256, swept a week after last use                                     |
| `host-log.ts`          | The host's own log file beside its state, bounded and rotated                                                               |
| `run-detail.ts`        | One Run's diff against its merge base, items by reference, and a drawer's subscription                                      |
| `run-waits.ts`         | One Run's Waits: its questions, pending proposals, blocked agent, park, hold, memory wait and awaiting                      |
| `steps.ts`             | What a Step is as data, and the records the host keeps of a Run's work entering and leaving one                             |
| `run-log.ts`           | Serialized log writes and a rebuildable line count, so Step markers and capped tails share absolute line numbers            |
| `step-durations.ts`    | This Machine's last ten completed calls per Workflow and Step, rebuilt once when absent and read without scanning past Runs |
| `step-steering.ts`     | Pending Step pauses and notes, with authors, read times and prompt consumption                                              |
| `flow.ts`              | A Run's Flow, built from its Step records, launches, questions and children (pure)                                          |
| `flow-read.ts`         | A Run's Flow as the host reads it: those records gathered from its directory and the engine                                 |
| `run-links.ts`         | Notices of agent-requested Runs and the recorded delivery of each notice                                                    |
| `run-link-delivery.ts` | Admission and settlement notices sent to a requesting Run's paired host                                                     |
| `side-jobs.ts`         | What the host does with no pane open: the merge watch, each Herd's News, cleanup and Home tokens                            |
| `cleanup.ts`           | What a sweep removes and keeps, one sweeper per kind, and the journal of what went (ADR-0045)                               |
| `bytes.ts`             | A size as `collie cleanup` and Desktop say it (pure)                                                                        |
| `discovery.ts`         | Where a workflow module is looked for, which layer wins, and what counts as an edit                                         |
| `authoring.ts`         | What a module says about itself, how it is checked, and the file an author starts from                                      |
| `definitions-model.ts` | A host's Workflows and Personas as front doors read them: Schemas shared with Desktop (pure)                                |
| `store.ts`             | Rows beside Effect's: request claims, run identity, generations, questions                                                  |
| `release.ts`           | Whether an installation is a release or a development checkout, and placing the release a runner carries                    |
| `releases.ts`          | The newest published release, and a release's runner downloaded and verified against the release key                        |
| `onboard.ts`           | A Machine from bare to a working host, one streamed step at a time, never with sudo                                         |
| `in-terminal.ts`       | A login or a question in a terminal Bun gives it, on Linux and macOS alike, never through `script`                          |
| `run-actions.ts`       | What a confirmed action does to a Run, and the one place each kind is carried out                                           |
| `lifecycle.ts`         | A front door's side of every host operation, the board and a drawer's details                                               |
| `signing.ts`           | The release key: signing a runner or Desktop's update in CI, and the check before either is installed                       |
| `desktop.ts`           | `collie upgrade`'s Desktop step: a verified Desktop update, staged as Electrobun would                                      |
| `sdk.ts`               | `collie`: what a module exports, declares, waits on, and starts as a child, and what it refuses                             |
| `agents.ts`            | What a workflow does with an agent: one launch, one collection, one repair                                                  |
| `automode.ts`          | The `autoMode` block a Claude agent is launched with: what its Run authorises                                               |
| `launches.ts`          | What each of a Run's agents was launched on, read back in launch order                                                      |
| `proactive.ts`         | What is worth Collie starting a turn about, and what it has already said                                                    |
| `news.ts`              | What it noticed, per conversation: deduped, batched, superseded; sent is never read                                         |
| `home.ts`              | Which workspace is this Herd's Home, decided by proof and never by a label                                                  |
| `live.ts`              | The board's Live region and every row's marks, from one pass. Read-only                                                     |
| `lines.ts`             | A card, a report, a delivery, a row's marks and an action, as the same words everywhere                                     |
| `plan.ts`              | A plan directory as repositories and waves, and the refusals that stop a fan-out                                            |
| `lock.ts`              | The pid-lock discipline every single-owner file takes, the host's own lock among them                                       |
| `script.ts`            | Literal shell arguments and a login under `script`'s pseudo-terminal on Linux or macOS                                      |
| `task.ts`              | A Task: the work, its herdr workspace, and which Runs belong to it                                                          |
| `tasknames.ts`         | What a task workspace is called, from the work and the session's own live labels                                            |
| `naming.ts`            | herdr-legal agent names vs readable tab and pane labels, and which labels Collie still owns                                 |
| `keys.ts`              | Raw keypresses, for the text board a pane falls back to when the renderer will not start                                    |
| `fork.ts`              | Take a persona into a later layer: an `extends:` stub, or a full copy                                                       |
| `trust.ts`             | Whether a harness will work in a directory, or stop and ask first                                                           |
| `agent-start.ts`       | An agent's start names its checkout and every Input, or is refused with what fills each                                     |
| `agent-end.ts`         | The one end of a Run's agent: proved its own, stopped, Quiet, its pane closed, the end logged                               |
| `projects.ts`          | The Projects root, where it came from, and the checkouts under it                                                           |
| `route.ts`             | Where a start from the Home goes: a URL's checkout by remote, else one routing call                                         |
| `worktree.ts`          | The checkout a mutating Run owns, keyed by its branch, and pruning the settled ones                                         |
| `helle.ts`             | Helle as a client, and the gate a Step blocks on until it holds the project                                                 |
| `mr.ts`                | What a merge request step needs: assignee, template, the Linear tickets a branch answers                                    |
| `forge/forge.ts`       | The forge interface, and which adapter a merge request is on (ADR-0050)                                                     |
| `forge/issues.ts`      | Shared issue values and the created issue URL decoded from an adapter's answer                                              |
| `forge/review.ts`      | A merge request's review read and merge answer, and the one rule for external and answered comments                         |
| `forge/gitlab.ts`      | The GitLab adapter: everything Collie asks GitLab, through `glab` or over HTTP with its token                               |
| `forge/github.ts`      | The GitHub adapter: everything Collie asks GitHub, through `gh` or over HTTP with its token                                 |
| `forge/http.ts`        | ForgeHttp: a `forges` provider per host, its token from the CLI's login; the library loaded here                            |
| `forge/threads.ts`     | Modelled issue, review-posting, menu and login operations shared by the forge adapters                                      |
| `forge/*-checks.ts`    | Each forge's doctor checks; GitLab's configured Connection probe and reusable login selection                               |
| `template.ts`          | `{{a.b}}` prompt substitution                                                                                               |
| `config.ts`            | User defaults and remembered values in `config.json`                                                                        |
| `profile.ts`           | The operator's `agent_profile`: per role, an agent's env and the Claude settings merged into Collie's                       |
| `subagents.ts`         | Claude subagent policy: validation, cache retention, delegation limits, and the native settings it needs                    |
| `skill-overrides.ts`   | Which unnamed Claude skills are listed by name only, preserving operator choices and invocation restrictions                |
| `compaction.ts`        | One threshold, one work-boundary policy, each agent's controls for its lifetime, and its one stop                           |
| `compactors.ts`        | Each harness's official compaction interface, generated per agent and bundled in Collie                                     |
| `codex.ts`             | Codex's App Server as a client: thread identity, its context, its compactions and its turns                                 |
| `collecting.ts`        | Which agents Collie is collecting an Output from now, by Run and agent                                                      |
| `controls.ts`          | The Hold and Stop an operator sets over a Run, one file each, and whether one is set                                        |
| `processes.ts`         | Where a process's command, start time and session are read, and proven before anything signals it                           |
| `check-processes.ts`   | A check's processes from spawn to gone: marked, recorded, and ended with the host that runs them                            |
| `usage-model.ts`       | A Subscription's Usage reading: Schemas, parsing, Exhausted; pure, so Desktop and a module share it                         |
| `usage.ts`             | This Machine's Usage readings: Claude's endpoint, Codex's app server, status lines                                          |
| `catalogue-model.ts`   | A Harness catalogue: its Schemas, one decoder per harness's output, Collie's table (pure)                                   |
| `catalogue.ts`         | This Machine's Harness catalogue: each harness read on an interval, with its timeout and back-off                           |
| `connection-model.ts`  | Connection reading Schemas and the text the CLI and chat print (pure)                                                       |
| `connection-probes.ts` | Linear MCP and Helle probes; reexports the forge adapters' probes                                                           |
| `connection-login.ts`  | Reads a reusable login through its forge adapter for host-to-Desktop hand-over, without recording the token                 |
| `slack.ts`             | Slack Web API adapter: identity, member channels, people, direct messages, posts and permalinks                             |
| `slack-credentials.ts` | Reads and writes each Machine's Slack token and supplies its registry reading and channel choices                           |
| `connections.ts`       | The Connection registry: each probe isolated and bounded, shared by the host, doctor and workflow reads                     |
| `schedule-model.ts`    | A Schedule as every door reads it, and when an occurrence starts and which comes next (pure)                                |
| `schedules.ts`         | This Machine's Schedules: their records, the one write, and the `Schedule` workflow that fires them                         |
| `run-record.ts`        | Run records served by their owning host, including Outputs confined to the Run directory                                    |
| `verify-model.ts`      | Verification and stream Schemas shared with front doors without loading the collector                                       |
| `measurement.ts`       | A Measurement taken: the base tree, the Machine's one-at-a-time lock, A B B A samples and the record, for both doors        |
| `measurement-model.ts` | A Measurement's plan, record and stream Schemas, shared with front doors without loading the sampler                        |

The Machine link is `peers.ts`: pairing, TLS channels, relay sockets, dial-back and
keeping paired Machines level. `peer-transport.ts` is the way to a peer this Machine
dials: direct, then through the Machine's SSH connection, with its bounds and its words.
`ssh-connection.ts` runs every ssh command against a Machine: its control path, the one
opener a front door runs, the host's `-O`-only handle and the sweep that closes what herdr
no longer names, and `-G`. `ssh-argv.ts` holds the argv and bounds Desktop shares with it, the rider
a session through the connection uses among them, so Desktop never loads the host's lock. `peers-model.ts` holds the peer records and states
Desktop shares. `flock-settings.ts` holds the latest-edit rule and merge both hosts and
Desktop use. `shared-definitions.ts` reads and writes the user Layer's files a Flock
shares, keeping replaced text under `replaced/`. `channel.ts` declares and pipes the channel the bridge and peer link share.

`reports.ts` sends a settled Run's result to its recorded requester once, through the
Dispatcher, and closes a `closes: "reported"` Run's own agents and eligible Task workspace.
Repository placement is resolved by `projects.ts` and fetched by `agent-start.ts`; the
engine carries the fetched revision through admission and placement.
