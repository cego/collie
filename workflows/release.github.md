Pull request: {{inputs.mr}}
Repository: {{repository}}
This run's checkout: {{cwd}}
This run's directory: {{run.dir}}

A note you hand on — to a later step, another agent or a human — goes in
`{{run.dir}}/handoffs/`, never `/tmp`: the Run's record lists it, and it is kept as long
as the Run is.

This checkout is the pull request's head branch. Collie waits for the review, proves the
head with the Run's checks, asks the human for the go and merges: never merge, approve or
close the pull request yourself, and never switch this checkout's branch.

A **package** publishes from a tag or release and is deployed by nobody; an
**application** has deploy workflows or GitHub environments (staging, production) of its
own.

## assess

Nothing shared is touched yet: no Helle claim is held, so read only. The human's go comes
first, and the claim after it.

Decide first whether this repository is a package or an application: read its
`.github/workflows/` and `gh api repos/{owner}/{repo}/environments`. A deploy workflow or a
`staging` or `production` environment make it an application; a workflow that publishes
on tags or releases and no deploy makes it a package. Say which in your Output, with the
evidence.

For an application, also name from its workflows, in `stage_jobs`, the jobs that deploy
to staging: those a pull request's workflow runs start (`merge_request`), and those a tag's
start (`tag`). Either list may be empty.

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
branch, the pull request's head branch, and push with a plain `git push origin HEAD` — never a force push.
Where you judge a comment wrong, change nothing for it and dispute it with your reason.

Collie replies to each comment on the forge for you, and never resolves a thread: never
post on the pull request, reply to a comment or resolve a thread yourself.

This Run's checks, which Collie runs on the head you push:

{{verify}}

Run the typecheck and the test files you touched, each through `collie verify`, and never
the whole suite.

Then write your Output: one entry in `answers` per comment, by its id. `fixed` names in
`commit` the pushed commit that fixes it, and `note` says what changed; `disputed` says in
`note` why nothing changed. Collie counts a fix only once the pull request's head carries its
commit, and a comment you leave out goes to the next round.

## fix

Fix round {{iteration}} of at most {{max_iterations}}. Collie ran this Run's checks on
the pull request's head, and this failed:

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
staging is yours until the Run ends. Deploy {{inputs.mr}} to staging from its own workflow
runs, at its head `{{head}}`, for the human to test there. Nothing is merged: merge, tag
and push nothing here.

- The pull request's workflow run at `{{head}}` deploys to staging with {{stage_jobs}}.
  Start and watch those jobs to success — `gh run list --commit {{head}}`, then
  `gh run watch` — rerunning one that failed with `gh run rerun <id> --job <job id>`, and
  then the jobs the repository itself checks staging with: an e2e or smoke job of the same
  run.
- Where a staging deploy or a staging check fails, **Roll stage back** to the newest
  release production carries, so staging is never left broken: the ref of the newest
  production deployment whose latest status is `success` —
  `gh api repos/{owner}/{repo}/deployments?environment=<production>` and each one's
  `statuses` — deployed to staging by the repository's own deploy workflow. Watch the
  rollback to success, say in your log what staging is running now, and write your
  Output: Collie hands the failure to a fix round.
- Never play, retry or ask about a production job: never approve its environment either.

Then write your Output, naming in `stage_jobs` the staging deploy and staging check jobs of
the pull request's workflow runs you started or checked. Collie reads each of them, and
staging, back from GitHub, not from your Output.

## unstage

Staging carries {{inputs.mr}} at `{{head}}`, unmerged, and it comes off: {{failure}}.

**Roll stage back** to the newest release production carries, unless it is already there:
the ref of the newest production deployment whose latest status is `success` —
`gh api repos/{owner}/{repo}/deployments?environment=<production>` and each one's
`statuses` — deployed to staging by the repository's own deploy workflow. Watch it to
success. Never approve or run a production job, and merge, tag or push nothing.

Then write your Output, naming in `stage` the release staging runs now. Collie reads
staging back from GitHub, not from your Output.

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
  `### Miscellaneous` — with one line per change, `- <what changed> [#<n>]`, where the
  pull request reference is the only link. Write the notes to a file and tag from it with
  `--cleanup=verbatim`, or git strips the `#` headers as comments. Push the tag to origin.
- Create a GitHub release with the same notes, verbatim — `gh release create <tag>
  --notes-file <file> --verify-tag` — where the package publishes from a tag or release.
- Watch the workflow runs the tag started — `gh run list --commit <sha>`, then `gh run
  watch` — until every job has finished. Production deploy jobs are mine: never approve,
  rerun or ask about them. A job waiting for somebody to approve or start it by hand is a
  finding, not something to start.

Then write your Output, naming the tag, the version and the URL of the tag's workflow run.
Collie reads the tag back on origin and the run from GitHub, not from your Output.

## tag-tested

{{recovery}}

Collie merged {{inputs.mr}} at the head the human tested on staging, and
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
  `### Miscellaneous` — with one line per change, `- <what changed> [#<n>]`, where the
  pull request reference is the only link. Write the notes to a file and tag from it with
  `--cleanup=verbatim`, or git strips the `#` headers as comments. Push the tag to origin.
  An application makes no GitHub release.
- Watch the tag's workflow run until the only jobs left are production jobs waiting on
  their environment's approval. Never play, retry or ask about a production job: never
  approve its environment either. Collie sends it to production on the human's go.

Then write your Output: the tag, the version, the URL of the tag's workflow run, and in
`production_jobs` each production job left waiting, with its URL. Collie reads the tag back
on origin and the run from GitHub, not from your Output.

## stage

{{recovery}}

Collie merged {{inputs.mr}}, and the merged commit is `{{merged}}`. This Run holds the
repository in Helle, or the repository has no Helle project: either way staging, the
default branch and the tag are yours until the Run ends. Release it to staging:

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
  `### Miscellaneous` — with one line per change, `- <what changed> [#<n>]`, where the
  pull request reference is the only link. Write the notes to a file and tag from it with
  `--cleanup=verbatim`, or git strips the `#` headers as comments. Push the tag to origin.
  An application makes no GitHub release.
- The workflow run the tag started deploys to staging with {{stage_jobs}}. Watch those
  jobs to success — `gh run list --commit <sha>`, then `gh run watch` — rerunning one that
  failed with `gh run rerun <id> --job <job id>`, and then the jobs the repository itself
  checks staging with: an e2e or smoke job of the same run.
- Where a staging deploy or a staging check fails, **Roll stage back** to the newest
  release production carries, so staging is never left broken: the ref of the newest
  production deployment whose latest status is `success` —
  `gh api repos/{owner}/{repo}/deployments?environment=<production>` and each one's
  `statuses` — deployed to staging by the repository's own deploy workflow. Watch the
  rollback to success, say in your log what staging is running now, and write your Output:
  the fix is a new pull request, never a change here.
- Watch the tag's workflow run until the only jobs left are production jobs waiting on
  their environment's approval. Never play, retry or ask about a production job: never
  approve its environment either. The human sends it to production on a second go, and
  Collie asks it.

Then write your Output: the tag, the version, the URL of the tag's workflow run, the
staging jobs you watched or checked in `stage_jobs`, and in `production_jobs` each
production job left waiting, with its URL. Collie reads the tag back on origin, and
staging and the run from GitHub, not from your Output.

## rollback

Staging failed after Collie merged {{inputs.mr}} at `{{merged}}`: {{failure}}.

**Roll stage back** to the newest release production carries, unless it is already there:
the ref of the newest production deployment whose latest status is `success` —
`gh api repos/{owner}/{repo}/deployments?environment=<production>` and each one's
`statuses` — deployed to staging by the repository's own deploy workflow. Watch it to
success. Never approve or run a production job, and change nothing on the default branch:
the fix is a new pull request.

Then write your Output, naming in `stage` the release staging runs now. Collie reads
staging back from GitHub, not from your Output.

## production

The human sent `{{merged}}` of {{inputs.mr}} to production. Start exactly these jobs of
the tag's workflow run, and no other job: {{jobs}}. Each waits on its environment's
approval: approve that pending deployment for that run alone —
`gh api -X POST repos/{owner}/{repo}/actions/runs/<run id>/pending_deployments` with the
environment's id, `state=approved` and a comment — and watch the job to success.

Then write your Output, naming the jobs you started. Collie waits until GitHub shows
production carries the merge, whatever your Output says.

## share

The human checked {{inputs.mr}} and asked for it to be shared for approval in {{channel}}.
The host reads its title from GitHub and posts through the host's Slack adapter:
{{inputs.mr}} linked by that title, written `<URL|TITLE>`, with
no other words, no emoji, no mention and no thread reply.
The host records the message's permalink, or why the post failed or its permalink is missing.
The release continues to its review wait even when Slack refuses.

Without a working Slack Connection, the Run asks you to share it yourself and shows the address to copy.
No agent posts in Slack.
