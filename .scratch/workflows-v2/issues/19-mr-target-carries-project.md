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
