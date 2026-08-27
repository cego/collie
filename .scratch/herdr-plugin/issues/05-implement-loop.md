# 05: implement with parallel reviews and fix loop

**What to build:** Pick `implement`; plan inferred from tasks/; implementer tab builds; `review` embedded and fanned out to one tab per harness/model variant; findings unioned into a fix prompt to the same implementer (per-step fresh toggle honoured); loop until all verdicts clean or max_iterations (5); disputed findings surfaced at end; sidebar filtered to the run via agent.view.set.

**Blocked by:** 04

**Status:** done

- [x] loop terminates on clean and on max (tested via fake herdr)
- [x] fresh: true restarts the agent, default re-prompts
- [x] union + disputed list in final summary
- [x] per-variant tabs named <step>/<harness>-<model>

**Notes:** The loop is one frontmatter construct: a step declares
`repeat: {from: <earlier step>, max: <n>}`. After the `from` step completes, its
reviewers' verdicts are the gate — all clean skips the repeating step and moves on;
otherwise the repeating step runs and jumps back. `max` defaults to the workflow's
`max_iterations` (5).

Filled-in decision: hitting `max_iterations` with findings still open **blocks** the
run instead of continuing to `commit`. Committing work the reviewers still object to
would be worse than stopping, and the spec already wants a blocked Step to hand off
to the human. The open findings go in the summary under "Findings still open".

Tab and pane labels are `<run-slug>/<step>[/<harness>-<model>]`, so a per-variant tab
ends with `<step>/<harness>-<model>` (ticket wording) while still showing which Run it
belongs to (spec story 38). Agent names are separate and length-limited; see ticket 03.

`fresh: true` replaces the step's pane (split a sibling, close the old one) so
`agent start` sees a shell prompt again; without it the same agent is re-prompted.
`agent: <step>` borrows an earlier step's agent, which is how `fix` and `commit` keep
the implementer's context.

**Follow-up (mk, same session):** codex is not standard on the team, so the baseline's
two parallel reviewers are now `claude/opus` and `claude/sonnet`, both at `xhigh`
effort. That needed `effort` as a new step/variant key: `claude` declares
`--effort <low|medium|high|xhigh|max>` in the adapter table, harnesses without one
reject `effort` in validation instead of dropping it silently, and a variant's name
only takes in the effort when harness+model would otherwise collide. Verified live
that `agent start --kind claude -- --model opus --effort xhigh
--append-system-prompt-file <path>` boots as "Opus 5 with xhigh effort".
