Merge request: {{inputs.mr}}
Repository: {{repository}}
This run's checkout: {{cwd}}
This run's directory: {{run.dir}}

A note you hand on — to a later step, another agent or a human — goes in
`{{run.dir}}/handoffs/`, never `/tmp`: the Run's record lists it, and it is kept as long
as the Run is.

This checkout is the merge request's source branch. Collie waits for the review, proves the
head with the Run's checks, asks the human for the go and merges: never merge, approve or
close the merge request yourself, and never switch this checkout's branch.

A **package** publishes from its tag pipeline and is deployed by nobody; an
**application** has deploy jobs or GitLab environments (stage, prod) of its own.

## assess

Nothing shared is touched yet: no Helle claim is held, so read only. The human's go comes
first, and the claim after it.

Decide first whether this repository is a package or an application: read its
`.gitlab-ci.yml` and `glab api projects/<id>/environments`. Deploy jobs or a `staging` or
`production` environment make it an application; a publish job on tags and no deploy makes
it a package. Say which in your Output, with the evidence.

For an application, also name from its CI configuration, in `stage_jobs`, the jobs that
deploy to stage: those a merge request's pipeline runs (`merge_request`), and those a tag's
pipeline runs (`tag`). Either list may be empty.

Name in `applications` every application this release deploys, by the name its deploy jobs
give it: `spilnu` for `stage:spilnu` and `prod:spilnu`. A repository that deploys several,
such as a monorepo, names each one it deploys. Collie claims each one's Helle project before
the merge, and asks the human before any merge where one has none.

Then write your Output. `is_package` is the judgement everything after this branches on, so
say it plainly and say what the evidence was.

## answer

Comment round {{round}}. These review comments on {{inputs.mr}} are unanswered:

{{comments}}

Check each one against the code. Where it holds, fix it test first, with
{{skill:tdd}}: the failing test, then the fix. Commit each fix to this checkout's
branch, the merge request's source branch, and push with a plain `git push origin HEAD` — never a force push.
Where you judge a comment wrong, change nothing for it and dispute it with your reason.

Collie replies to each comment on the forge for you, and never resolves a thread: never
post on the merge request, reply to a comment or resolve a thread yourself.

This Run's checks, which Collie runs on the head you push:

{{verify}}

Run the typecheck and the test files you touched, each through `collie verify`, and never
the whole suite.

Then write your Output: one entry in `answers` per comment, by its id. `fixed` names in
`commit` the pushed commit that fixes it, and `note` says what changed; `disputed` says in
`note` why nothing changed. Collie counts a fix only once the merge request's head carries its
commit, and a comment you leave out goes to the next round.

## fix

Fix round {{iteration}} of at most {{max_iterations}}. Collie ran this Run's checks on
the merge request's head, and this failed:

{{findings}}

Fix the cause test first, with {{skill:tdd}}, commit it to this checkout's branch and push
with a plain `git push origin HEAD` — never a force push. Where you are sure a failure is not this
branch's, change nothing and record it under `disputed` with your reason. The checks:

{{verify}}

Run the typecheck and the test files you touched, each through `collie verify`, and never
the whole suite. Collie runs the checks again on the head you push.

Then write your Output. `file` and `title` in `fixed` and `disputed` are exactly as the
finding above gives them; `checks` names every test and lint command you ran.

## stage-merge-request

This Run holds the repository in Helle, or the repository has no Helle project: either way
stage is yours until the Run ends. Deploy {{inputs.mr}} to stage from its own pipeline, at
its head `{{head}}`, for the human to test there. Nothing is merged: merge, tag and push
nothing here.

- The merge request's pipeline at `{{head}}` deploys to stage with {{stage_jobs}}. Play,
  retry and watch those jobs to success — a manual one is played with
  `glab api -X POST projects/<id>/jobs/<job id>/play` — and then the jobs the repository
  itself checks stage with: an `e2e-stage` or smoke job of the same pipeline.
- Where a stage deploy or a stage check fails, **Roll stage back** to the newest release
  production carries, so stage is never left broken: the ref of the newest successful
  production deployment — `glab api
  projects/<id>/deployments?environment=<production>&status=success&order_by=created_at&sort=desc&per_page=1`
  — and its pipeline's stage deploy job, played or retried. Watch the rollback to success,
  say in your log what stage is running now, and write your Output: Collie hands the
  failure to a fix round.
- Never play, retry or ask about a production job.

Then write your Output, naming in `stage_jobs` the stage deploy and stage check jobs of the
merge request's pipeline you played or checked. Collie reads each of them, and stage, back
from GitLab, not from your Output.

## unstage

Stage carries {{inputs.mr}} at `{{head}}`, unmerged, and it comes off: {{failure}}.

**Roll stage back** to the newest release production carries, unless it is already there:
the ref of the newest successful production deployment — `glab api
projects/<id>/deployments?environment=<production>&status=success&order_by=created_at&sort=desc&per_page=1`
— and its pipeline's stage deploy job, played or retried. Watch it to success. Never play a
production job, and merge, tag or push nothing.

Then write your Output, naming in `stage` the release stage runs now. Collie reads stage
back from GitLab, not from your Output.

## tag

{{recovery}}

Collie merged {{inputs.mr}}, and the merged commit is `{{merged}}`. Release it:

- Work in a worktree of your own at the merged commit — `git fetch origin`, then
  `git worktree add {{run.dir}}/release {{merged}}` — and leave this checkout as it is.
- Diff the merged commit against the previous version tag and choose the next version
  from that and from the repository's own versioning conventions.
- Where the repository makes a release commit — a version file or a changelog bumped on
  release — commit it on the default branch on top of the merged commit, and push it.
- Tag annotated, following the repository's own tag and notes conventions. Where it has
  none, the tag notes are a changelog entry in the shape of changelog-gen: a heading
  `## <version> - <YYYY-MM-DD>`, then only the sections that have entries, in this order
  and under these names — `### Features and Improvements`, `### Bug fixes`,
  `### Miscellaneous` — with one line per change, `- <what changed> [!<iid>]`, where the
  merge request reference is the only link. Write the notes to a file and tag from it with
  `--cleanup=verbatim`, or git strips the `#` headers as comments. Push the tag to origin.
- Create a GitLab release with the same notes, verbatim, where the package publishes from
  its tags.
- Watch the tag's pipeline until every job has finished. Production deploy jobs are
  mine: never play, retry or ask about them. A job waiting for somebody to start it by
  hand is a finding, not something to start.

Then write your Output, naming the tag, the version and the URL of the tag's pipeline.
Collie reads the tag back on origin and the pipeline from GitLab, not from your Output.

## tag-tested

{{recovery}}

Collie merged {{inputs.mr}} at the head the human tested on stage, and
the merged commit is `{{merged}}`. This Run holds the repository in Helle, or the repository has no Helle
project: either way the default branch and the tag are yours until the Run ends. Release
it:

- Work in a worktree of your own at the merged commit — `git fetch origin`, then
  `git worktree add {{run.dir}}/release {{merged}}` — and leave this checkout as it is.
- Diff the merged commit against the previous version tag and choose the next version
  from that and from the repository's own versioning conventions.
- Where the repository makes a release commit — a version file or a changelog bumped on
  release — commit it on the default branch on top of the merged commit, and push it.
- Tag annotated, following the repository's own tag and notes conventions. Where it has
  none, the tag notes are a changelog entry in the shape of changelog-gen: a heading
  `## <version> - <YYYY-MM-DD>`, then only the sections that have entries, in this order
  and under these names — `### Features and Improvements`, `### Bug fixes`,
  `### Miscellaneous` — with one line per change, `- <what changed> [!<iid>]`, where the
  merge request reference is the only link. Write the notes to a file and tag from it with
  `--cleanup=verbatim`, or git strips the `#` headers as comments. Push the tag to origin.
  An application makes no GitLab release.
- Watch the tag's pipeline until the only jobs left are production jobs waiting for
  somebody to start them by hand. Never play, retry or ask about a production job: Collie
  sends it to production on the human's go.

Then write your Output: the tag, the version, the URL of the tag's pipeline, and in
`production_jobs` each production job left waiting, with its URL. Collie reads the tag back
on origin and the pipeline from GitLab, not from your Output.

## stage

{{recovery}}

Collie merged {{inputs.mr}}, and the merged commit is `{{merged}}`. This Run holds the
repository in Helle, or the repository has no Helle project: either way stage, the default
branch and the tag are yours until the Run ends. Release it to stage:

- Work in a worktree of your own at the merged commit — `git fetch origin`, then
  `git worktree add {{run.dir}}/release {{merged}}` — and leave this checkout as it is.
- Diff the merged commit against the previous version tag and choose the next version
  from that and from the repository's own versioning conventions.
- Where the repository makes a release commit — a version file or a changelog bumped on
  release — commit it on the default branch on top of the merged commit, and push it.
- Tag annotated, following the repository's own tag and notes conventions. Where it has
  none, the tag notes are a changelog entry in the shape of changelog-gen: a heading
  `## <version> - <YYYY-MM-DD>`, then only the sections that have entries, in this order
  and under these names — `### Features and Improvements`, `### Bug fixes`,
  `### Miscellaneous` — with one line per change, `- <what changed> [!<iid>]`, where the
  merge request reference is the only link. Write the notes to a file and tag from it with
  `--cleanup=verbatim`, or git strips the `#` headers as comments. Push the tag to origin.
  An application makes no GitLab release.
- The tag's pipeline deploys to stage with {{stage_jobs}}. Play, retry and watch those
  jobs to success — a manual one is played with
  `glab api -X POST projects/<id>/jobs/<job id>/play` — and then the jobs the repository
  itself checks stage with: an `e2e-stage` or smoke job of the same pipeline.
- Where a stage deploy or a stage check fails, **Roll stage back** to the newest release
  production carries, so stage is never left broken: the ref of the newest successful
  production deployment — `glab api
  projects/<id>/deployments?environment=<production>&status=success&order_by=created_at&sort=desc&per_page=1`
  — and its pipeline's stage deploy job, played or retried. Watch the rollback to success,
  say in your log what stage is running now, and write your Output: the fix is a new merge
  request, never a change here.
- Watch the tag's pipeline until the only jobs left are production jobs waiting for
  somebody to start them by hand. Never play, retry or ask about a production job: the
  human sends it to production on a second go, and Collie asks it.

Then write your Output: the tag, the version, the URL of the tag's pipeline, the stage
jobs you played or checked in `stage_jobs`, and in `production_jobs` each production job
left waiting, with its URL. Collie reads the tag back on origin, and stage and the
pipeline from GitLab, not from your Output.

## rollback

Stage failed after Collie merged {{inputs.mr}} at `{{merged}}`: {{failure}}.

**Roll stage back** to the newest release production carries, unless it is already there:
the ref of the newest successful production deployment — `glab api
projects/<id>/deployments?environment=<production>&status=success&order_by=created_at&sort=desc&per_page=1`
— and its pipeline's stage deploy job, played or retried. Watch it to success. Never play a
production job, and change nothing on the default branch: the fix is a new merge request.

Then write your Output, naming in `stage` the release stage runs now. Collie reads stage
back from GitLab, not from your Output.

## production

The human sent `{{merged}}` of {{inputs.mr}} to production. Play exactly these jobs of the
tag's pipeline, and no other job: {{jobs}}. Play each with
`glab api -X POST projects/<id>/jobs/<job id>/play` and watch it to success; retry one
that fails once, then stop and say so.

Then write your Output, naming the jobs you played. Collie waits until GitLab shows
production carries the merge, whatever your Output says.

## share

The human checked {{inputs.mr}} and asked for it to be shared for approval in the Slack
channel {{channel}}. Read its title with `glab mr view`. Then post exactly one message
in {{channel}}: {{inputs.mr}} as a Slack link whose text is that title, written
`<URL|TITLE>`, with no other words, no emoji, no mention and no thread reply. Post nowhere
else, and change nothing in this checkout or on the merge request.

If you have no Slack tool, or cannot post in {{channel}}, post nothing and say why in your
Output. Then write your Output: whether you posted, and the message's permalink.
