# 15: session awareness — runs in the same workspace and repo hand off to each other's live agents

**What to build:** A live-agent registry per workspace + repo under the plugin state dir: each run registers its long-lived agents by role (`planner`, `implementer`) with pane id and agent name; lookups verify the pane still exists and the agent is alive (ids compact, so both are checked) and drop stale entries silently. Scope is strictly same workspace AND same repo cwd — never across workspaces or checkouts.

Hand-offs:
1. **review → implementer.** After `synthesize`, when a live implementer exists, the end menu gains **Send to implementer** as the default: the implementer is prompted with the paths to review.md/synthesized.json and applies them as a fix round (same `disputed` rules); the review run records the hand-off. Post to MR / Don't post remain.
2. **plan → implementer.** The planner registers itself and keeps its tab after the run ends. Whenever the plan dir changes after an implementer for that plan is live (Refine, Second opinion, or the human talking to the planner), the planner's Output includes a short `changelog`, and the runner prompts the implementer: the plan changed, here is the diff of plan/, reconcile — finish, adjust, or flag conflicts in its Output. Planner persona states this contract.
3. **implement → planner.** When the implementer needs a decision the plan does not cover and a live planner exists, its prompt names the planner's pane so it asks there instead of blocking on the human; falls back to blocking when no planner is live.

**Blocked by:** 14 (engine files), 16 (menus and registry render in the workspace tab)

**Status:** ready-for-agent

- [ ] registry write/lookup/stale-drop tested with fake herdr (pane gone ⇒ entry dropped, option absent)
- [ ] review transcript with a live implementer: menu default is Send to implementer; prompt delivered; recorded on both runs
- [ ] plan-change transcript: diff of plan/ delivered to the implementer once per change
- [ ] cross-workspace and cross-repo runs never see each other's agents (tested)
- [ ] README + docs/WORKFLOWS-DESIGN.md + CONTEXT.md (term: Session) updated; bun test + tsc green
- [ ] live smoke: implement (can be stopped after build) then review on the same repo → Send to implementer appears and the implementer receives the prompt
