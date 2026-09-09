# Collie — Context

## Glossary

**Workflow** — A named, ordered list of Steps with declared Inputs. Deterministic in sequence; agents may hand off to each other. Defined in one markdown file (frontmatter + prompt body). May embed another Workflow by reference (`use:`).

**Step** — One unit of agent work inside a Workflow. Runs in its own Tab. Has a Persona, a Harness, a Model, optionally the Skill it drives, and optionally a structured Output. May be `fresh` (new agent each iteration) or continue the existing agent.

**Trust** — A Harness's own answer to "may I work in this directory". Asked once per directory, by the runner before any Tab opens, and recorded where that harness looks for it. `never` leaves the question to the harness; `auto` answers yes for every directory a Run starts in.

**Permissions** — Who decides whether an agent's tool call runs: Collie up front (`bypass`, the default, which starts each agent with its harness's unattended switch), or the harness in the agent's own pane (`harness`). Trust is answered once per directory; this is decided per agent start, and a Step may name its own mode. Trust is about the directory, Permissions about the calls made inside it.

**Skill** — A named routine the harnesses share. Installed globally by the skills.sh CLI (`npx skills add … -g`) into `~/.agents/skills`, which is the standard location every harness but Claude Code reads directly; Claude Code gets an explicit symlink from the same CLI. A Step names the one it drives, and the prompt is sent as `/<skill> …`: many skills refuse an agent that starts them itself, and only the human's channel may invoke those.

**Persona** — Harness-agnostic instructions injected when an agent starts (e.g. implementer, reviewer). Not a harness-native config file.

**Harness** — The agent CLI a Step runs in (claude, codex, opencode, …). User default, per-Step override.

**Model** — The model a Harness is asked to use. User default, per-Step override. Unknown model ⇒ launch fails before any Tab opens.

**Input** — A value a Workflow needs (plan directory, diff target, goal). Inferred from context (branch, cwd, earlier plan Runs, glab); the human is asked only when inference fails.

**Output** — A structured JSON file a Step writes to the Run directory (e.g. a review verdict + findings). Gates and loops read Outputs, never terminal text.

**Run** — One execution of a Workflow: its Inputs, Step Outputs and status, kept as an audit trail. A Run can be resumed: finished Steps are skipped, unfinished ones restart with fresh agents. Its **slug** — `<workflow>-<what it is named after>` — names its agents, its tab and its row on the board, and for a mutating Run it is named after the Worktree's branch, so two Runs on different work can never read as the same row.

**Session** — One herdr session and one workspace, taken together. It is the
scope of a Control Plane tab and of the register of live agents, so only Runs in the same
Session can hand work to each other. There is only ever one agent per role in a Session.
One workspace, always: a mutating Run's checkout does not take it out of the Session it
was started in, which is what keeps a hand-off between `plan` and `implement` working.

**Hand-off** — Giving one Run's result to another Run's live agent in the same Session
instead of starting a second one. Both Runs record it. Which hand-offs exist and what each
sends: `docs/using.md`.

**Worktree** — The checkout a mutating Run owns: one per branch, because git allows
exactly one worktree per checked-out branch. The branch names the work rather than the path
to it, so two Runs on different work can never key the same checkout
([the order it is resolved in](docs/cli.md#start-a-run)). Only the Run's cwd moves; its tabs stay in
the workspace it was activated from and are `cd`-ed into the checkout, because a Run
belongs where it was started (ADR-0006). `implement` gets one, and `plan`/`architecture`
get one where they chain into it; `review` reads the diff or the caller's own tree.

Two managers, and a Run records which: Collie makes the checkout with `git worktree add`
by default, and `--input workspace=new` asks herdr for it instead, which opens it as a
workspace of its own. It outlives the merge request and is removed only once **Settled** —
a git-managed checkout with `git worktree remove` then `git branch -d`, and the Run's
tabs whose shells sit inside it closed with it; one herdr has a workspace open on through
`herdr worktree remove`, whoever made it, so herdr never lists a checkout that is gone.

A Run records the branch, the path, its manager, whether Collie created it, and the
moment git wrote the checkout — which is what tells Collie's own checkout from one a
human later made at the same path on the same branch. Where herdr opened a workspace for
it, the Run also records the shell tab that workspace came with, which its first agent
takes over so no empty tab is left beside the Run's own. A checkout a human made is never
removed.

**Settled** — A Collie-created Worktree that holds nothing which exists only there: the
tree is clean, it holds no commit that is not on the remote already, nothing is working in
it or could be resumed in it, and its merge request is merged or closed (or its remote
branch is gone). "No commit of its own" is the branch's upstream where it has one, and the
default branch where it does not — a branch merged and deleted loses its upstream ref to
the next `git fetch --prune`, and requiring one would make the gone-branch case
unreachable. Only then is it removed, through herdr, and only ever without a force flag:
git's own refusal to drop a dirty or unmerged checkout is the last guard, so a wrong
judgement can fail to clean but never delete work. Removal is never forced whichever
manager does it. The conditions and their order are canonical in `src/worktree.ts` and
`docs/internals.md`.

**Layer** — A directory of Workflow/Persona definitions. Three Layers, later wins by name: plugin baseline (git) → user config dir → project `.herdr/`. Forking takes a baseline definition into a Layer.

**Override** — A definition that declares `extends: <name>` and changes only what it names; everything else still follows the parent in the Layer below. A file without `extends:` replaces the whole definition, and a full copy records `forked_from_hash` so a parent that has moved on can be marked stale. The merge rules are canonical in `src/definitions.ts` and `docs/authoring.md`.

**Fan-in** — Combining several parallel Outputs into one. A Step declares `fan_in: <step>`, is given that Step's Output files, and reconciles them itself; it sits in that Step's tab. The engine no longer unions findings.

**Synthesis** — What a fan-in Step over reviewers writes: one review of the change, deduplicated across models, disagreements settled from the diff, plus a `summary` and the findings it `dropped` with a reason for each. The engine renders it to `review.md`, which is what a human reads and what a Choice may post. It is the loop's gate: the fix Step sees the Synthesis, never the raw reviews.

**Disputed** — A finding the implementer declined, with its reason. The reviewers are shown the reason, and a disputed finding no longer drives the loop, so the Run converges and the human decides. A reviewer who can answer the reason raises it again with a `rebuttal`, which puts the finding back in front of the implementer.

## Baseline Workflows

What each is for, what it needs, and how they chain: `docs/workflows.md`.

- `plan` — interviews the human, then writes `SPEC.md` and one ticket per slice into its Run's plan directory (ADR-0002).
- `implement` — builds from a work source, embeds `review`, loops on the findings, and ends at `mr`, the only step that opens or updates the merge request.
- `review` — standalone; you pick the target; parallel reviewers, then one Synthesis.
- `architecture` — runs the architect over the project and reports into its Run's plan directory.

**Choice** — A Step that asks the human to pick from a menu instead of running an agent. A choice chains to another Workflow (`run`), prompts a named agent (`prompt`), posts the run's review to the merge request it reviewed (`post`), or just ends the Step (`stop`). A Choice with one thing left to offer is taken rather than asked.

**Decision** — An answer given before a Choice step is reached, kept in the Run record by step id. `run start --decide <step>=<title>` is the only way to give one: launching a Workflow asks its Inputs and nothing else, and every Choice is asked when the Run reaches it. Taken only if that choice is still available when the step is reached; otherwise the Run asks, and says why. Titles name decisions, so two choices that can never both be offered — a hand-off and its stand-alone twin — may share one.

**Chain** — Starting a Workflow from a Choice, with Inputs forwarded. The new Run is a child of the current one. A Choice may chain several Runs at once, one per repository a plan touches; see Repo run.

**Plan directory** — The `plan/` folder inside a Run: SPEC.md and the ticket files. It is the hand-off from `plan` to `implement` and never lives in the repository. Every ticket names the repository it changes with a `Repo:` line: a path under the Run's root, `.` for the root itself, never absolute and never containing `..`.

**Repo run** — One `implement` Run of a chained fan-out, owning one repository's branch and merge request and building only the tickets whose `Repo:` names that repository. Every Repo run of one plan uses the same branch name.

**Wave** — The Repo runs a fan-out starts together: those whose tickets are blocked by no ticket of a Repo run still going. Ticket order inside a repository is the Repo run's; cross-repository order is the wave's. A plan whose repositories block each other in a cycle has no wave order and is refused, as is one whose "Blocked by" line names something that is not a ticket of the plan, or which numbers two tickets the same so that such a line cannot say which it means.

**Deferred** — Architecture candidates the architect chose not to apply unattended, kept in the summary for the human.

**Collie tab** — The Session's own tab, labelled `🐕 Collie`: the Control Plane rendered
as an application (ADR-0005). One per workspace. Effect produces its state and Solid renders
it; a pane that cannot start the renderer falls back to the one-screen text view.

**View** — What the Collie tab's nav switches between, one at a time, each a projection of
state Effect produces and none of them read until it is first shown. **Runs** is this
Session's live work: agents, active Runs, finished Runs. **History** is every finished Run
of this checkout whatever session it came from — where "review !123 again next week" comes
from once the original Run is gone. **Workflows** is every Workflow and Persona with its
layer, Inputs, decisions and whatever validation says is wrong with it. **Settings** is the
defaults and remembered values in `config.json`, and whether the harness is trusted here.

**Launch flow** — The questions between "run a workflow" and a Run: which Workflow, its
Inputs, and the candidates for the ones that have them. Nothing about its Choices — those
are asked when the Run reaches them, with the work they decide about in front of the
human. One set of components, two placements — a popup pane for the herdr action, and inline in the
Collie tab for `＋ New run` — because a question a human answers is a component. A
question a Run answers is a file in its Run directory, and those two never converge.

**Selection** — The one row every action applies to, whether the mouse or the keyboard
cursor put it there. Held by the row's stable id — a Run id, an agent name — never an
index, because the list re-sorts under it. Moving it is a change in what is read, not in
what is true: the detail panel and the one merge request behind it are produced for the
Selection, and a read superseded by a newer Selection is interrupted rather than finished.

**Focus** — What the Collie tab is being looked at as: the showing View, every View shown
at least once, the Selection, and whether the panel's log tail is open. It is what decides
how much has to be read, so it is state rather than a render-local signal, and it is plain
data: one function says where a focus command leaves it, and one says what a new one means
for the reads behind it — whether the last board may be reused, and whether the merge
request must be read past its cache.

**Control Plane** — The tab a Session keeps as its control surface, one per workspace, and
the only pane Collie keeps open. It is a view over the run dirs and the register, always the
workspace's first tab, and holds no state of its own, so closing it loses nothing. Its Runs
view is drawn at a **Scope**. What it shows and what its keys do: `docs/using.md`. Behind it the strip reads `plan`, `implement`,
`review`, then anything else in start order: Collie places each tab by its Run's workflow
when it creates it, and never moves a tab it does not own or one a human has since dragged.

**Scope** — What a Control Plane's Runs view is a board of: `local`, this Session's own
workspace, or `all`, every workspace of this herdr session that Collie has a Run, an agent
or a history in — one grouped tree, with the session's other workspaces named on a closing
line. `g` toggles it in the tab and nothing remembers which; the Scope a tab opens on is
the `scope` default in `config.json`. The wider Scope changes what is shown and what a Run
lookup searches, never what a Session is: hand-offs, the register and starting a Workflow
stay this Session's.

**Work boundary** — The moment immediately before a reused agent that has finished its
previous work is given the next piece: a Workflow's next step on the same agent, a fix
round's next iteration, a hand-off from another Run. It is where Collie reads that
harness's current-context measure and, at or above the user-wide `compact_at_tokens`,
asks it to compact natively before sending anything. Not a liveness nudge, not a
mid-step recovery message, and not a human typing in the pane — none of those are work.
A freshly launched agent has no boundary before its first piece of work. What Collie
does with each outcome, and what a five-minute unresolved attempt stops:
`docs/using.md`.

**Notification** — The only channel from an unattended Run to the person who started it, so what is not worth interrupting for is not sent at all. One title shape — `<repo> · <slug> <what happened>` — one taxonomy in `src/notify.ts`, once per `(run, kind, step)`, and never a reason for a Run to fail.

**Driver** — The process that executes a Run. It has no pane: it is detached from whatever
started it, writes its progress and any failure into the Run directory, and asks its
questions through files there. An ownership claim in the Run directory — acquired
atomically and carrying the process's identity — says whether one is still driving, so
`resume` never starts a second and a stop signal never reaches an unrelated process.

**Ownership** — What the Driver's claim in the Run directory says, in three answers rather
than two: `live` (a process is driving), `none` (conclusively nobody — no claim, or a claim
whose process is gone or whose identity does not match), and `unknown` (a claim whose
process answers but whose identity could not be read). The third is the point of having
three: "I could not tell" is not permission to start a second Driver, so only `none` allows
a resume. Canonical in `src/driver.ts`.

**Attention** — What a Run wants from whoever is watching it, as one classification both
front doors render: a pending Choice, a completed Run, an interruption, or nothing yet.
Additive to the lifecycle status rather than a redefinition of it — `waiting` still means
"has not settled" for every existing wait and fan-out — and derived from what the Run
already recorded: its Step results, the findings the loop still owns, the stop marker and
the Driver's Ownership. It carries a stable reason code, the sentence a human reads, the
Steps a resume would keep, the agents that may still be live, and the actions that are
valid now. What none of the recorded facts settle is said to be unsettled, never guessed.
`collie run wait --until attention`, `run show` and the Control Plane's detail panel are
three readings of this one value; canonical in `src/attention.ts`, with the reason codes in
`docs/cli.md`.
