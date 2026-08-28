# workflows v2 — implementation report

All eight tickets are `done` and committed on `master` (local only, never pushed), plus
three follow-ups mk asked for afterwards (convergence, workarounds for the two harness
facts below, and pre-trusting). `bun test` is green: 128 tests, 19 files. `bunx tsc --noEmit` is clean, and
the runner still compiles.

```
e303ecc Trust a directory before the harness has to ask
6686f76 Work around a harness that will not start or will not be told
4c5879f Let a disputed finding settle the argument
a81ab87 Build, tidy, review, fix — implement v2                (08)
4d6d439 Add the architecture workflow, attended and not        (07)
372cbbc Grill, spec, tickets, then a menu                      (06)
add3705 Name the skills in four thin personas                  (05)
cbaeb85 Let a step name the body section it sends              (04)
04a2754 Chain a child run from a Choice                        (03)
ae3e1f4 Ask the human with a Choice step                       (02)
2dcaaa9 Write plan artefacts to the run dir                    (01)
```

The baseline is now five workflows (`plan`, `ticket`, `implement`, `review`,
`architecture`) and four personas (`planner`, `implementer`, `reviewer`, `architect`).
Every decision taken where the design was silent is recorded in the ticket it belongs
to, under "Decisions where the design was silent".

## What shipped, per ticket

**01 — run-dir artefacts.** `{{run.dir}}` (with `.id` and `.slug`) in every prompt, and a
`plan-dir` Input strategy: the newest finished Run for this repo that wrote
`plan/SPEC.md`. No baseline text mentions `tasks/` any more, and `plan-file` is gone
(ADR-0002). A Resolution may carry a short `label` so the Run is called
`implement-add-a-picker` rather than being named after a state-dir path. Also fixed: a
headingless body was being sent as both preamble and prompt, so v1's `plan` prompt
arrived twice in every run.

**02 — Choice step.** `choices:` renders the picker in the runner pane. A choice needs a
title and exactly one of `run:`, `prompt:` or `stop:`. A `prompt` choice runs one agent
round — the workflow's own agent (`agent: grill`) or a fresh one with its own
persona/model/effort — writes its Output under
`steps/<step>/<choice-slug>-<n>/`, and then offers the menu again; `max:` caps how often
a choice may be taken; `follow_up:` is a second round that runs only when the first
reported findings; `config: {key, question}` asks for a value once and keeps it in
`config.json`, readable as `{{config.<dotted.key>}}`. Esc leaves the step unfinished so
the run stays resumable. The menu is a seam (`EngineOptions.prompts`) so tests script it.

**03 — chaining.** `run:` resolves the named workflow, forwards the inputs the choice
sets (templated), infers the rest, asks for what is left, creates the child Run with a
`parent`/`children` link and opens its runner pane in the same workspace. The child
inherits the parent's name (`plan-add-a-picker` → `implement-add-a-picker`). Steps after
the choice are left `pending` with a note saying why. Cancelling the question abandons
the chain and brings the menu back.

**04 — prompt-section override.** Any step may set `prompt: <section>` to send a section
other than its own id; on a `use:` step the section is looked up in the embedded
workflow's body. An unknown section names that file and lists what it does offer.

**05 — personas v2.** Four thin personas that name their skills, state their constraints,
and end with `## Output` then `## Fallback` — the fallback being what to do in a harness
where the skill is missing. The reviewer runs both `/code-review` and
`/code-review-and-quality` and merges them into one verdict.

**06 — plan v2 and ticket.** One planner agent across `grill` → `spec` → `tickets`, all
writing into `{{run.dir}}/plan`, then the four-choice menu (Implement now / Second
opinion / Offload to Linear / Refine). `ticket` is `use: plan` with a new `issue` Input
strategy (Linear id from the branch, else asked). Embedding renames steps, so embedded
back-references (`agent:`, `repeat.from`, a choice's `agent:`) are rebased with them.

**07 — architecture.** One architect step with an `attended` and an `unattended` body,
plus a menu (Implement now / Stop here) marked `standalone: true`, which drops out as
soon as the workflow is embedded. The report goes to `{{run.dir}}/plan/ARCHITECTURE.md`;
`deferred` candidates reach the run record and the end of the summary.

**08 — implement v2 and review v2.** `build` (branch off the default branch, `/implement`
+ `/tdd` per ticket, commit per ticket, no commit step) → `architecture` (unattended) →
`simplify` → `review` (two variants) → `fix`, with `repeat: {from: review, back_to:
simplify}`: the gate is the review, the loop restarts at simplify, and architecture stays
out of it. `review.md` carries the opus/sonnet variants itself, so standalone review and
the review inside `implement` are the same reviewer at two models. An `agent:` group now
shares one agent even across a resume.

## Verified live vs. by tests only

Verified live, inside this herdr 0.7.5 session (four real runs, three of them
end to end):

- **`review` on this repo's working tree** with the v2 reviewer persona
  (`review-worktree-20260827-120549`): schema-valid `review.json` naming both skills'
  axes, and it caught a real bug — `architect.md`'s Output block showed `"findings": []`
  literally next to a `verdict: "findings"` instruction, which `src/output.ts` rejects.
- **`plan` end to end in a sandbox repo** (`plan-…-20260827-121724`): a real planner
  interviewing in its own tab, the runner's "⏸ … is waiting for you in its tab" handoff,
  one agent across grill → spec → tickets, `plan/SPEC.md` and
  `plan/issues/01-version-flag.md` written into the run dir and nothing into the repo,
  then the four-choice menu rendered in the runner pane.
- **Chaining** from that menu: `Implement now` created the child run, forwarded `plan`
  with source "chained from …", opened the child's runner tab in the same workspace and
  reached its build step. (That child was v1-shaped and was stopped; 08's own live run
  below replaces it.)
- **`architecture` attended end to end** (`architecture-run-20260827-124125`): report
  written to `plan/ARCHITECTURE.md` in the run dir, one `weak` deferred candidate in the
  Output, the two-choice menu, and `Stop here` finishing the run with the deferred list
  printed in the summary.
- **A startup block recovered** (`review-worktree-20260828-061002`): `review` in a repo
  claude had never been trusted with waited for the dialog to be answered and then
  finished `done`. See fact 1 below.
- **A user-only skill invoked** by the engine: a `plan` run's grill step arrived in the
  pane as `/grill-with-docs Your task for this step is in …`, and the skill ran. See
  fact 2 below.
- **`implement` v2 end to end in the sandbox repo**
  (`implement-…-20260827-125306`), the whole loop with real agents:
  - `plan-dir` inferred the plan run above ("plan run plan-…-121724"), nothing asked.
  - `build` branched `version-flag` off `master` and committed per ticket — seven commits,
    no commit step, and the CLI actually works (`node cli.js --version` → `0.2.0`, its
    tests pass).
  - `architecture` ran the unattended body: report written to `plan/ARCHITECTURE.md`,
    `applied: []`, three `deferred` candidates, no questions asked, nothing outside the
    diff touched. `/improve-codebase-architecture` is not installed in that harness, so
    the architect used its Fallback paragraph and said so in the report.
  - `simplify` → `review` (claude-opus and claude-sonnet, a tab each, restarted every
    round) → `fix`, then **back to `simplify`, not to `review`** — five iterations, with
    `architecture` never re-run. The loop order is verified live, not only against the
    fake.
  - It ended `blocked` at `max_iterations 5` with one finding still open and five
    disputed findings in the summary, exactly as designed. The open finding is real: the
    reviewers found that the spec's own wording (`argv.includes("--version")`) collides
    with the spec's own out-of-scope line, and the implementer refused to override the
    plan on its own judgment — which is the `disputed` contract working.

Verified by tests only (fake herdr):

- The choice machinery's edges: `max:` exhausting a choice, a clean round skipping the
  follow-up, Esc blocking the step, a round whose Output never appears re-offering the
  menu, and the validation messages.
- `plan`'s second-opinion cap of 2 and the Linear team round-trip through `config.json`
  (the live plan run took `Implement now`, not those choices).
- `ticket`'s embedding: rebased ids and back-references. No live Linear fetch — the MCP
  is not configured in this session.
- The fix loop hitting `max_iterations` and blocking with findings still open.
- Resume: skipping finished steps, never reattaching to a dead agent, and the `agent:`
  group sharing one new agent.
- `diff-target` inference for the merge-request case (fake `glab`), and the Output
  schema's rejections.

## herdr and harness facts this round turned up, and what was done about them

1. **`agent start` fails in a directory claude has not been trusted with**:
   `agent_not_ready … blocked during startup`, because claude is sitting on its
   "Is this a project you trust?" dialog.
   **Avoided, and survivable when it happens.** The run now asks *before* it opens a
   tab — "claude has not worked in <cwd> before: trust it now, or let claude ask me in
   its tab" — and on yes records the answer where claude keeps it, once per directory.
   `trust` in `config.json` (`ask` | `auto` | `never`) answers it in advance. If claude does end up
   asking, that is no longer a failure either: `agent get` shows the agent exists and is
   `blocked`, and it goes `idle` under the same name the moment a person answers, so the
   runner names the pane, toasts, and waits within the handoff budget. It does *not*
   answer the dialog itself: the options are shuffled between runs — the second probe put
   "No, exit" first, and a blind Enter quit claude — so there is no safe key to send.
   Verified live both ways: a fresh untrusted repo printed "⏸ … is waiting for you in its
   pane" then "▸ … is ready" after the dialog was answered; and a second fresh repo was
   trusted from the runner's own menu, after which both reviewers started with no dialog
   at all and the run finished `done`.
2. **A skill marked `disable-model-invocation` cannot be run by an agent.** This is not
   one skill but most of them: `grill-with-docs`, `to-spec`, `to-tickets`, `wayfinder`,
   `implement` and `improve-codebase-architecture` all refuse, with "Ask the user to run
   it themselves — do not replicate this skill's workflow by other means". Six of the ten
   the design names.
   **Worked around.** A step names the skill it drives (`skill: to-spec`) and the engine
   sends the prompt as `/to-spec Your task for this step is in <path> …`. `agent prompt`
   is the human's channel, so the skill runs as if it had been typed. Verified live: the
   planner's pane shows `❯ /grill-with-docs Your task for this step is in …`, the skill
   loading, and the interview starting. `/wayfinder` is the one that cannot be handled
   this way — it is a mid-step *switch*, not the step's own skill — so the grill prompt
   now tells the planner to stop and ask the human to run it, and to say so in its Output.
3. **An interviewing agent may block on an interactive dialog** (claude's multi-question
   form), which `agent prompt` cannot answer — keys have to go to the pane. That is the
   human's job anyway; the engine's job is to keep waiting for the Output, which it does.

## The two follow-ups

**Disputed findings converge (`4c5879f`).** A finding the implementer rejected with a
reason cannot be settled by another round of the same two agents — only by the human — so
it no longer drives the loop. The reviewers are shown the standing disputes and their
reasons (`{{disputed}}` in the review prompt), a disputed finding raised again does not
gate, and the run finishes with it in the summary for mk. A reviewer who *can* answer the
reason raises it with a `"rebuttal"`, which clears the dispute and puts the finding back in
front of the implementer, so a real objection still gets its round. Findings now match on
file and title rather than file, line and title: the line moves while the branch is being
fixed, and a dispute has to survive that to ever settle. In the live run that stood behind
this, the loop would have finished at iteration 2 instead of burning to 5.

**The two harness facts are handled (`6686f76`).** See the section above — a startup block
now waits for the human instead of failing the run, and a step can drive a user-only skill.

**Directories are trusted before the harness asks (`e303ecc`, `716bd0a`).** There is no `claude trust`
command, so this writes the key claude's own dialog writes —
`projects[<dir>].hasTrustDialogAccepted` in `~/.claude.json` — and that file is 219 KB of
claude's state, not ours. So: nothing is written without a yes in the runner's menu or an
explicit `"trust": "auto"`; the previous file is copied to `claude.json.bak` in the plugin
state dir first; the merge keeps every other project and top-level setting exactly as it
was; the new file is renamed into place rather than written over; and the result is read
back before it counts as done. A missing or unreadable config is left alone and reported.
Checked on the real file: 72 top-level keys and 69 existing project entries came through
byte-identical, with two entries added.

## Left open

- **The sandbox runs are still in the plugin state dir** — `plan-…-121724`,
  `architecture-run-…`, `review-worktree-…-120549`, `review-worktree-…-061002` and the
  `implement-…-125306` that blocked at max_iterations, which is the one `resume` lists.
  They are the evidence for the sections above and can be deleted whenever you like; the
  sandbox repos they point at were throwaways outside any real checkout.
- **No remote, no tag, no release** — unchanged from v1. `.gitlab-ci.yml` is still unrun.
- **Linear is unverified end to end.** `Offload to Linear` asks for the team, keeps it in
  `config.json` and hands the id to the planner in its prompt, but no live run has
  created an issue: the Linear MCP is not configured for the harnesses here. Same for
  `ticket`'s issue fetch.
- **`codex` and `opencode` remain unverified**, as in v1. The baseline is claude-only.
  That includes trust: only the claude adapter knows where its harness records the answer,
  so the other two would still stop on whatever they ask on a first run — and be waited
  for, which is the fallback that covers every harness.
- **The trust key is claude's internal shape, not a supported interface.** `claude project`
  offers only `purge`, and there is no flag for it, so a future release could rename or
  move `hasTrustDialogAccepted`. If it does, `state()` starts answering "untrusted"
  forever: the menu appears every run, and granting stops taking effect (it verifies, so
  it reports the failure rather than lying). Nothing breaks — it degrades to the waiting
  behaviour — but that is the thing to check first if the menu will not stay away.
- **A read-modify-write of `~/.claude.json` can still lose a concurrent write.** The window
  is one file read and a rename, at most once per directory, and the backup makes it
  recoverable, but a claude session that saves in exactly that window would have its change
  overwritten. `"trust": "never"` avoids the write entirely.
- **A resumed Choice step forgets which choices were taken in the previous session's
  process, but not the record**: the count behind `max:` comes from `run.json`, so a
  resumed run still honours it. Nothing verifies that live.
- **Findings are still unioned, never reconciled between reviewers** — two reviewers who
  disagree with *each other* both reach the implementer (v1 by design). What is now
  reconciled is the implementer's side of the argument; see below.
