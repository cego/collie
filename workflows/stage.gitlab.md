Merge request: {{inputs.mr}}
Repository: {{repository}}
This run's checkout: {{cwd}}
This run's directory: {{run.dir}}

A note you hand on — to a later step, another agent or a human — goes in
`{{run.dir}}/handoffs/`, never `/tmp`: the Run's record lists it, and it is kept as long
as the Run is.

This Run puts the merge request's head on stage for the human to test, unmerged, and does
nothing more. This checkout is the merge request's source branch, at the head Collie read:
never commit or push, never post on the merge request or change its state, and never switch
this checkout's branch.

A **package** publishes from its tag pipeline and is deployed by nobody; an
**application** has deploy jobs or GitLab environments (stage, prod) of its own.

## assess

Nothing shared is touched yet: no Helle claim is held, so read only.

Decide first whether this repository is a package or an application: read its
`.gitlab-ci.yml` and `glab api projects/<id>/environments`. Deploy jobs or a `staging` or
`production` environment make it an application; a publish job on tags and no deploy makes
it a package. Say which in your Output, with the evidence.

For an application, also name from its CI configuration, in `stage_jobs`, the jobs that
deploy to stage: those a merge request's pipeline runs (`merge_request`), and those a tag's
pipeline runs (`tag`). Either list may be empty.

Name in `applications` every application the merge request's pipeline deploys to stage, by
the name its deploy jobs give it: `spilnu` for `stage:spilnu`. A repository that deploys
several, such as a monorepo, names each one it deploys. Collie claims each one's Helle
project before anything goes on stage, and asks the human where one has none.

Then write your Output. `is_package` is the judgement everything after this branches on, so
say it plainly and say what the evidence was.

## stage

This Run holds the repository in Helle, or the repository has no Helle project: either way
stage is yours until the Run ends. Deploy {{inputs.mr}} to stage from its own pipeline, at
its head `{{head}}`, for the human to test there. Nothing is merged: merge, tag and push
nothing here.

- The merge request's pipeline at `{{head}}` deploys to stage with {{stage_jobs}}. Play,
  retry and watch those jobs to success — a manual one is played with
  `glab api -X POST projects/<id>/jobs/<job id>/play` — and then the jobs the repository
  itself checks stage with: an `e2e-stage` or smoke job of the same pipeline.
- Where a stage deploy or a stage check fails, **Roll stage back** to the newest release
  production carries, so stage is never left broken, and only in the stage environments
  those jobs deployed to: the ref of the newest successful production deployment — `glab api
  projects/<id>/deployments?environment=<production>&status=success&order_by=created_at&sort=desc&per_page=1`
  — and its pipeline's stage deploy job, played or retried. Watch the rollback to success,
  say in your log what stage is running now, and write your Output: Collie reads stage back
  and ends the Run with what failed.
- Never play, retry or ask about a production job, nor a job that deploys an application
  not named above.

Then write your Output, naming in `stage_jobs` the stage deploy and stage check jobs of the
merge request's pipeline you played or checked. Collie reads each of them, and stage, back
from GitLab, not from your Output.

## unstage

Stage carries {{inputs.mr}} at `{{head}}`, unmerged, and it comes off: {{failure}}.

**Roll stage back** to the newest release production carries, unless it is already there,
and only in the stage environments this Run deployed {{stage_jobs}} to: the ref of the
newest successful production deployment — `glab api
projects/<id>/deployments?environment=<production>&status=success&order_by=created_at&sort=desc&per_page=1`
— and its pipeline's stage deploy job, played or retried. Watch it to success. Never play a
production job, and merge, tag or push nothing.

Then write your Output, naming in `stage` the release stage runs now. Collie reads stage
back from GitLab, not from your Output.
