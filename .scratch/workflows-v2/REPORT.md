# workflows v2 — implementation report

All eight tickets are `done` and committed on `master` (local only, never pushed), plus
three follow-ups mk asked for afterwards (convergence, workarounds for the two harness
facts below, and pre-trusting). Everything up to that point is this section; tickets 09,
10 and 11 came after it, by another session, and are recorded in their own sections at the
end. Where they changed something described here, their sections say so.

At the time of writing, the repo is green: 159 tests across 19 files, `bunx tsc --noEmit`
clean, and the runner still compiles.

```
bd58133 Drop the trust subcommand
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

The baseline these eight tickets left was five workflows (`plan`, `ticket`, `implement`,
`review`, `architecture`) and four personas (`planner`, `implementer`, `reviewer`,
`architect`). `ticket` is since gone — ticket 09 replaced it and the `issue`
strategy with one `work-source` input — and `implement` has since grown a sixth step,
`mr`. `plan-dir` is still a strategy, just one no baseline workflow declares any more. Every decision taken where the design was silent is recorded in the ticket it
belongs to, under "Decisions where the design was silent".

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

**Directories are trusted before the harness asks (`e303ecc`).** There is no `claude trust`
command, so this writes the key claude's own dialog writes —
`projects[<dir>].hasTrustDialogAccepted` in `~/.claude.json` — and that file is 219 KB of
claude's state, not ours. So: nothing is written without a yes in the runner's menu or an
explicit `"trust": "auto"`; the previous file is copied to `claude.json.bak` in the plugin
state dir first; the merge keeps every other project and top-level setting exactly as it
was; the new file is renamed into place rather than written over; and the result is read
back before it counts as done. A missing or unreadable config is left alone and reported.
Checked on the real file: 72 top-level keys and 69 existing project entries came through
byte-identical, with two entries added.

There is no separate CLI for it: a directory only needs trusting where a workflow actually
runs, so the runner's own question covers it, and `"trust": "auto"` covers anyone who never
wants to be asked. The plugin surface stays the three actions and two panes.

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


# Tickets 09–11 — a second round

## 09 — implement takes a plan dir, a Linear ticket, or free text

`implement`'s `plan` input is a **work-source**. The runner gathers candidates — up to the
three newest finished plan runs for this repo, plus a Linear id found in the branch name.
One candidate is inferred silently; none or several open a menu that always ends in
"Type it…", where a Linear id, a Linear URL or a plain description is classified on the
way in (`plan-dir` | `linear` | `text`). The kind is recorded next to the value and reaches
prompts as `{{inputs.plan_kind}}`, which the `build` step branches on: read the SPEC and
tickets, fetch the issue over MCP, or take the human's words — the latter two writing
`{{run.dir}}/plan/` themselves before building. The `ticket` workflow and the `issue`
Input strategy are gone; `plan`'s optional `ticket` input stays.

**Verified live, in this herdr session**, against this repo — which has no plan run of its
own and sits on `master`, so it is exactly the zero-candidate case the ticket asks for.
The picker was opened as a split pane (`herdr plugin pane open … --entrypoint picker`) so
the TUI could be driven and read:

- The workflow list renders four entries, `ticket` no longer among them.
- Picking `implement` opens the work-source menu — header "What should be built?", the
  single entry "Type it…", because nothing here could be inferred.
- Typing `https://linear.app/cego/issue/FRO-149/prmpt-modal-skal-rettes` produced the
  confirm line `implement: plan=FRO-149 [linear · typed]  target=worktree [working tree]
  post=false [default]` — the URL classified to its id, and the kind shown in the line.
- Esc cancelled without creating a run. `herdr plugin log` shows the action itself exiting
  0 with `pick: opening the picker in …/herdr-plugin`.

**One real defect found and fixed while closing this out.** The test rig's `runWorkflow`
built a run's inputs by hand instead of going through `inputValues`/`inputSources` the way
`flows.ts` does, so `plan_kind` was never set in any engine test: every `implement` test
rendered `Work source ():` and told the implementer to match a kind of `` — while
production was fine. The suite could not have caught a regression there. The rig now goes
through the same funnel, and a test asserts the build prompt names its kind, keeps all
three branches, and leaves no unknown template keys in the run log. 141 pass, 0 fail;
`bunx tsc --noEmit` clean.


## 10 — review lets the human choose the target

`diff-target` stops being a silent guess. It gathers what this repo actually offers, in
the order plain inference used to pick them: this branch's own open MR; failing that, the
open MRs I am assigned or have authored (`glab mr list --assignee @me` and `--author @me`,
deduplicated by iid); the branch against its default base; and the working tree when it is
dirty. The picker shows all of them plus "Type it…", which takes an MR iid (`42` or `!42`),
an MR URL, a `base...head` range, or a bare ref meaning that ref against the base. Because
the head of the list is what inference alone would have chosen, Enter reproduces the old
behaviour exactly.

Kinds are `mr`, `branch`, `worktree`, and the value keeps its `mr:<iid>` /
`branch:<base>...<head>` / `worktree` shape, so no prompt body changed.

**The menu is 09's machinery generalised, not copied.** One `resolveFromMenu` over a
`MenuSpec` (header, hint, question, classifier), with `resolveWorkSource` and
`resolveTarget` as its two callers and `resolveCandidates` dispatching on the strategy.

**"An embedded step never asks" is now a property of the input.** A resolved workflow
carries `embeddedInputs` — the inputs that reached it only through `use:` — so `implement`
infers `review`'s target silently while standalone `review` shows the menu. That makes the
rule assertable without driving the picker, which is how it is tested.

**Verified live**, in a throwaway git worktree off this repo (branch `smoke-target-10`,
one untracked file, so both a branch and a dirty tree existed — the main checkout's HEAD
was never moved):

- The menu rendered `smoke-target-10  branch · smoke-target-10 vs master`, then
  `working tree  worktree · working tree`, then `Type it…  an MR iid or URL, or a
  base...head range`.
- Enter on the top entry produced
  `review: target=branch:master...smoke-target-10 [smoke-target-10 vs master]  post=false
  [default]` — the old value shape and the old source wording, from the new menu.
- Esc cancelled; the worktree and branch were removed.

`glab` has no remote to talk to here, so the MR candidates are covered by tests with a
fake `glab` rather than live — the same limitation v1 recorded. 150 pass, 0 fail;
`bunx tsc --noEmit` clean.


## 11 — implement ends by opening the merge request

A sixth step, `mr`, runs after the fix loop with the same implementer agent. It pushes the
branch and opens the MR with `glab`, and it never merges: `push` is the only remote side
effect in the whole run, and it happens only here.

The description follows the repo's own template when there is one, because `glab` does not
pre-fill templates — the agent reads
`.gitlab/merge_request_templates/default.md` and fills it in. The prompt asks for the CIATF
assessment mk's way: one or two ordinary sentences per section, `No impact.` written
exactly where that is the honest answer, no headings inside sections, no tables, no risk
matrices, and the whole thing readable in under a minute. The template's Trello line
becomes the Linear links. Category is `feature` unless the spec says a defect was fixed.

Linear ids are gathered from all three places they hide — a `linear` work source, the
branch name, and whatever a `plan` run's Offload-to-Linear choice recorded in its run —
deduplicated in that order. The assignee is `gitlab.assignee` from `config.json`, else
whoever `glab api user` reports. The step's Output carries `mr_url`, `linear_issues` and
the branch; the run records them and the summary prints them.

**`requires: gitlab` is the general mechanism behind it.** A step declares what the
environment has to provide, and an unmet requirement is a skip with a note — never a
failed run. The reason names the actual gap (`glab is not installed`, `this repo has no
remote`, `no GitLab remote`), because "skipped" on its own sends you looking in the wrong
place.

**Not verified live, and it cannot be here.** This repo has no remote at all — `git remote
-v` is empty, though glab 1.115.0 is installed — so there is nothing to open a merge
request against, on a throwaway branch or otherwise. What is verified instead, through the
fake herdr transcript, is the prompt the agent would receive: with a fake `glab`/`git`
standing in for a GitLab repo, `steps/mr/prompt-1.md` carries ``Assignee: `mk` ``,
``Linear tickets: `FRO-149` `` picked out of the branch name, the CIATF brief in mk's
words, "Never merge the MR", and the Trello-line instruction; with a template file present
it names that path, and with no ticket anywhere it renders the ticket line empty rather
than inventing one. The reported `mr_url` reaches the run record and the summary line. The
skip path is verified both ways — a GitHub remote gives "no GitLab remote", and the rig's
bare environment gives "glab is not installed", which is the note an `implement` run
leaves in this repo today.

The company package scope never appears with a leading at-sign in any commit message,
prompt or description. The one test that asserts its absence builds the string from parts,
so `git grep` for the literal is clean across the whole tree.

## Where these three left things

`bun test` is green at 159 tests across 19 files, `bunx tsc --noEmit` is clean, and the
runner still compiles. The baseline is four workflows (`plan`, `implement`, `review`,
`architecture`) and four personas; `ticket` is gone, folded into `implement`'s work source.

Open, and worth knowing:

- **The MR step has never opened a real merge request.** Everything about it is verified
  against a fake `glab`. The first real run will be the first time `glab mr create --assignee mk` is
  called for real, and the CIATF template it fills will be the target repo's, not this
  one's — this repo has no template either.
- **Linear is still unverified end to end**, unchanged from v2: no MCP is configured for
  these harnesses, so neither the offload, the issue fetch, nor the new "comment the MR
  URL back onto the issue" step has run against the real thing.
- **`codex` and `opencode` remain unverified.** The baseline is still claude-only.
- **The `mr` step assumes one branch, one MR.** A run that somehow ends on the default
  branch would try to open an MR from it; nothing checks that yet.

## A note on this round's history, for whoever reads the log

The commit subjects in this range do not describe their contents, and one of them swept up
another session's work:

| Commit | Subject says | Actually contains |
| --- | --- | --- |
| `5d55921` | Ticket 09 implementation | `GOAL-09.md` and the ticket 09 file, nothing else |
| `4e7d25d` | Ticket 10 | ticket **09**'s implementation, plus six files of unrelated review fixes from another session, plus the ticket 10 file |
| `4476c0b` | Ticket 11 | the ticket 11 file, plus this round's test-rig fix above |
| `a39ef57` | Ticket 11 CIATF | the ticket 11 file's amendment, nothing else |

The pattern is that each commit is named after the ticket file it *adds*, and a
`git add -A` alongside it takes whatever else happened to be uncommitted in the tree at
that moment. Nothing was lost — every swept file's content is in history and was verified
there by the session that wrote it — but `git log --oneline` reads as though 10 and 11
have shipped, and neither has been started. Staging by path avoids it.
