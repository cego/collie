# 11: implement ends by opening a GitLab MR that follows the repo's CIATF template and links the Linear ticket(s)

**What to build:** After the fix loop is clean, `implement` runs a final `mr` step (same implementer agent) that pushes the branch and opens a merge request with `glab`. The description must follow the target repo's own MR template when one exists (`.gitlab/merge_request_templates/default.md`, the CIATF change-management assessment: Trello card/ticket, Description, Reason, Category feature|bugfix, then Confidentiality, Integrity, Availability, Traceability, Fairness — each assessed for negative impact, "no impact" stated explicitly where that is the honest answer). `glab mr create --assignee mk --description` does not pre-fill templates, so the agent fills it from the template file; with no template, a plain description. Linear ticket(s) are linked when any exist: the work-source when its kind is `linear`, an issue id in the branch name, and any ticket recorded by a `plan` run's Offload-to-Linear choice in the plan dir — the ticket line replaces the Trello line and each link appears in the description; the agent also posts the MR URL as a comment on the Linear issue via MCP. The MR is assigned to the current GitLab user (`glab api user`, overridable by `gitlab.assignee` in config.json), category derived from the plan (bugfix only when the spec says so). Never merge. The step's Output records `{mr_url, linear_issues[]}` and the summary prints them. `push` is the only remote side effect and happens only in this step.

**Keep the CIATF simple.** One or two plain sentences per section, no headings inside sections, no tables, no risk matrices. Most sections in most MRs are honestly "No impact." — write exactly that. Description and Reason are each a short paragraph. The whole description should read in under a minute; if the agent finds itself writing more, it is over-explaining.

**Blocked by:** 09 (work-source kinds), 10 (shared input code)

**Status:** ready-for-agent

- [ ] mr step present in implement after the loop; skipped with a clear note when `glab` is missing or the repo has no GitLab remote (tested)
- [ ] prompt tells the agent to read the repo's MR template file and fill every CIATF section briefly (1–2 sentences each, "No impact." where true); fallback for no template
- [ ] Linear ids collected from all three sources, deduplicated (tested)
- [ ] assignee resolved from config or glab api user (tested with fake glab)
- [ ] no commit text or description ever contains the company npm scope with an @
- [ ] README + docs/WORKFLOWS-DESIGN.md updated (v1's "no MR step" note removed); bun test + tsc green
- [ ] live smoke against a throwaway branch in this repo is NOT possible (no remote) — verify prompt rendering via the fake herdr transcript instead and say so in the report
