Repository checkout or GitHub URL (not given means the workspace this run started from): {{inputs.repository}}
Linear team (not given means `{{config.linear.team}}`): {{inputs.team}}
Linear Renovate issue (not given means find it): {{inputs.issue}}
This run's checkout: {{cwd}}
This run's directory: {{run.dir}}

A note you hand on — to a later step, another agent or a human — goes in
`{{run.dir}}/handoffs/`, never `/tmp`: the Run's record lists it, and it is kept as long
as the Run is.

This checkout is the Run's own, detached at the repository's default branch. Collie made
it before you started and removes it when it is settled: never create one, never switch
the operator's, and never bind a branch to this one — except the batch branch the `batch`
step makes for an application, which is the one branch this checkout may hold.

This repository is on GitHub, and every command below is `gh`'s. A **package** publishes
from a tag or a release and is deployed by nobody; an **application** has a deploy
workflow or GitHub environments (staging, production) of its own. `assess` decides which
this repository is, and the `batch`, `stage` and `approval` steps are for applications
only: a package never reaches them, and the Run's own record says why.

## track

Find the team's shared Renovate issue with the Linear MCP, before anything touches the
repository, so that work in progress is visible from the moment it starts.

- The team is the one named above. If both the input and the config value are empty, ask
  me which team, once, and say in your Output that you did.
- An issue named above is the issue: read it and skip the search.
- Otherwise search that team's open issues for the Renovate issue — the one the team
  checks repositories off on, whatever it is called.
- Exactly one match is the issue. Of several, take, in this order: the one whose title
  names the current month or cycle; otherwise the one with the earliest due date;
  otherwise the newest. Say which you took and why in a comment on that issue and as
  `picked_because` in your Output. None means you create one, titled for the current
  month, whose description is the checklist and nothing else.
- Record its id in your Output. Every later step writes to that issue and no other, so a
  long Helle wait, a resume or a cycle rollover cannot split this repository across two.

Then append this repository to the issue's checklist, unchecked, as
`- [ ] <repository name>` — read the description, add your line, write it back. Never
rewrite a line you did not add: other Runs are appending to the same description.

Then write your Output, naming the issue you bound this Run to.

## assess

Nothing shared is touched yet: no Helle claim is held, so read only. Merging, deploying
and tagging wait for the claim this Run takes once you have said there is something to
land.

Decide first whether this repository is a package or an application: read its
`.github/workflows/` and `gh api repos/{owner}/{repo}/environments`. A deploy workflow or a
`staging` or `production` environment make it an application; a workflow that publishes
on tags or releases and no deploy makes it a package. Say which in your Output, with the
evidence.

List every open pull request authored by Renovate Bot on this repository with
`gh pr list --author app/renovate --state open`, and assess the whole batch **before
merging any of them**. For each one: what it bumps, from what to what, what its release
notes actually say, and whether landing it needs code or configuration changes here. Its
number is its `iid` in your Output.

Judge on release notes and compatibility, never on the version number. A major version
bump on its own is routine and is not a consultation. A **substantial or breaking code or
configuration migration** is: stop, say which pull request, what the migration is, and
what it would cost, and wait for my answer. That is the point of assessing the batch
first — I hear about it before half of it is already on the default branch.

An empty batch is a finished Run in waiting: report the repository up to date, and
expect `release` to create no tag at all.

Then write your Output. `is_package` and `up_to_date` are the two judgements everything
after this branches on, so say them plainly and say what the evidence was.

## batch

This step runs for an application with something to land; a package and a repository
that is already up to date never reach it.

Gather every relevant pull request into **one batch branch**, so the whole month's change
is proven on stage once and reviewed once, instead of landing on the default branch one
bump at a time.

- Branch the batch branch from the default branch's current head, in this checkout, and
  bind it here — this is the one branch this checkout may hold. Name it
  `deps/batch-<YYYY-MM-DD>`, or `collie/batch-<YYYY-MM-DD>` where the repository's
  configured Renovate `branchPrefix` covers `deps/`. Never name it under `renovate/` or
  that `branchPrefix`: Renovate Bot owns every branch there, and marks a request from one
  it did not make as abandoned.
- Before you take a Renovate branch in, ask git who holds it: `git worktree list` names
  every registered worktree and the branch each has checked out. A branch another worktree
  holds is **left out and reported**, not merged from its remote-tracking ref either.
- Merge each remaining Renovate branch into the batch branch, in the order that makes the
  fewest conflicts, with `git merge --no-ff origin/<branch>`. Fix what the bump broke on
  the batch branch: a conflict, a call site, a failing test. Anything that needs more than
  that is **left out of the batch** and reported with why and what you recommend — pinning
  it, a follow-up Run, or the migration it needs — and the batch carries on without it.
- Where this step leaves you a choice you can make yourself, take the option you would
  recommend and say in your Output which you took. Do not stop to ask.
- Run the repository's own install, lint, typecheck and tests on the batch branch before
  you push it. Push with `git push -u origin <batch branch>`.
- Open one pull request from the batch branch to the default branch with
  `gh pr create --assignee {{mr.assignee}}`, titled `Renovate batch <YYYY-MM-DD>`, whose
  description lists every Renovate pull request it carries as `- <what it bumps> (#<n>)`
  and every one it left out with why and what you recommend. Wait for its required checks
  with `gh pr checks <n> --required --watch` and fix failures on the batch branch. Never
  force-push it.
- Leave the individual Renovate pull requests open: Renovate closes them itself once the
  batch is on the default branch, and `merge` accounts for any that stay open.

Then write your Output, naming the batch pull request and everything it left out, with
why and what you recommend.

## stage

This Run now holds the repository in Helle — Collie claimed it and waited for the turn
before this step started — or the repository has no Helle project. Either way the shared
things are yours until the Run ends: stage, the default branch, the tag.

Prove the batch branch deploys to stage without issue:

- Deploy the batch branch to the staging environment by dispatching the repository's own
  stage deploy workflow — `gh workflow run <workflow> --ref <batch branch>`, with the
  inputs that workflow declares — and watch it to success with `gh run watch`.
- Then run what the repository itself uses to check stage: an e2e or smoke workflow where
  it has one, otherwise open the URL the staging environment names and confirm it answers.
- A failed deploy or a stage that misbehaves is handled **autonomously, in this order**:
  1. **Roll stage back** to the latest stable release first, so stage is never left broken
     while you debug: the ref of the newest production deployment whose latest status is
     `success` — `gh api repos/{owner}/{repo}/deployments?environment=<production>` and
     each one's `statuses` — dispatched to staging by the same workflow. Watch the rollback
     to success and say in your log what stage is running now.
  2. **Debug from the logs**: read the failed run's own logs with `gh run view <id>
     --log-failed` for the window it failed in — the error, the dependency it names, the
     request that failed. Where this installation keeps application logs somewhere else,
     that is `{{config.renovate.logs}}`; empty means the workflow's logs are all there is
     to read.
  3. **Fix on the batch branch**, push, wait for the pull request's required checks, and
     deploy to stage again, from step one of this list.
     Loop until stage runs the batch branch and its checks pass. The loop is bounded by
     progress, not by a count: a round that changed nothing — the same failure, no new fix,
     or logs that name nothing — is a report of no progress and a consultation with the
     claim held and stage on its stable release. Never leave stage on a broken batch while
     you wait for me.
- Never deploy the batch branch to production, and never merge here.

Then write your Output. `deploy_job` names the workflow run you dispatched. `verified` is
what decides whether anything is merged, so it is true only where you watched the check
pass.

## approval

The batch pull request must be approved by **another team member**; you never approve it
yourself, and its author cannot. Ask once, with your harness's question tool, which is
asked on the Run where a teammate or I answer: name the batch pull request, say it is on
stage and how it was verified, and that it needs an approving review from someone else on
the team — then wait for the answer. On the answer, read
`gh pr view <n> --json reviewDecision,latestReviews,headRefOid`: the batch is approved
when an `APPROVED` review is on its current head by someone other than this Run's own
`gh` login, and `reviewDecision` is neither `CHANGES_REQUESTED` nor `REVIEW_REQUIRED`.
Not approved yet is asked about again, three times at most; then it is a report of no
progress. A push to the batch branch after approval resets it — say so and start this
step's check over.

Then write your Output, naming who approved and the head they approved.

## merge

For an application, the merge is the **batch pull request** alone: verify its approving
review is still on its current head, then merge it with the harness authorising the exact
operation, and then re-read the Renovate pull request list — each one the batch carried
is `closed` by Renovate itself or by you, with the batch as its replacement, and each one
left out ends as `deferred` with my approval or as a finding. The rules below are the
package's, one pull request at a time; the approval, held-branch and outcome rules hold
for both.

Merge the batch one pull request at a time, in the order that makes the fewest
conflicts.

For each one: rebase it on the default branch, fix what the bump broke on **that pull
request's own branch**, push with `git push origin HEAD:<branch>`, wait for its required
checks with `gh pr checks <n> --required --watch`, approve the reviewed head, and only
then merge it. A conflict or a routine dependency-related code or test failure is yours
to fix. Anything larger is a consultation.

An approving review is required **before attempting to merge**. A Renovate pull request
is the bot's, never this login's own, so approve it with `gh pr review <n> --approve`.
Verify with `gh pr view <n> --json reviewDecision,headRefOid` that the approval is on the
head you reviewed and every required review is satisfied, then merge only that head with
`gh pr merge <n> --match-head-commit <head-sha>` and the merge method the repository
allows. Run the approval, approval verification, and merge in a separate shell call each,
so the harness can authorize the exact operation.
Recheck approvals after every push or rebase, because either can dismiss them; review and
approve the new head before retrying a merge. If approval is refused or needs another
eligible reviewer, consult me — never bypass branch protection or try merging first to
discover that approval is missing.

Before you check a branch out, ask git who holds it — `git worktree list` names every
registered worktree and the branch each has checked out. A Renovate branch another
worktree holds is **reported and left alone**: name the branch and the checkout holding
it in your Output, do not override the guard, and do not reach it as a detached
remote-tracking ref instead. If that stops the pull request being merged, consult me and
record the deferral only if I approve it.

Re-read the pull request list before you leave this step: Renovate opens more while you
work, and one opened mid-Run is handled under exactly the same policy as the rest.

Every relevant pull request ends with exactly one outcome:

- `merged` — it is on the default branch.
- `closed` — with the evidence that its change is already on the default branch or in a
  merged replacement, and a link to that replacement.
- `deferred` — with the reason and my approval. A still-needed update is never deferred
  without asking, and never forced through instead.

Attempts per pull request are bounded: three. Reaching the bound is not another attempt,
it is a report of no progress and a consultation.

Then write your Output. Every relevant pull request is in `outcomes` exactly once, by its
number, with the one outcome it ended on and the reason for it.

## release

Read the pull request list once more first — a pull request Renovate opened while you
were merging is handled under the `merge` policy before you tag anything.

If nothing was merged in this Run, create no tag, no release and no workflow run: report
the repository up to date and leave the rest of this step alone. Unrelated untagged
commits are not this Run's to release.

Otherwise:

- Diff the default branch against the previous version tag — **the whole diff**, not only
  the Renovate pull requests — and choose the next version from that and from the
  repository's own versioning conventions.
- Tag annotated. The tag notes are a changelog entry in the shape of changelog-gen: a
  heading `## <version> - <YYYY-MM-DD>`, then only the sections that have entries, in
  this order and under these names — `### Features and Improvements`, `### Bug fixes`,
  `### Miscellaneous` — with one line per change, `- <what changed> [#<n>]`, where the
  pull request reference is the only link. Dependency bumps go under Miscellaneous as
  `- Bump <package> <from> -> <to> [#<n>]`; several bumps of one package fold into one
  line. Write every line from the commit or pull request title, not from the diff, in
  under 100 characters and with no prose around it. Nothing else goes in the notes: no
  summary paragraph, no check or approval detail, no list of what was checked. Write the
  notes to a file and tag from it with `--cleanup=verbatim`, or git strips the `#`
  headers as comments. Push the tag.
- Create a GitHub release with the same notes, verbatim — `gh release create <tag>
  --notes-file <file> --verify-tag` — **only where the repository is a package** that
  publishes from a tag or release. An application or a frontend gets the tag alone.
- Watch the workflow runs the tag started — `gh run list --commit <sha>`, then `gh run
  watch` — until every job has finished, except manual jobs that deploy to production.
  That is what makes this a finished renovation, and Collie holds the Helle claim until
  the forge shows production carries it.
  Production deploy jobs are mine: never play, retry or ask about them. A tag whose
  only unfinished jobs are manual jobs that deploy to production is released; name each in
  `prod_jobs`, with its URL. Judge which jobs deploy to production from the repository's
  own environments. Any other failing or blocked job is a consultation with the Helle claim
  still held — never a Run that calls itself done.

Then write your Output, naming the tag where you made one. `pipeline` says whether the
tag's workflow runs succeeded, were not run, or wait for production.

## record

Write the repository off on the issue `track` bound to — that issue and no other.

Read the description, change only this repository's own line, and write it back. Every
other repository's entry and links stay exactly as they are.

Check the entry off and keep it to at most two lines:

`- [x] <project> — <tag or "no tag">`
`  <one short sentence summarising the dependency changes and any approved exceptions>`

Do not list individual merge requests, outcomes, pipelines or release links. The checklist
only needs the project, tag and a concise summary of what changed.

Where deferrals were approved and everything else succeeded, this Run is
**renovated with exceptions** — say so on the entry and in your Output. An unresolved
blocker is not an exception: leave the entry unchecked and report it as a finding.

Then write your Output, with the status this Run ended on.
