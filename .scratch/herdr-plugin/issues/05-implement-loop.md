# 05: implement with parallel reviews and fix loop

**What to build:** Pick `implement`; plan inferred from tasks/; implementer tab builds; `review` embedded and fanned out to one tab per harness/model variant; findings unioned into a fix prompt to the same implementer (per-step fresh toggle honoured); loop until all verdicts clean or max_iterations (5); disputed findings surfaced at end; sidebar filtered to the run via agent.view.set.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] loop terminates on clean and on max (tested via fake herdr)
- [ ] fresh: true restarts the agent, default re-prompts
- [ ] union + disputed list in final summary
- [ ] per-variant tabs named <step>/<harness>-<model>
