# 15: session awareness — runs in the same workspace and repo hand off to each other's live agents

**What to build:** A live-agent registry per workspace + repo under the plugin state dir: each run registers its long-lived agents by role (`planner`, `implementer`) with pane id and agent name; lookups verify the pane still exists and the agent is alive (ids compact, so both are checked) and drop stale entries silently. Scope is strictly same workspace AND same repo cwd — never across workspaces or checkouts.

Hand-offs:
1. **review → implementer.** After `synthesize`, when a live implementer exists, the end menu gains **Send to implementer** as the default: the implementer is prompted with the paths to review.md/synthesized.json and applies them as a fix round (same `disputed` rules); the review run records the hand-off. Post to MR / Don't post remain.
2. **plan → implementer.** The planner registers itself and keeps its tab after the run ends. Whenever the plan dir changes after an implementer for that plan is live (Refine, Second opinion, or the human talking to the planner), the planner's Output includes a short `changelog`, and the runner prompts the implementer: the plan changed, here is the diff of plan/, reconcile — finish, adjust, or flag conflicts in its Output. Planner persona states this contract.
1b. **review → new implementer (Fix findings).** When NO live implementer exists for this workspace, the review menu offers **Fix findings** instead of Send to implementer: it chains `run: implement` with the work-source kind `review` — `synthesized.json` + `review.md` are the spec, the tickets are the findings grouped by severity. The implementer works on the reviewed target: branch → check it out; MR → `glab mr checkout <iid> --repo …` (creating a local branch), so fixes land on the MR's own branch and its later MR step updates that MR instead of opening a new one; worktree → stay on the current branch. Only ever one implementer per workspace: if one is live, this option is not shown and Send to implementer is. The review run records the chained run id.

3. **implement → planner.** When the implementer needs a decision the plan does not cover and a live planner exists, its prompt names the planner's pane so it asks there instead of blocking on the human; falls back to blocking when no planner is live.

**Blocked by:** 14 (engine files), 16 (menus and registry render in the workspace tab)

**Status:** done

- [x] registry write/lookup/stale-drop tested with fake herdr (pane gone ⇒ entry dropped, option absent)
- [x] review transcript with NO live implementer: menu offers Fix findings (not Send); choosing it chains implement with work-source kind review; branch/MR/worktree checkout rules in the build prompt (tested)
- [x] review transcript with a live implementer: menu default is Send to implementer; prompt delivered; recorded on both runs
- [x] plan-change transcript: diff of plan/ delivered to the implementer once per change
- [x] cross-workspace and cross-repo runs never see each other's agents (tested)
- [x] README + docs/WORKFLOWS-DESIGN.md + CONTEXT.md (term: Session) updated; bun test + tsc green
- [ ] live smoke: implement (can be stopped after build) then review on the same repo → Send to implementer appears and the implementer receives the prompt

## Decisions where the design was silent

**Two new keys on a Choice, each doing one thing.** `handoff: <role>` is a fifth choice form
beside `run`, `prompt`, `post` and `stop`, and is offered only when that role is live;
`unless: <role>` is offered only when it is not. "Send to implementer or Fix findings, never
both" then falls out of the definition rather than being enforced in code, and `handoff` with
`unless` on the same choice is a validation error because it says the same thing twice.

**`requires:` moved onto the choice.** `review`'s end step used to be skipped whole when the
target was not a merge request, which would have taken Fix findings with it. The step now has
no requirements and `Post to MR` carries `[mr-target, gitlab]` itself.

**A menu reduced to endings is skipped; a menu written as endings is asked.** The rule fires
only when a non-`stop` choice was filtered out — "everything that could have done something
is unavailable". A workflow whose menu is deliberately two endings is still a question.

**The register ships in 16, the hand-offs here.** Registration, scoping and the stale-drop
were needed for the Control Plane to list agents at all, so they are in ticket 16 and its
follow-up; this ticket is what reads them. The scoping is a Session — herdr session,
workspace and repo cwd — re-validated against the live workspace, and an agent herdr places
in another workspace is never this Session's whatever a record claims.

**`Fix findings` forwards the target as well as the review.** The child `implement` run gets
`plan: {{run.dir}}` (the review run itself, classified as the new `review` work-source kind)
and `target: {{inputs.target}}`, and chaining now forwards a `diff-target`'s kind the same way
it already forwarded a work-source's — otherwise the child could not tell a branch from an MR
and would not know what to check out.

**The reviewed target decides where the fixes go**, in the build prompt: `git checkout` the
branch's head, `glab mr checkout <iid> --repo …` for a merge request — which creates the local
branch, so the later `mr` step updates that merge request instead of opening a second one —
and stay put for a working tree. The `mr` step is told to check for an existing MR on the
branch and comment on it rather than create another.

**A plan change is judged by the files, not by the agent's word.** The run dir's `plan/` is
copied before a Choice round and `git diff --no-index`ed after; a round that changed nothing
sends nothing, however enthusiastic its Output. The diff is written into the run dir so the
audit trail has it, and the planner's `changelog` is passed along as the human-readable half.

**It reaches only the implementer building from that plan.** The register gives a live
implementer; its run's `plan` input has to be this plan dir, or the hand-off is not this
plan's business.

**The planner route is one template variable.** `{{session.ask}}` renders either "the planner
is live as `<agent>` in pane `<pane>`, ask it like this" or "there is no planner, stop and ask
me", so the prompt body has no conditional in it. It is resolved only for a step whose body
actually mentions `{{session.`, so most steps cost no extra herdr call.
