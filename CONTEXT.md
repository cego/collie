# herdr-plugin — Context

## Glossary

**Workflow** — A named, ordered list of Steps with declared Inputs. Deterministic in sequence; agents may hand off to each other. Defined in one markdown file (frontmatter + prompt body). May embed another Workflow by reference (`use:`).

**Step** — One unit of agent work inside a Workflow. Runs in its own Tab. Has a Persona, a Harness, a Model, optionally the Skill it drives, and optionally a structured Output. May be `fresh` (new agent each iteration) or continue the existing agent.

**Trust** — A Harness's own answer to "may I work in this directory". Asked once per directory, by the runner before any Tab opens, and recorded where that harness looks for it. `never` leaves the question to the harness; `auto` answers yes for every directory a Run starts in.

**Skill** — A named routine installed in every harness (`skills.sh`). A Step names the one it drives, and the prompt is sent as `/<skill> …`: many skills refuse an agent that starts them itself, and only the human's channel may invoke those.

**Persona** — Harness-agnostic instructions injected when an agent starts (e.g. implementer, reviewer). Not a harness-native config file.

**Harness** — The agent CLI a Step runs in (claude, codex, opencode, …). User default, per-Step override.

**Model** — The model a Harness is asked to use. User default, per-Step override. Unknown model ⇒ launch fails before any Tab opens.

**Input** — A value a Workflow needs (plan file, diff target, goal). Inferred from context (branch, cwd, tasks/, glab); the human is asked only when inference fails.

**Output** — A structured JSON file a Step writes to the Run directory (e.g. a review verdict + findings). Gates and loops read Outputs, never terminal text.

**Run** — One execution of a Workflow: its Inputs, Step Outputs and status, kept as an audit trail. A Run can be resumed: finished Steps are skipped, unfinished ones restart with fresh agents.

**Layer** — A directory of Workflow/Persona definitions. Three Layers, later wins by name: plugin baseline (git) → user config dir → project `.herdr/`. Forking copies a baseline definition into a Layer.

**Fan-in** — Combining several parallel reviewer Outputs: the union of their findings. The implementer may mark an item `disputed` with a reason; the reviewers are shown those reasons and a disputed finding no longer drives the loop, so the run converges and the human decides. A reviewer who can answer the reason raises it again with a `rebuttal`, which puts it back in front of the implementer.

## Baseline Workflows
- `plan` — interviews the human, writes `tasks/<slug>/PLAN.md`.
- `implement` — build from plan → parallel `review` (multi-harness/model) → fix loop, max 5 → clean review on a committed branch. MR creation is a separate appendable step.
- `review` — standalone; target inferred MR → branch diff → working tree; writes Output + summary; posting to GitLab is opt-in.

**Choice** — A Step that asks the human to pick from a menu instead of running an agent. A choice either chains to another Workflow (`run`) or prompts a named agent.

**Chain** — Starting a Workflow from a Choice, with Inputs forwarded. The new Run is a child of the current one.

**Plan directory** — The `plan/` folder inside a Run: SPEC.md and the ticket files. It is the hand-off from `plan` to `implement` and never lives in the repository.

**Deferred** — Architecture candidates the architect chose not to apply unattended, kept in the summary for the human.
