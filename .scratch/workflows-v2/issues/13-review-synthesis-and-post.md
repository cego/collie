# 13: review synthesises N reviews into one short review and offers to post it to the MR

**What to build:** After `review`'s parallel variants finish, a `synthesize` step (fresh agent, reviewer persona, default harness/model) reads every variant's `review.json` and the diff and writes ONE cohesive review: findings deduplicated across models, disagreements resolved (a finding only one model raised survives only if the synthesiser can defend it from the diff itself; dropped ones are listed as `dropped` with a one-line reason), ordered blocker → major → minor, each finding one or two plain sentences with `file:line`, a two-sentence summary, and a verdict. Output `synthesized.json` (same schema as review.json plus `summary`, `dropped`) and `review.md` rendered for humans: summary, verdict, findings grouped by severity — short, simple, precise, no headings beyond severity, no preamble, nothing about the process or the models. Then, for a standalone review whose target is an MR, a Choice: **Post to MR** (one `glab mr note` with review.md verbatim) / **Don't post**. Non-MR targets and embedded reviews skip the choice; review.md is still written and printed in the status strip. `implement`'s fix step consumes `synthesized.json` instead of the raw union (drop unionFindings from the loop path; keep `disputed` semantics). Remove the `post` flag input.

**Keep it simple:** the posted note must read like a careful human review, not a report. Target under ~25 lines for a typical MR.

**Blocked by:** 12 (layout: synthesize gets its own pane in the review tab; the choice renders in the strip)

**Status:** ready-for-agent

- [ ] synthesize step runs after variants, reads all review.json, writes synthesized.json + review.md (fake-herdr transcript)
- [ ] dedupe/dropped logic tested through the Output schema (dropped requires a reason)
- [ ] Choice only for standalone MR targets; Post → exactly one glab mr note with review.md (fake glab); embedded → no choice
- [ ] implement fix prompt uses synthesized findings; loop gate unchanged (tested)
- [ ] `post` input gone, README/design doc updated, bun test + tsc green
- [ ] live smoke: review on this repo (branch target) → synthesize pane appears, review.md printed, no post choice; MR path verified via fake glab only (no remote)
