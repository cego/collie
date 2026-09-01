# Collie — Context

## Glossary

**Workflow** — A named, ordered list of Steps with declared Inputs. Deterministic in sequence; agents may hand off to each other. Defined in one markdown file (frontmatter + prompt body). May embed another Workflow by reference (`use:`).

**Step** — One unit of agent work inside a Workflow. Runs in its own Tab. Has a Persona, a Harness, a Model, optionally the Skill it drives, and optionally a structured Output. May be `fresh` (new agent each iteration) or continue the existing agent.

**Trust** — A Harness's own answer to "may I work in this directory". Asked once per directory, by the runner before any Tab opens, and recorded where that harness looks for it. `never` leaves the question to the harness; `auto` answers yes for every directory a Run starts in.

**Skill** — A named routine installed in every harness (`skills.sh`). A Step names the one it drives, and the prompt is sent as `/<skill> …`: many skills refuse an agent that starts them itself, and only the human's channel may invoke those.

**Persona** — Harness-agnostic instructions injected when an agent starts (e.g. implementer, reviewer). Not a harness-native config file.

**Harness** — The agent CLI a Step runs in (claude, codex, opencode, …). User default, per-Step override.

**Model** — The model a Harness is asked to use. User default, per-Step override. Unknown model ⇒ launch fails before any Tab opens.

**Input** — A value a Workflow needs (plan directory, diff target, goal). Inferred from context (branch, cwd, earlier plan Runs, glab); the human is asked only when inference fails.

**Output** — A structured JSON file a Step writes to the Run directory (e.g. a review verdict + findings). Gates and loops read Outputs, never terminal text.

**Run** — One execution of a Workflow: its Inputs, Step Outputs and status, kept as an audit trail. A Run can be resumed: finished Steps are skipped, unfinished ones restart with fresh agents.

**Session** — One herdr session, one workspace and one repo cwd, taken together. Runs in
the same Session share a Control Plane tab and a register of each other's long-lived agents,
and hand work to them; runs in another workspace, another checkout, or another herdr session
never see them. There is only ever one agent per role in a Session.

**Hand-off** — Giving one Run's result to another Run's live agent instead of starting a
second one. `review` → the live implementer (its findings as a fix round), or, when none is
live, a new `implement` run on the reviewed target. `plan` → the implementer building from
that plan, whenever the plan changes under it. `implement` → the planner, for a decision the
plan does not cover. Both Runs record it.

**Layer** — A directory of Workflow/Persona definitions. Three Layers, later wins by name: plugin baseline (git) → user config dir → project `.herdr/`. Forking takes a baseline definition into a Layer.

**Override** — A definition that declares `extends: <name>` and changes only what it names: steps matched by id, inputs merged by name, scalars and `## sections` replaced where given, and everything else still following the parent in the Layer below. A file without `extends:` replaces the whole definition, and a full copy records `forked_from_hash` so a parent that has moved on can be marked stale.

**Fan-in** — Combining several parallel Outputs into one. A Step declares `fan_in: <step>`, is given that Step's Output files, and reconciles them itself; it sits in that Step's tab. The engine no longer unions findings.

**Synthesis** — What a fan-in Step over reviewers writes: one review of the change, deduplicated across models, disagreements settled from the diff, plus a `summary` and the findings it `dropped` with a reason for each. The engine renders it to `review.md` — summary, then findings by severity — which is what a human reads and what a Choice may post to the merge request. It is the loop's gate: the fix Step sees the Synthesis, never the raw reviews.

**Disputed** — The implementer may mark a finding `disputed` with a reason; the reviewers are shown those reasons and a disputed finding no longer drives the loop, so the run converges and the human decides. A reviewer who can answer the reason raises it again with a `rebuttal`, which puts it back in front of the implementer.

## Baseline Workflows

- `plan` — interviews the human, writes `SPEC.md` and one ticket per slice into its Run's plan directory (ADR-0002), then a Choice: implement now, second opinion, offload to Linear, refine.
- `implement` — build from plan → parallel `review` (multi-harness/model) → fix loop, max 5 → clean review on a committed branch → `mr`, which pushes and opens the merge request. That last step is skipped where there is no GitLab to open one on.
- `review` — standalone; you pick the target; parallel reviewers, then one Synthesis; posting it to the merge request is a Choice.
- `architecture` — runs the architect over the project, reports into its Run's plan directory, then a Choice: implement now or stop.

**Choice** — A Step that asks the human to pick from a menu instead of running an agent. A choice chains to another Workflow (`run`), prompts a named agent (`prompt`), posts the run's review to the merge request it reviewed (`post`), or just ends the Step (`stop`).

**Chain** — Starting a Workflow from a Choice, with Inputs forwarded. The new Run is a child of the current one.

**Plan directory** — The `plan/` folder inside a Run: SPEC.md and the ticket files. It is the hand-off from `plan` to `implement` and never lives in the repository.

**Deferred** — Architecture candidates the architect chose not to apply unattended, kept in the summary for the human.

**Control Plane** — The tab a Session keeps as its control surface, one per workspace, and
the only pane Collie keeps open: live agents, active Runs with their step and last
line, this Session's finished Runs, quick actions, and any question a Run is waiting on,
rendered under that Run. It is a view over the run dirs and the register, always the
workspace's first tab, and holds no state of its own.

**Driver** — The process that executes a Run. It has no pane: it is detached from whatever
started it, writes its progress and any failure into the Run directory, and asks its
questions through files there. An ownership claim in the Run directory — acquired
atomically and carrying the process's identity — says whether one is still driving, so
`resume` never starts a second and a stop signal never reaches an unrelated process.
