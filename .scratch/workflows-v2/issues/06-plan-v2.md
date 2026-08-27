# 06: plan and ticket workflows v2

**What to build:** plan: single agent across grill → spec → tickets writing into {{run.dir}}/plan, then the Choice menu Implement now / Second opinion (fresh opus reviewer of SPEC+tickets, plan-level findings only, max 2 rounds) / Offload to Linear (one issue, spec body, ticket checklist; team from config.json linear.team, asked once) / Refine (no cap). ticket: use plan with goal from a Linear issue.

**Blocked by:** 01, 02, 03, 05

**Status:** ready-for-agent

- [ ] plan validates; steps share agent grill
- [ ] second-opinion loop capped at 2 (tested)
- [ ] linear.team read from and written to config.json
- [ ] live: plan end to end reaching the menu; Implement now chains
