# 05: Baseline personas v2

**What to build:** Replace planner/implementer/reviewer and add architect: thin personas that name the skills (grill-with-docs, wayfinder, to-spec, to-tickets, implement, tdd, code-review, code-review-and-quality, code-simplification, improve-codebase-architecture), state constraints, the Output contract, and a skill-missing fallback paragraph. Reviewer runs both review skills and merges into one Output.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] four personas load and validate
- [x] each persona ends with the Output contract and a fallback paragraph
- [x] live smoke: reviewer on the working tree produces a schema-valid Output that mentions both skills' axes

## Decisions where the design was silent

- **Every persona ends with `## Output` then `## Fallback`**, in that order, and the test
  asserts that shape. Single-word headings, because `bodySections` only recognises those
  and a persona should not depend on which parser reads it.
- **The Output contract is per persona, not per step**: the persona says what `verdict`,
  `findings`, `disputed` and `deferred` mean, and the step's prompt names only the extra
  keys it wants. That keeps the workflow bodies short.
- **`deferred` reuses the Finding shape** (`severity` = the candidate's strength), so the
  summary can print it with the same formatter as findings.

## Live smoke

`review` on this repo's working tree, one real claude/sonnet reviewer with the v2 persona
(run `review-worktree-20260827-120549`). It wrote a schema-valid `review.json` naming both
skills' axes ("correctness axis (code-review-and-quality) / standards axis (code-review)")
— and it caught a real bug in `architect.md`: the Output block showed `"findings": []` as
a literal while the prose told the agent to use `verdict: "findings"` when something
stopped it, which `src/output.ts` rejects. Fixed here; the other three personas describe
`findings` in prose and never had it.
