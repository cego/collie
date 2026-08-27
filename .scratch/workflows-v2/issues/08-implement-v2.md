# 08: implement v2 and review v2

**What to build:** implement: build (branch <slug>, implement+tdd per ticket, commit per ticket; no commit step) → architecture (use: architecture, prompt: unattended) → simplify → review (use: review, fresh, opus+sonnet xhigh) → fix loop max 5 that re-runs simplify then review; blocked at max with findings. review: one reviewer persona, opus+sonnet variants, spec = plan dir when inferable.

**Blocked by:** 01, 04, 05, 07

**Status:** done

- [x] loop order fix → simplify → review asserted against fake herdr
- [x] no commit step; build prompt branches off default branch
- [x] review variants are the same persona, two models
- [x] README and docs/WORKFLOWS-DESIGN.md status updated

## Decisions where the design was silent

- **`repeat: {from, back_to}`.** `from` stays the gate (whose verdicts decide), and
  `back_to` says where the next round starts. `implement` gates on `review` and restarts at
  `simplify`, which is exactly "simplify IS in the loop, architecture is not".
- **The parallel variants live in `review.md`**, not in `implement`'s embedding step, so a
  standalone review and the review inside `implement` are the same two models by
  construction — and forking `review.md` changes both.
- **`review` does not declare a plan input.** Its prompt reads `{{inputs.plan}}`, which the
  enclosing run supplies (`implement` declares it) and which renders empty standalone —
  "spec = plan dir if inferable, else no spec" without making a standalone review of an MR
  hunt for somebody's plan run, or ask for one.
- **`worktree` means "the change in front of you"**, which the prompt now spells out as
  uncommitted work *plus* commits this branch has and the default branch does not. Without
  that, `implement`'s reviewers would see nothing: build commits per ticket, so the working
  tree is clean by the time they look.
- **One agent per `agent:` group, even after a resume.** The dead agent is never reused, but
  the first step that borrows it lends its new agent to the rest of the group, so a resumed
  `implement` has one implementer across architecture, simplify and fix instead of three.
