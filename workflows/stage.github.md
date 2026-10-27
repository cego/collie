Pull request: {{inputs.mr}}
Repository: {{repository}}
This run's checkout: {{cwd}}
This run's directory: {{run.dir}}

A note you hand on — to a later step, another agent or a human — goes in
`{{run.dir}}/handoffs/`, never `/tmp`: the Run's record lists it, and it is kept as long
as the Run is.

This Run puts the pull request's head on staging for the human to test, unmerged, and does
nothing more. This checkout is the pull request's head branch, at the head Collie read:
never commit or push, never post on the pull request or change its state, and never switch
this checkout's branch.

A **package** publishes from its tags and is deployed by nobody; an
**application** has deploy workflows or GitHub environments (staging, production) of its
own.

## assess

Nothing shared is touched yet: no Helle claim is held, so read only.

Decide first whether this repository is a package or an application: read its
`.github/workflows/` and `gh api repos/{owner}/{repo}/environments`. A deploy workflow or a
`staging` or `production` environment make it an application; a workflow that publishes
on tags or releases and no deploy makes it a package. Say which in your Output, with the
evidence.

For an application, also name from its workflows, in `stage_jobs`, the jobs that deploy
to staging: those a pull request's workflow runs start (`merge_request`), and those a tag's
start (`tag`). Either list may be empty.

Name in `applications` every application the pull request's workflow runs deploy to
staging, by the name its deploy jobs give it: `spilnu` for `stage:spilnu`. A repository
that deploys several, such as a monorepo, names each one it deploys. Collie claims each
one's Helle project before anything goes on staging, and asks the human where one has none.

Then write your Output. `is_package` is the judgement everything after this branches on, so
say it plainly and say what the evidence was.

## stage

This Run holds the repository in Helle, or the repository has no Helle project: either way
staging is yours until the Run ends. Deploy {{inputs.mr}} to staging from its own workflow
runs, at its head `{{head}}`, for the human to test there. Nothing is merged: merge, tag
and push nothing here.

- The pull request's workflow run at `{{head}}` deploys to staging with {{stage_jobs}}.
  Start and watch those jobs to success — `gh run list --commit {{head}}`, then
  `gh run watch` — rerunning one that failed with `gh run rerun <id> --job <job id>`, and
  then the jobs the repository itself checks staging with: an e2e or smoke job of the same
  run.
- Where a staging deploy or a staging check fails, **Roll stage back** to the newest
  release production carries, so staging is never left broken, and only in the staging
  environments those jobs deployed to: the ref of the newest production deployment whose
  latest status is `success` — `gh api repos/{owner}/{repo}/deployments?environment=<production>`
  and each one's `statuses` — deployed to staging by the repository's own deploy workflow.
  Watch the rollback to success, say in your log what staging is running now, and write
  your Output: Collie reads staging back and ends the Run with what failed.
- Never play, retry or ask about a production job: never approve its environment either.
  Never start a job that deploys an application not named above.

Then write your Output, naming in `stage_jobs` the staging deploy and staging check jobs of
the pull request's workflow runs you started or checked. Collie reads each of them, and
staging, back from GitHub, not from your Output.

## unstage

Staging carries {{inputs.mr}} at `{{head}}`, unmerged, and it comes off: {{failure}}.

**Roll stage back** to the newest release production carries, unless it is already there,
and only in the staging environments this Run deployed {{stage_jobs}} to: the ref of the
newest production deployment whose latest status is `success` —
`gh api repos/{owner}/{repo}/deployments?environment=<production>` and each one's
`statuses` — deployed to staging by the repository's own deploy workflow. Watch it to
success. Never approve or run a production job, and merge, tag or push nothing.

Then write your Output, naming in `stage` the release staging runs now. Collie reads
staging back from GitHub, not from your Output.
