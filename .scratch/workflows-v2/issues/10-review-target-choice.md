# 10: review lets the human choose the target: an MR, a local branch, or the working tree

**What to build:** `review`'s `target` input stops being silently inferred. The runner gathers candidates: open merge requests for the current branch (and, when the branch has none, the repo's open MRs assigned to or authored by me via `glab mr list`), the current branch against the default base, and the working tree when it has uncommitted changes. The picker always shows a menu with these candidates plus "Type it…" for an MR iid/URL or a `base...head` range; the top entry is the one today's inference would have picked, so Enter keeps the old behaviour. Kinds recorded as `mr`, `branch`, `worktree`; `{{inputs.target}}` keeps its current `mr:!<iid>` / `branch:<base>...<head>` / `worktree` shape so the review prompt is unchanged. `implement` embedding `review` keeps inferring `branch` for the run's own branch without a menu (an embedded step never asks).

**Blocked by:** 09 (shares the candidate/menu input machinery; reuse it, do not duplicate)

**Status:** done

- [x] menu always shown for a standalone review, default = old inference order (tested with fake glab/git)
- [x] "Type it…" classifies MR iid, MR URL and base...head correctly (tested)
- [x] embedded review inside implement never prompts (tested)
- [x] README + docs/WORKFLOWS-DESIGN.md updated; bun test + tsc green
- [x] live smoke: pick review on this repo → menu lists branch and worktree

## Decisions where the design was silent

- **The value shape is the one the code already used, `mr:<iid>`.** The ticket writes it
  as `mr:!<iid>`, but its own reason for naming a shape is "so the review prompt is
  unchanged", and the prompt has always been given `mr:42`. Keeping `mr:42` honours the
  reason; the `!` appears in the label and the source line, where it reads as an MR.
- **A bare ref typed into "Type it…" means that ref against the default base.** Only
  `base...head` is specified, but a lone branch name is the obvious thing to type, and
  `branch:<base>...<ref>` is what it can only sensibly mean. A blank line cancels.
- **The working tree is offered when it is dirty, and also when nothing else is.** The
  ticket asks for it only when dirty, but old inference fell back to it unconditionally,
  and an empty menu would have no way to reproduce that. It stays last either way.
- **"Never asks" is a property of the input, not the step.** An embedded workflow's
  inputs now travel as `embeddedInputs` on the resolved workflow, so `implement` infers
  `target` silently while standalone `review` shows the menu. This is what makes the
  rule testable without running the picker.
- **A kind is a companion of its input, not an input of its own.** `<name>_kind` is in
  `inputs` because prompts read it, but out of `input_sources`, which is about
  provenance; the runner prints the kind on its own input's line instead.
