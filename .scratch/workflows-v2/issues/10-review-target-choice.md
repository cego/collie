# 10: review lets the human choose the target: an MR, a local branch, or the working tree

**What to build:** `review`'s `target` input stops being silently inferred. The runner gathers candidates: open merge requests for the current branch (and, when the branch has none, the repo's open MRs assigned to or authored by me via `glab mr list`), the current branch against the default base, and the working tree when it has uncommitted changes. The picker always shows a menu with these candidates plus "Type it…" for an MR iid/URL or a `base...head` range; the top entry is the one today's inference would have picked, so Enter keeps the old behaviour. Kinds recorded as `mr`, `branch`, `worktree`; `{{inputs.target}}` keeps its current `mr:!<iid>` / `branch:<base>...<head>` / `worktree` shape so the review prompt is unchanged. `implement` embedding `review` keeps inferring `branch` for the run's own branch without a menu (an embedded step never asks).

**Blocked by:** 09 (shares the candidate/menu input machinery; reuse it, do not duplicate)

**Status:** ready-for-agent

- [ ] menu always shown for a standalone review, default = old inference order (tested with fake glab/git)
- [ ] "Type it…" classifies MR iid, MR URL and base...head correctly (tested)
- [ ] embedded review inside implement never prompts (tested)
- [ ] README + docs/WORKFLOWS-DESIGN.md updated; bun test + tsc green
- [ ] live smoke: pick review on this repo → menu lists branch and worktree
