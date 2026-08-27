# herdr-plugin — Context

## Glossary

**Workflow** — A named, ordered list of Steps with declared Inputs. Deterministic in sequence; agents may hand off to each other. Defined in one markdown file (frontmatter + prompt body). May embed another Workflow by reference (`use:`).

**Step** — One unit of agent work inside a Workflow. Runs in its own Tab. Has a Persona, a Harness, a Model, and optionally a structured Output. May be `fresh` (new agent each iteration) or continue the existing agent.

**Persona** — Harness-agnostic instructions injected when an agent starts (e.g. implementer, reviewer). Not a harness-native config file.

**Harness** — The agent CLI a Step runs in (claude, codex, opencode, …). User default, per-Step override.

**Model** — The model a Harness is asked to use. User default, per-Step override. Unknown model ⇒ launch fails before any Tab opens.

**Input** — A value a Workflow needs (plan file, diff target, goal). Inferred from context (branch, cwd, tasks/, glab); the human is asked only when inference fails.

**Output** — A structured JSON file a Step writes to the Run directory (e.g. a review verdict + findings). Gates and loops read Outputs, never terminal text.

**Run** — One execution of a Workflow: its Inputs, Step Outputs and status, kept as an audit trail. A Run can be resumed: finished Steps are skipped, unfinished ones restart with fresh agents.

**Layer** — A directory of Workflow/Persona definitions. Three Layers, later wins by name: plugin baseline (git) → user config dir → project `.herdr/`. Forking copies a baseline definition into a Layer.

**Fan-in** — Combining several parallel reviewer Outputs. v1: union of findings; the implementer may mark items `disputed`, surfaced to the human.

## Baseline Workflows
- `plan` — interviews the human, writes `tasks/<slug>/PLAN.md`.
- `implement` — build from plan → parallel `review` (multi-harness/model) → fix loop, max 5 → clean review on a committed branch. MR creation is a separate appendable step.
- `review` — standalone; target inferred MR → branch diff → working tree; writes Output + summary; posting to GitLab is opt-in.
