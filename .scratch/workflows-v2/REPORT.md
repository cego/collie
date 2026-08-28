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


# Tickets 09–12 — a second round

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


## 12 — one tab per step, variants side by side, a thin status strip

The run's topology stops being one tab per pane. The runner's own pane is split down at
0.85 and swapped underneath the first step's agent, so it becomes a full-width `status`
strip along the bottom of the run's first tab and never sits beside an agent. A step's
parallel variants are equal side-by-side splits inside that step's own tab — two reviewers
are one tab of two panes instead of two tabs — and a step that continues an earlier agent
opens nothing at all: it renames the pane it inherited, so one pane reads `build`, then
`architecture`, then `simplify`, then `fix`. A full `implement` run is therefore two tabs,
not six.

Labels stop leaking internals. A tab is `<glyph> <workflow> · <target>`: `!123` for an MR,
the branch by name, `worktree`, or the run's slug where the workflow has no target of its
own — never a sha, never a run id, never a harness or model. `⚙` working, `⚠` your turn,
`✓` done (only once every pane in the tab is), `✗` stopped. Panes carry the model where
variants differ and the step id where one runs alone. Agent names are still built by
`naming.ts` to stay herdr-legal and unique, and are now never what a label shows.

Two things fell out of the work rather than the ticket. **herdr's `--ratio` sizes the
first pane's slot**, and the original pane keeps the top slot, so the obvious
`--direction down --ratio 0.15` puts the strip on top; `pane swap` moves occupants and not
slot sizes, so the strip is made by splitting at 0.85 and swapping. That was probed live
against a scratch tab before any of it was written. And **a target only names the run
where the workflow owns that input** — `implement` inherits `target` from the `review` it
embeds, so it would otherwise have been `implement · worktree` rather than what it is
building. Ticket 10's `embeddedInputs` already knew the difference.

**Verified live**, in a throwaway worktree on `smoke-layout-12` with one commit to review,
running two real claude reviewers:

- One tab, `⚙ review · smoke-layout-12`, holding all three panes.
- `opus` at x=36 and `sonnet` at x=198, 162 and 161 columns wide — an even half each.
- `status` full width at y=76, 13 rows out of 88, along the bottom.
- The splits herdr recorded for that tab: `down 0.85`, then `right 0.5`.
- Two older runs still open in other workspaces showed the previous shape beside it —
  `⚙ review-2367` plus a second tab `✓ review-2367/review/claude-sonnet` — which is the
  before-and-after in one screen.

The run was stopped by closing its tab once the layout was confirmed; the worktree and
branch are gone. The zoom path is verified by transcript rather than by eye: a Choice
menu zooms the strip on and off in pairs, which the choice test asserts.

## Where these four left things

`bun test` is green at 166 tests across 20 files, `bunx tsc --noEmit` is clean, and the
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
- **Every tab of a run shares a name.** With `agent:` reuse that means two tabs for
  `implement` and one for `review`, so it has not bitten — but a workflow with several
  independent multi-variant steps would show identically named tabs telling apart only by
  glyph. The step is on the panes if that ever matters.
- **The layout was verified on one terminal size.** 88 rows made the strip 13; on a short
  terminal 15% may round to something unusably thin, and nothing enforces a floor.

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


# Ticket 13 — one review comes out of the reviewers, and you decide where it goes

`review` stops handing you two reviews and a union. Its parallel variants are followed by
a `synthesize` step that reads both `review.json` files and the diff and writes the one
review this change gets: findings deduplicated across models, disagreements settled
against the diff, and anything only one reviewer raised that the synthesiser cannot defend
from the diff itself listed under `dropped` with a one-line reason. The engine renders that
to `{{run.dir}}/review.md` — the summary, then the findings under their severity, nothing
about the process or the models — prints it in the status strip, and for a standalone
review pointed at a merge request offers **Post to MR** / **Don't post**. Posting is one
`glab mr note` with that file verbatim. `implement`'s fix step now consumes the synthesis
instead of the union, and the `post` flag input is gone.

## The mechanism is `fan_in:`, not a special step

A step declares `fan_in: <earlier step>` and gets two things from that one field, because
they are the same relationship: that step's Output files as `{{fan_in}}`, and a pane in
that step's tab. Its own Output is then held to the Synthesis schema — a review plus a
required `summary` and a `dropped` list where every entry needs a `reason` — and the engine
renders `review.md` from it. `Fan-in` was already the word for this in `CONTEXT.md`; what
changed is that the engine no longer does it. `unionFindings` is gone rather than kept as a
fallback, so a gate reads exactly the findings of the step it points at.

**The engine renders `review.md`, the agent does not.** The ticket asks for a fixed shape —
summary, verdict, findings by severity, no preamble, under ~25 lines — and asking an agent
to hold a format across every run is the least reliable way to get one. It matters more
than usual here: "post review.md verbatim" is only a promise worth making if the file is
deterministic. So the synthesiser writes the prose (`summary`, `title`, `detail`) and
`renderReview()` decides the shape, which also makes the whole rendering testable with no
agent in the loop. The verdict is rendered as words: a clean synthesis says `Nothing to
fix.` under its summary, and one with findings says nothing at all beyond the severity
groups, because "Verdict: findings" above a list of findings is the report line the ticket
asks not to write.

**Posting is the engine's job.** `post: true` is a fourth Choice form beside `run`,
`prompt` and `stop`: the engine reads the file and runs
`glab mr note <iid> --message <the file>`. A note that will not send prints its exit code
and re-offers the menu, the way a `prompt` round that never finishes already does.

**"Standalone MR targets only" needed no new idea.** The choice step is `standalone: true`,
so embedding `review` in `implement` drops it, and `requires:` — which now takes a list —
carries `[mr-target, gitlab]`. `mr-target` reads the `target_kind` ticket 10 already
records, and is listed first so a branch target is told what it actually is instead of
"glab is not installed".

**One embedding rule changed.** `review` has more than one step now, so `use: review` would
have renamed the reviewers to `review.review`. A child whose id equals the embedding step's
id *is* that step, so only its siblings take the prefix: `implement`'s steps are `review`
and `review.synthesize`, and every existing run dir, prompt path and test keeps its name.

**A fan-in pane splits down, not right.** Three columns in half a terminal are three
unreadable columns. The reviewers have finished by the time the synthesiser starts, so it
takes half of the last reviewer's pane and the synthesis sits under the review it came
from.

## Verified live

In a throwaway git worktree off this repo (branch `smoke-synth-13`, one commit adding a
13-line `smoke.js` with a deliberately wrong `--version`), run through the real picker with
two real claude reviewers and a real synthesiser:

- The confirm line is `review: target=branch:master...smoke-synth-13 [smoke-synth-13 vs
  master]` — no `post=false` any more, because the input is gone.
- One tab, `⚙ review · smoke-synth-13`, holding four panes. `opus` kept the full 73-row
  column; `sonnet` and `synthesize` split the other one at 36 and 35 rows, and `status` is
  the 11-row strip along the bottom. The synthesiser opened where the ticket asks for it,
  in the reviewers' tab and under the review it came from, with no tab of its own.
- Its prompt carried both reviewers' Output paths under `{{fan_in}}`, and the shared
  preamble with no "Post to GitLab" paragraph in it.
- `review.md` came out at **11 lines**: the summary, `**Blocker**`, `**Major**`, one bullet
  each with `` `smoke.js:5` `` and the detail on a continuation line — and the runner
  printed the whole thing in the strip.
- `post` was skipped with `skipped: branch:master...smoke-synth-13 is not a merge request`,
  and the run finished `done`. That is the `mr-target` requirement doing its job, and it is
  why the reason is worded after the target rather than after glab.

Two things happened on the way that are worth writing down.

**The Synthesis schema caught a real malformed Output on its first live run.** The first
synthesiser wrote `synthesized.json` with a missing comma between two findings, and the run
blocked with `steps/synthesize/synthesized.json: not valid JSON (JSON Parse error: Expected
']')` rather than carrying on with a half-read review. Its content was otherwise exactly
what was asked for: five findings merged from the two reviewers, one or two sentences each
with `file:line`, and no mention of a model anywhere.

**`dropped` is asked for, not enforced.** The second synthesiser carried two of the
reviewers' findings and dropped the rest without listing any of them, with `"dropped": []`.
The schema can only insist that anything *in* `dropped` has a reason; it cannot insist a
finding ends up there, because a synthesis rewords and merges titles by design, so no
mechanical key match between the raw reviews and the synthesis would hold. Making the engine
diff them would produce a false positive on nearly every run. So this stays a prompt rule,
and the honest statement is: `dropped` is where a synthesiser says what it let go, and
nothing checks that it said so.

**Resume cannot restart a step whose agent is still alive.** Resuming the blocked run while
its old tab was still open failed with herdr's `agent_name_taken` — the previous
synthesiser was idle, not gone, and `naming.ts` builds the same name from the same run and
step. Closing the tab first made the resume work. This is not new to this ticket (resume has
always assumed the previous session's agents are gone), but it is the first time a run has
been resumed from inside the session that started it.

The MR path is verified by tests with a fake `glab` only — this repo still has no remote, so
there is no merge request to post to. Those tests assert the menu is offered for an `mr`
target, that **Post to MR** produces exactly one `glab mr note <iid> --message <review.md>`
whose message is the file byte for byte, that **Don't post** runs no glab at all, and that a
note glab refuses re-offers the menu instead of ending the step.

## Where this leaves the tree

`bun test` is green at 176 tests across 20 files, `bunx tsc --noEmit` is clean, and the
runner still compiles. The baseline is four workflows and four personas; `review` is now
three steps rather than one.

Open, and worth knowing:

- **No review has ever been posted to a real merge request.** `glab mr note` has only ever
  been called against a fake.
- **`dropped` is unverified in the wild**, per the note above: the one live synthesis that
  had things to drop dropped them silently.
- **`implement`'s fix step now names a step inside the workflow it embeds**
  (`repeat: {from: review.synthesize}`). Forking `review` and renaming that step breaks
  `implement` — loudly, at validation, before a tab opens, but it is a coupling that did not
  exist before.
- **The review is rendered from the JSON, so a synthesiser that writes a thin `detail`
  writes a thin review.** The shape is guaranteed; the substance is still the agent's.


# Ticket 14 — implement runs on the harness's own model, at medium

`model: default` means "pass no model flag". Every harness accepts it, `startArgs` drops
the model args for it, and a pane for such a variant is named after the harness rather than
a model. Baseline `implement` takes it at `effort: medium`, so the implementer is whatever
claude starts on by itself and this plugin stops having a model name to keep in step with
the harness. A user can set `"model": "default"` in `config.json` and get the same for
everything that names no model of its own.

**Only two steps in `implement` say it.** `build` names it for the implementer agent, and
`architecture`, `simplify`, `fix` and `mr` reuse that agent, so they run on it whatever
their own definition says. The `review` embedding step names it a second time for
`synthesize`: the two reviewer variants name their own model and effort and win, while
`synthesize` names none and takes the embedding step's. That is the whole of the
"reviewers unchanged, synthesiser follows the implementer" rule, and it needed no new
mechanism.

**One thing this turned up.** A step that keeps an earlier agent was recording its own
step's variant rather than the agent's — harmless while every step resolved to the same
user default, and plainly wrong the moment `build` names something the others do not. The
record now carries the borrowed agent's harness, model and effort. Nothing renders it (a
lone variant's pane is named after its step), but `run.json` is the audit trail.

**Verified live**, because the one risk here is not something a transcript can settle:
starting claude with no model flag at all. `herdr agent start … -- --effort medium
--append-system-prompt-file …` reported
`argv: ["claude", "--effort", "medium", "--append-system-prompt-file", …]`, the agent came
up `idle` and `interactive_ready`, and its status line read `[Fable 5]` — claude's own
default, not one this plugin named. The rest is transcript: an `implement` run starts its
implementer and its synthesiser with `--effort medium` and no `--model`, and its two
reviewers with `--model opus`/`--model sonnet` at `xhigh`, exactly as before.

`bun test` and `bunx tsc --noEmit` are green, and `codex` and `opencode` remain unverified
as ever — `model: default` is accepted for them and drops their model flag, but no run has
ever started one.


# Ticket 16 — one `workflows` tab per workspace, and no more per-run status strip

Every run used to fold the runner's own pane into a thin `status` strip along the bottom of
its first step's tab. That is gone. Instead each workspace has one tab labelled
`workflows` — always its **first** tab — holding a board over this Session's runs and
agents, and each run's own pane moves in underneath that board. Run tabs now hold agents
and nothing else.

## What is on the board

`workspace.ts` builds a view and renders it; `flows.ts` runs the loop. Three plain lists
and a key line, no boxes:

- **Agents** — the long-lived agents this Session still has, by the Persona they run
  (`implementer`, `planner`), with their state as herdr reports it and a number that
  focuses that agent's pane.
- **Runs** — what is going on now, with the step and iteration each run is at, or
  `<step> — your turn` when a run is waiting for the human.
- **Finished** — the five newest finished runs of this workspace and repo, with their
  outcome and any findings still open.
- **Keys** — `1`–`9` focus an agent, `p`/`u`/`f` open the picker in pick/resume/fork mode,
  `s` hands the newest review to a live implementer, `q` closes the tab.

The board drives nothing. It re-reads the run dirs and the register every 1.5s, asks herdr
what is still alive, and redraws only when the rendering changed. Closing it — or the whole
tab — costs nothing, and the next run opens it again in first position. That was verified
by doing exactly that: `q` closed the board, its tab went with it, and the next run created
a new tab at index 0.

## Where a run's questions appear

The runner's own pane is `pane move`d into the `workflows` tab, under the board at 40/60,
and renamed after the run (`review-smoke-tab-16`). Every Choice menu, and the trust
question, renders there — zoomed over the whole tab while it is open, as before — and
before it asks, the runner sets `awaiting` on the run, toasts, and `tab focus`es the board.
So a menu cannot be left unseen in a tab nobody is looking at, and the board itself shows
`⚠ … — your turn` for the same run.

**`tab move` exists only on the socket.** herdr 0.8.2's CLI has `tab list/create/get/focus/
rename/close` and no `move`; the socket API has `tab.move {tab_id, insert_index}`. It is
now the third method this plugin reaches over the socket, beside `agent.view.set/clear`,
and it is called with `insert_index: 0` on every run start rather than only on create —
"already first" is not worth a round trip to find out.

**The register ships here too.** The board cannot list live agents without something to
read, so `registry.ts` and the engine's side of it are in this ticket: one file per
workspace + repo under the state dir, and the head of an `agent:` group — the step that
later steps continue — is registered under its Persona's name with its pane id. A lookup
checks the agent name *and* the pane, because herdr's ids compact when panes close, and
drops what does not match. Ticket 15 is what reads it.

## Verified live

In a throwaway worktree of this repo (`smoke-tab-16`, one commit adding a 13-line
`smoke.js`), in its own workspace, with the real picker and two real claude reviewers:

- `tab list` showed `workflows` at **index 0** and the workspace's own tab after it, with
  the board pane (`workflows`) and the run's pane (`review-smoke-tab-16`) in it.
- The run's tab, `⚙ review · smoke-tab-16`, held `opus` and `sonnet` and nothing else — no
  `status` pane anywhere in the session.
- The board rendered the run live: `⚙ review · smoke-tab-16   review · iteration 1/5`,
  then moved it to **Finished** with its outcome when it ended. `Agents` read
  `(none live here)`, which is correct — `review` has no `agent:` group, so it registers
  nobody. Ticket 15's smoke is where an implementer shows up.
- The trust question for the fresh worktree appeared **in the run's pane in the board's
  tab**, and answering it there let the run carry on.

Two things the smoke turned up, both recorded rather than papered over:

**Rebuilding the binary under a running run kills it.** `bun build --compile` writes
`bin/herdr-workflows` in place, and a runner executing that file dies when it is replaced.
The first smoke run lost its pane that way, mid-review. Obvious in hindsight, easy to do by
accident, and worth knowing before blaming the engine: build between runs, not during one.

**`agent start` can lose a race with the pane it was just given.** That first run also
recorded `synthesize failed — agent_pane_busy: agent target pane w13:p7 is not an available
shell`: the fan-in pane had been split and `cd`-ed but its shell was not ready yet. The
path is unchanged by this ticket (ticket 13 verified it live), the second run went through
it cleanly, and nothing waits for a new pane's shell today — see "Open" below.

## Where this leaves the tree

`bun test` is green at 187 tests across 21 files (a new `test/workspace-tab.test.ts` with
9), `bunx tsc --noEmit` is clean, and the runner compiles. The transcript tests changed
shape rather than count: a run's first step now opens a tab like every other step, so
`review` is one `tab create` where it was none and `implement` is two where it was one, and
`pane swap` is gone from every transcript.

`run.json` gained five fields — `workspace`, `target_label`, `awaiting`, `synthesis`,
`handoffs` — so the board reads facts instead of inferring them. `RunStore.load` defaults
each, so runs recorded by an older version still list.

Open, and worth knowing:

- **Nothing waits for a freshly split pane's shell.** See `agent_pane_busy` above. A
  `pane wait-output` for the prompt, or one retry, would close it; neither is in.
- **One `workflows` tab per workspace, and it is bound to one repo.** The board is opened
  with the first run's cwd and shows that repo. A workspace holding two checkouts would get
  one board naming the first of them, while the register keeps them properly apart.
- **A killed runner leaves its run `running` on the board.** Nothing marks a run whose
  process died, so it sits under Runs until it is resumed. Pre-existing; newly visible,
  because the board is where you now look.
- **The board re-reads every run dir in the state dir on each refresh.** Fine at a few
  dozen runs, and it filters by Session afterwards; it is not a paged list.
- **Quick actions open the picker in the board's pane, not as a popup.** A popup lands on
  whatever pane herdr has focused, which is rarely the workspace the board is for — the
  first live attempt opened a picker in *this* session's workspace, against the wrong repo.
  Splitting the board's own pane fixes it and makes the mode and cwd the board's. Only the
  action-invoking version was seen live; the split version is verified by transcript and
  compiles, but no live board has run it yet.
- **The smoke needed a fork of `review` without `requires: [mr-target, gitlab]`**, because
  this repo has no remote and a branch target skips that step — so the menu would never have
  appeared. The fork went into the user layer, which is also where mk's session keeps a
  full-copy `review.md`; the two overwrote each other for a few minutes and mk's version is
  what is there now. Worth knowing before running a smoke that writes into that layer.
- **The baseline's opus reviewer moved to `effort: medium`** (`acfd896`, another session)
  while this ticket was in flight. Four assertions naming the baseline's own variants were
  following the old `xhigh` and were updated here; nothing in this ticket depends on it.


## Ticket 16, second pass — the board was showing the wrong thing

Three faults, all found by mk looking at a real workspace (`wX`, label `mr-2367`) rather
than at a test.

**The Agents list was a register dump, not the agents.** Only the head of an `agent:`
group is ever registered, so a `review` run — which has no group at all — put nobody on
the board: the tab read `(none live here)` while herdr had two live reviewers in that
workspace, and the `1`–`9` keys had nothing to act on. The board now takes its agents from
the **run records** — every variant of every step of every run in this Session — and keeps
the ones herdr still has. The register is only how an agent gets *called*: an agent with a
role shows its role and sorts first, because those are the ones a hand-off can name;
everything else shows its step and model (`Review · Opus`, `Review · gpt-5.6-sol`,
`Synthesize`). Roles label agents; they never decide which appear.

**Runs that nobody was running still read as running.** Three `Review · worktree … iteration
1/5` entries sat under Runs from runners that had long since died. Nothing marks such a run
— the process that would have is the one that died — so the board now decides for itself:
a run still marked `running`, with no agent of its own left alive and nothing written to
`run.json` for a minute, is **abandoned** and shows under Finished as `⚠ abandoned`. The
minute of quiet is what keeps a run that has just been created out of it, and a run whose
agents are alive stays active however long it has been thinking.

**The key line offered keys that did nothing.** `1-9 focus that agent` is printed only when
there is an agent to focus.

### And the scoping the board judges "this Session" by

mk's amendment: the board is scoped to its own workspace within the current herdr session,
keyed by (session, workspace, cwd), re-validated live because ids compact. That is now:

- **Session** is the herdr socket path (`HERDR_SOCKET_PATH`). herdr 0.8.2 exposes no session
  id — `api snapshot` has none and `session list` names sessions by their socket — so the
  socket is the identity available, and it is exactly as stable as the session.
- **Workspace** is the id *and* the label the run was created under. Ids compact; a label
  that no longer matches the live workspace means a different workspace is wearing the id,
  and the run is not this one's.
- A run recorded against **another** workspace never appears, even for the same repo.
- A run recorded **before** workspaces were noted (`workspace: null`) appears only if one of
  its agents is alive in this workspace, which is the only proof available for it. That is
  what removed the three stale rows in `wX`: nothing alive, no recorded workspace, so not
  this board's business.
- Agents are filtered by the workspace **herdr** reports for them, never by what a run
  record claims.

`run.json` gained `session` and `workspace_label`; the register's file name is now hashed
from session + workspace + cwd, and an entry records the workspace it was started in.

**Verified live in `wX`, on the workspace that produced the report.** With the board
restarted on the new binary: Agents listed `1 Review · Opus idle`, `2 Review · gpt-5.6-sol
idle`, `3 Synthesize idle`, all three from one run's record and none of them registered;
Runs read `(none running)`; Finished read `✓ Review · !2367 done`; and the three stale rows
were gone. Pressing `3` moved the focus to the synthesiser's pane and printed `focused
Synthesize (review-2367-synthesize-r23)`; pressing `2` moved it to the pi reviewer's. The
focus keys work.

**Two other things fixed on the way.**

*A stray NUL byte in `src/registry.ts`* — written by a heredoc that mangled
`${a} ${b}` when the file was first created — made git treat the file as binary (the commit
that added it reads `Bin 0 -> 3154 bytes`). Harmless to behaviour, since it sat inside a
hash input, and gone now.

*The build no longer kills a running run.* `bun build --compile --outfile bin/herdr-workflows`
writes the file in place, and a runner executing it dies when it is replaced — which is how
the first live smoke lost its run. `bun run build` and `install.sh` now compile to
`bin/herdr-workflows.new` and `mv` it over, so a running process keeps the inode it started
with. That is what made it safe to rebuild while mk's own review run was live in `wX`.


# Ticket 18 — plain names

Every label is now the word a human would say, Capitalized.

**Tabs.** `<glyph> <name>`: the workflow for a run's own first tab, the step for every tab
after it. A full `implement` run is `⚙ Implement` and `⚙ Review`; a standalone review is
`⚙ Review`. No target, no slug, no run id, no harness, no model. The target comes back only
to break a collision: before creating a tab the runner asks `tab list` whether the plain
name is already on a tab in this workspace, and if it is, the new one takes ` · <target>`.
Each tab remembers the name it was given, so the glyph moves without the name changing.

**Panes.** A pane alone in its tab has no label at all — the tab already said it, which is
why a full `implement` run's implementer pane is now unlabelled through `build`,
`architecture`, `simplify`, `fix` and `mr` instead of being renamed four times. Parallel
variants take the model with the provider stripped (`Opus`, `Sonnet`, `gpt-5.6-sol`), or the
harness where the model is `default`. A pane that shares a tab with the panes it came from
takes its step (`Synthesize` — and the `use:` prefix on an embedded step's id is bookkeeping,
so `review.synthesize` still reads `Synthesize`). A run's own pane on the Control Plane
takes the workflow, never the run: slugs and agent names stay internal.

**Capitalization is a display rule and nothing else.** `displayName` capitalizes a token
that is a word (letters and hyphens) and leaves anything else alone, so `implement` reads
`Implement`, `gpt-5.6-sol` stays `gpt-5.6-sol`, and a collision target keeps whatever it
actually is — a branch prettied up is no longer that branch's name. Workflow ids, file names,
step ids, run slugs and agent names are untouched.

**A finished tab still counts as a collision.** The check is "is that name on a tab in this
workspace", not "is another run live": a finished run's tab is still open and still in the
way, so the second run of the same workflow is disambiguated even when the first has ended.

Also gone: the runner no longer renames the tab it was opened in. That tab exists for the
seconds before the pane moves onto the Control Plane, and naming it put a run's name on a
tab nobody ever sees.
