# 19: an MR target carries its project, so reviewing and posting to someone else's MR works from any directory

**Bug:** pasting an MR URL reduces the target to `mr:<iid>`; the project is lost, and every glab call (diff, view, note) and `gitlabReadiness` assume the cwd is a checkout of that repo. From a non-repo cwd (e.g. the group folder) the post choice fails with "not a git worktree"/"no remote".

**What to build:** The target keeps the project: URL → `mr:<host>/<group>/<project>!<iid>` (label stays `!<iid>`); a bare iid or a branch-inferred MR resolves the project from the cwd's GitLab remote at inference time and stores it the same way. Every glab invocation the runner or the prompts make takes `--repo <host>/<group>/<project>` (glab `-R`), so no checkout is required; the review prompt's instructions for `mr:` targets show the exact commands with `--repo`. `gitlabReadiness` for an `mr` target checks only that glab is installed and authenticated for that host (`glab auth status --hostname`), not the cwd's remotes; the cwd-remote check remains for the implement MR step (which pushes). When the cwd is not a git repo at all, worktree/branch candidates are simply absent from the menu and "Type it…" is the default.

**Blocked by:** none — jump the queue: do this right after the 16 bug fix, before 18.

**Status:** ready-for-agent

- [ ] classifyTarget keeps host/group/project from a URL; bare iid gets the project from the remote (tested with fake git)
- [ ] all glab calls carry --repo; fake glab asserts it (tested)
- [ ] post choice offered and succeeds from a non-repo cwd with an MR URL target (fake glab transcript)
- [ ] non-repo cwd: no worktree/branch candidates, Type it… default (tested)
- [ ] live smoke: from /home/mk/work/gitte2/gitlab.cego.dk (not a repo) review an MR URL → post choice appears; do NOT actually post to a real MR — stop at the menu and pick Don't post

## Decisions where the design was silent

**The target's shape.** `mr:<host>/<group>/<project>!<iid>`, with the `!` as the separator
because that is how GitLab itself writes `group/project!42`. `parseMrTarget` also still
reads the old bare `mr:<iid>` as "the merge request of whatever project you are standing
in", so runs recorded before this ticket keep working and degrade to exactly today's
behaviour. Subgroups are just part of the path.

**What `gitlab` means depends on what the step is pointed at.** Rather than adding a
requirement name, `requires: gitlab` on a step that *also* requires `mr-target` is checked
as "glab installed and logged in to that project's host"; on any other step it stays "glab
installed and this directory has a GitLab remote", which is what `implement`'s `mr` step
needs because it pushes. Two reasons for the implicit rule over an explicit `glab-auth`:
the sentence is true either way — a step needs glab for the thing it is pointed at — and
mk's user-layer `review.md` already declares `[mr-target, gitlab]`, so the fix reaches the
config that is actually installed instead of waiting for that copy to be updated.

**A target with no project falls back to the cwd.** `gitlabForProject(null, …)` defers to
the old `gitlabReadiness`, and `repoArgs(null)` is empty, so an old `mr:42` behaves exactly
as it did.

**The project for a bare iid comes from `origin`, else `upstream`.** `git remote get-url`
rather than parsing `remote -v`, and only those two names: a fork's `origin` is the fork,
which is the project its MRs are on.

**A non-checkout offers no candidates at all.** `git rev-parse --git-dir` decides whether
this directory has a branch or a working tree to review. It used to fall back to offering
`worktree` whenever nothing else was found, which in a group folder meant offering to
review a working tree that does not exist. With no candidates the menu is one entry and
"Type it…" is the default, which is what the ticket asks for and what a group folder should
offer.

**`targetKind(value)`** is now a named function rather than a fact only the picker knew, so
the test rig and anything else reading a recorded target agree on what `mr:`/`branch:`/
`worktree` mean.
