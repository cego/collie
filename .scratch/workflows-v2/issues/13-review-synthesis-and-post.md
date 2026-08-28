# 13: review synthesises N reviews into one short review and offers to post it to the MR

**What to build:** After `review`'s parallel variants finish, a `synthesize` step (fresh agent, reviewer persona, default harness/model) reads every variant's `review.json` and the diff and writes ONE cohesive review: findings deduplicated across models, disagreements resolved (a finding only one model raised survives only if the synthesiser can defend it from the diff itself; dropped ones are listed as `dropped` with a one-line reason), ordered blocker → major → minor, each finding one or two plain sentences with `file:line`, a two-sentence summary, and a verdict. Output `synthesized.json` (same schema as review.json plus `summary`, `dropped`) and `review.md` rendered for humans: summary, verdict, findings grouped by severity — short, simple, precise, no headings beyond severity, no preamble, nothing about the process or the models. Then, for a standalone review whose target is an MR, a Choice: **Post to MR** (one `glab mr note` with review.md verbatim) / **Don't post**. Non-MR targets and embedded reviews skip the choice; review.md is still written and printed in the status strip. `implement`'s fix step consumes `synthesized.json` instead of the raw union (drop unionFindings from the loop path; keep `disputed` semantics). Remove the `post` flag input.

**Keep it simple:** the posted note must read like a careful human review, not a report. Target under ~25 lines for a typical MR.

**Blocked by:** 12 (layout: synthesize gets its own pane in the review tab; the choice renders in the strip)

**Status:** done

- [x] synthesize step runs after variants, reads all review.json, writes synthesized.json + review.md (fake-herdr transcript)
- [x] dedupe/dropped logic tested through the Output schema (dropped requires a reason)
- [x] Choice only for standalone MR targets; Post → exactly one glab mr note with review.md (fake glab); embedded → no choice
- [x] implement fix prompt uses synthesized findings; loop gate unchanged (tested)
- [x] `post` input gone, README/design doc updated, bun test + tsc green
- [x] live smoke: review on this repo (branch target) → synthesize pane appears, review.md printed, no post choice; MR path verified via fake glab only (no remote)

## Decisions where the design was silent

**`fan_in:` is the mechanism, not "synthesize".** A step declares `fan_in: <earlier step>`
and gets two things from it: that step's Output files as `{{fan_in}}`, and a pane in that
step's tab. One field carries both because they are the same relationship — "this step
reconciles those Outputs" — and `Fan-in` was already the word for it in `CONTEXT.md`. Its
own Output is then held to the Synthesis schema, and the engine renders `review.md` from
it. Nothing about it is specific to reviewing.

**The engine renders `review.md`, the agent does not.** The ticket asks for a fixed shape —
summary, verdict, findings by severity, no preamble, nothing about the process, under ~25
lines. Asking an agent to obey a format on every run is the least reliable way to get one,
and "post review.md verbatim" only means something if the file is deterministic. So the
synthesiser writes `synthesized.json` and the prose that goes in it (`summary`, `title`,
`detail`); `renderReview()` decides the shape. The step still produces both artefacts, and
`review.md` is testable without an agent in the loop.

**The verdict is rendered as words, not as a label.** A `clean` synthesis renders
`Nothing to fix.` under the summary; a synthesis with findings renders the severity groups
and no verdict line at all. "Verdict: findings" next to a list of findings is the sort of
report line the ticket asks not to write.

**Posting is the engine's job, not an agent's.** `post: true` is a fourth Choice form
beside `run`, `prompt` and `stop`. The engine reads `review.md` and runs
`glab mr note <iid> --message <the file>` — one note, no shell, nothing retyped. A note
that will not send prints the exit code and re-offers the menu, which is how a `prompt`
round that does not finish already behaves.

**"Standalone MR targets only" is two mechanisms already in the tree.** The choice step is
`standalone: true` (ticket 07), so embedding `review` drops it, and
`requires: [mr-target, gitlab]` (ticket 11's requirement mechanism, now taking a list) skips
it with a note naming the gap. `mr-target` reads `target_kind`, which ticket 10 already
records next to the value. `mr-target` is listed first so a branch target is told what it
actually is rather than "glab is not installed".

**An embedded step that shares the embedding step's name keeps it.** `review` now has two
steps, so `use: review` inside `implement` would have renamed the reviewers to
`review.review`. A child whose id equals the embedding step's id IS that step, so only its
siblings take the prefix: `implement`'s steps are `review` and `review.synthesize`, and the
existing run dirs, prompts and tests keep their paths.

**A fan-in pane splits down, not right.** Three side-by-side columns in half a terminal are
three unreadable columns. The reviewers are finished by the time the synthesiser starts, so
it takes half of the last reviewer's pane: the synthesis sits under the review it came from.

**`unionFindings` is gone, not kept as a fallback.** The gate reads the findings of the
step it points at, and that step is now a synthesis. A fork that points a gate at a
parallel step would see each variant's findings as-is rather than a union — that is the
honest consequence of moving fan-in out of the engine, and the baseline never does it.

## What the reviewers and the synthesiser are told

The synthesise prompt carries the two rules that keep the rest of the machinery working:
carry a `rebuttal` word for word (a dropped rebuttal would end a dispute with nobody
deciding it), and never say which model or which skill found something. The `review`
section lost its "Post to GitLab: {{inputs.post}}" paragraph; it now just says to change
nothing outside the Output file.

## What the live smoke turned up

- The Synthesis schema caught a real malformed Output on its first live run: a missing comma
  between two findings blocked the run instead of half-reading the review.
- `dropped` is a prompt rule, not an enforceable one. A synthesis rewords and merges titles
  by design, so no key match between the raw reviews and the synthesis holds, and an engine
  check would fire on nearly every run. The schema insists that anything *in* `dropped` has a
  reason; nothing insists a finding ends up there. The second live synthesiser carried two
  findings and dropped the rest with `"dropped": []`.
- Resuming a run whose previous agents are still alive fails with herdr's `agent_name_taken`.
  Pre-existing (resume has always assumed they are gone) but newly visible, because this is
  the first run resumed inside the session that started it.
