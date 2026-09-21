---
name: renovate
title: renovate — merge the month's dependency updates, tag, release and record it
description: Assesses every Renovate Bot merge request, gathers an application's into one batch branch proven on stage under the Helle claim and approved by a teammate, merges, tags and watches the release, then checks the repository off the team's shared Renovate issue in Linear.
# Detached at the default branch and roaming across the Renovate branches it merges,
# so no branch of the repository is bound to this Run's worktree.
checkout: roaming
inputs:
  # Paste a GitLab URL or enter an existing local checkout.
  # Collie caches a URL clone, then cuts the Run's own detached checkout from it.
  repository: gitlab-repository
  # The Linear team whose shared Renovate issue this Run records itself on. Empty falls
  # back to `linear.team` in your config, so nothing team-specific lives in the baseline.
  team: optional
  # The team's shared Renovate issue when the operator already knows it, so track never
  # has to ask which of several it is.
  issue: optional
steps:
  - id: track
    persona: renovate
    # One agent for the whole run, so its model is named once, here.
    model: default
    effort: medium
    # Keep Claude Code's configured auto mode; this agent is reused by every later step.
    permissions: harness
    output: track.json
  - id: assess
    persona: renovate
    agent: track
    output: assess.json
  # An application's updates land together: one batch branch, one merge request.
  - id: batch
    persona: renovate
    agent: track
    output: batch.json
  # The first step that touches anything shared, so the claim is taken here. Waited for
  # in the runner, so a queue of hours costs no tokens.
  - id: stage
    persona: renovate
    agent: track
    waits: helle
    output: stage.json
  - id: approval
    persona: renovate
    agent: track
    output: approval.json
  - id: merge
    persona: renovate
    agent: track
    output: merge.json
  - id: release
    persona: renovate
    agent: track
    output: release.json
  - id: record
    persona: renovate
    agent: track
    output: record.json
---

Repository checkout or GitLab URL (empty means the workspace this run started from): {{inputs.repository}}
Linear team (empty means `{{config.linear.team}}`): {{inputs.team}}
Linear Renovate issue (empty means find it): {{inputs.issue}}
This run's checkout: {{cwd}}
This run's directory: {{run.dir}}

This checkout is the Run's own, detached at the repository's default branch. Collie made
it before you started and removes it when it is settled: never create one, never switch
the operator's, and never bind a branch to this one — except the batch branch the `batch`
step makes for an application, which is the one branch this checkout may hold.

A **package** publishes from its tag pipeline and is deployed by nobody; an
**application** has deploy jobs or GitLab environments (stage, prod) of its own. `assess`
decides which this repository is, and the `batch`, `stage` and `approval` steps are for
applications only: for a package each of them writes its Output with `"skipped":
"package"` and does nothing else.

## track

Find the team's shared Renovate issue with the Linear MCP, before anything touches the
repository, so that work in progress is visible from the moment it starts.

- The team is the one named above. If both the input and the config value are empty, ask
  me which team, once, and say in your Output that you did.
- An issue named above is the issue: read it and skip the search.
- Otherwise search that team's open issues for the Renovate issue — the one the team
  checks repositories off on, whatever it is called.
- Exactly one match is the issue. Several is a consultation: list them with their ids,
  titles and due dates, and ask me which. None means you create one, titled for the
  current month, whose description is the checklist and nothing else.
- Record its id in your Output. Every later step writes to that issue and no other, so a
  long Helle wait, a resume or a cycle rollover cannot split this repository across two.

Then append this repository to the issue's checklist, unchecked, as
`- [ ] <repository name>` — read the description, add your line, write it back. Never
rewrite a line you did not add: other Runs are appending to the same description.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "issue": "<id>",
"issue_url": "<url>", "team": "<team>", "repository": "<name>", "created_issue": true or
false}`.

## assess

Nothing shared is touched yet: no Helle claim is held, so read only. Merging, deploying
and tagging wait for the claim that `stage` takes.

Decide first whether this repository is a package or an application: read its
`.gitlab-ci.yml` and `glab api projects/<id>/environments`. Deploy jobs or a `staging` or
`production` environment make it an application; a publish job on tags and no deploy makes
it a package. Say which in your Output, with the evidence.

List every open merge request authored by Renovate Bot on this project with `glab`, and
assess the whole batch **before merging any of them**. For each one: what it bumps, from
what to what, what its release notes actually say, and whether landing it needs code or
configuration changes here.

Judge on release notes and compatibility, never on the version number. A major version
bump on its own is routine and is not a consultation. A **substantial or breaking code or
configuration migration** is: stop, say which merge request, what the migration is, and
what it would cost, and wait for my answer. That is the point of assessing the batch
first — I hear about it before half of it is already on the default branch.

An empty batch is a finished Run in waiting: report the repository up to date, and
expect `release` to create no tag at all.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "issue":
"{{outputs.track}}'s issue", "merge_requests": [{"iid": 1, "title": "...", "bumps":
"pkg 1 -> 2", "needs": "nothing | what it needs", "risk": "routine | migration"}],
"consulted": ["what I decided", ...], "up_to_date": true or false, "is_package": true or
false, "kind_evidence": "what said so"}`.

## batch

For a package, or an empty batch, write `{"verdict": "clean", "findings": [], "skipped":
"package" or "up to date"}` and stop.

For an application, gather every relevant merge request into **one batch branch**, so the
whole month's change is proven on stage once and reviewed once, instead of landing on the
default branch one bump at a time.

- Branch `renovate/batch-<YYYY-MM-DD>` from the default branch's current head, in this
  checkout, and bind it here — this is the one branch this checkout may hold.
- Before you take a Renovate branch in, ask git who holds it: `git worktree list` names
  every registered worktree and the branch each has checked out. A branch another worktree
  holds is **left out and reported**, not merged from its remote-tracking ref either.
- Merge each remaining Renovate branch into the batch branch, in the order that makes the
  fewest conflicts, with `git merge --no-ff origin/<branch>`. Fix what the bump broke on
  the batch branch: a conflict, a call site, a failing test. Anything larger is a
  consultation.
- Run the repository's own install, lint, typecheck and tests on the batch branch before
  you push it. Push with `git push -u origin renovate/batch-<date>`.
- Open one merge request from the batch branch to the default branch with `glab mr create --assignee mk`,
  assigned to yourself, titled `Renovate batch <YYYY-MM-DD>`, whose description lists every
  Renovate merge request it carries as `- <what it bumps> (!<iid>)` and every one it left
  out with why. Wait for its pipeline's required checks and fix failures on the batch
  branch. Never force-push it.
- Leave the individual Renovate merge requests open: Renovate closes them itself once the
  batch is on the default branch, and `merge` accounts for any that stay open.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "mr_url": "<batch merge
request url>", "branch": "renovate/batch-<date>", "included": [1, 2], "left_out": [{"iid":
3, "why": "held by <checkout>"}], "consulted": ["what I decided", ...]}`.

## stage

This Run now holds the repository in Helle — Collie claimed it and waited for the turn
before this step started — or the repository has no Helle project. Either way the shared
things are yours until the Run ends: stage, the default branch, the tag.

For a package, write `{"verdict": "clean", "findings": [], "skipped": "package"}` and stop.

For an application, prove the batch branch deploys to stage without issue:

- Run the stage deploy of the batch merge request's pipeline — the manual `stage` deploy
  job, played with `glab api -X POST projects/<id>/jobs/<job id>/play` — and watch it to
  success.
- Then run what the repository itself uses to check stage: an `e2e-stage` or smoke job where
  the pipeline has one, otherwise open the stage URL the deploy job's environment names and
  confirm it answers.
- A failed deploy or a stage that misbehaves is handled **autonomously, in this order**:
  1. **Roll stage back** to the latest stable release first, so stage is never left broken
     while you debug: the newest tag whose `prod` deploy succeeded — `glab api
projects/<id>/deployments?environment=<prod>&status=success&order_by=created_at&sort=desc&per_page=1`
     names its ref — and its pipeline's `stage` job, played or retried. Watch the rollback
     to success and say in your log what stage is running now.
  2. **Debug from the logs**: read stage's application and pipeline logs in Kibana with the
     `cego:searching-production-logs` skill, or `kibana.cego.dk` directly, for the window of
     the failed deploy — the error, the dependency it names, the request that failed.
  3. **Fix on the batch branch**, push, wait for the merge request's checks, and deploy to
     stage again, from step one of this list.
     Loop until stage runs the batch branch and its checks pass. The loop is bounded by
     progress, not by a count: a round that changed nothing — the same failure, no new fix,
     or logs that name nothing — is a report of no progress and a consultation with the
     claim held and stage on its stable release. Never leave stage on a broken batch while
     you wait for me.
- Never deploy the batch branch to production, and never merge here.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "deploy_job": "<url>",
"verified_by": "e2e-stage | smoke | manual check", "verified": true or false, "attempts": 1,
"rollbacks": [{"to": "<tag>", "why": "<what failed>", "fixed_by": "<commit>"}]}`.

## approval

For a package, write `{"verdict": "clean", "findings": [], "skipped": "package"}` and stop.

For an application, the batch merge request must be approved by **another team member**;
you never approve it yourself, and its author cannot. Ask me, once, in this pane: name the
batch merge request, say it is on stage and how it was verified, and that it needs an
approval from someone else on the team — then wait for my answer. On the answer, read
`glab api projects/<id>/merge_requests/<iid>/approvals`: the batch is approved when
`approvals_left` is 0 and an approver is not this Run's own GitLab user. Not approved yet
is asked about again, three times at most; then it is a report of no progress. A push to
the batch branch after approval resets it — say so and start this step's check over.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "approved_by":
["<username>"], "head_sha": "<sha approved>"}`.

## merge

For an application, the merge is the **batch merge request** alone: verify its approvals
are still on its current head, then merge it with the harness authorising the exact
operation, and then re-read the Renovate merge request list — each one the batch carried
is `closed` by Renovate itself or by you, with the batch as its replacement, and each one
left out ends as `deferred` with my approval or as a finding. The rules below are the
package's, one merge request at a time; the approval, held-branch and outcome rules hold
for both.

Merge the batch one merge request at a time, in the order that makes the fewest
conflicts.

For each one: rebase it on the default branch, fix what the bump broke on **that merge
request's own branch**, push with `git push origin HEAD:<branch>`, wait for its required
checks, approve the reviewed head in GitLab, and only then merge it. A conflict or a
routine dependency-related code or test failure is yours to fix. Anything larger is a
consultation.

GitLab approval is required **before attempting to merge**. Read the merge request's
current head SHA and approve it with `glab mr approve <iid> --sha <head-sha>`. Verify the
approval was recorded and all required approval rules are satisfied before the merge
command. Run the approval, approval verification, and merge in a separate shell call
each, so the harness can authorize the exact operation.
Recheck approvals after every push or rebase, because either can reset them; review and
approve the new head before retrying a merge. If approval is refused or needs another
eligible reviewer, consult me — never bypass approval rules or try merging first to
discover that approval is missing.

Before you check a branch out, ask git who holds it — `git worktree list` names every
registered worktree and the branch each has checked out. A Renovate branch another
worktree holds is **reported and left alone**: name the branch and the checkout holding
it in your Output, do not override the guard, and do not reach it as a detached
remote-tracking ref instead. If that stops the merge request being merged, consult me and
record the deferral only if I approve it.

Re-read the merge request list before you leave this step: Renovate opens more while you
work, and one opened mid-Run is handled under exactly the same policy as the rest.

Every relevant merge request ends with exactly one outcome:

- `merged` — it is on the default branch.
- `closed` — with the evidence that its change is already on the default branch or in a
  merged replacement, and a link to that replacement.
- `deferred` — with the reason and my approval. A still-needed update is never deferred
  without asking, and never forced through instead.

Attempts per merge request are bounded: three. Reaching the bound is not another attempt,
it is a report of no progress and a consultation.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "outcomes": [{"iid": 1,
"url": "...", "outcome": "merged | closed | deferred", "reason": "...", "replacement":
"<url or empty>"}], "held_branches": [{"branch": "...", "held_by": "<checkout>"}],
"consulted": ["what I decided", ...]}`.

## release

Read the merge request list once more first — a merge request Renovate opened while you
were merging is handled under the `merge` policy before you tag anything.

If nothing was merged in this Run, create no tag, no release and no pipeline: report the
repository up to date and leave the rest of this step alone. Unrelated untagged commits
are not this Run's to release.

Otherwise:

- Diff the default branch against the previous version tag — **the whole diff**, not only
  the Renovate merge requests — and choose the next version from that and from the
  repository's own versioning conventions.
- Tag annotated. The tag notes are a changelog entry in the shape of changelog-gen: a
  heading `## <version> - <YYYY-MM-DD>`, then only the sections that have entries, in
  this order and under these names — `### Features and Improvements`, `### Bug fixes`,
  `### Miscellaneous` — with one line per change, `- <what changed> [!<iid>]`, where the
  merge request reference is the only link. Dependency bumps go under Miscellaneous as
  `- Bump <package> <from> -> <to> [!<iid>]`; several bumps of one package fold into one
  line. Write every line from the commit or merge request title, not from the diff, in
  under 100 characters and with no prose around it. Nothing else goes in the notes: no
  summary paragraph, no pipeline or approval detail, no list of what was checked. Write
  the notes to a file and tag from it with `--cleanup=verbatim`, or git strips the `#`
  headers as comments.
- Create a GitLab release with the same notes, verbatim, **only where the repository is a
  package** that publishes from its tag pipeline. An application or a frontend gets the
  tag alone.
- Watch the tag's pipeline, including its publish or deploy jobs, until it succeeds. It
  succeeding is what makes this a finished renovation. A failing or blocked job is a
  consultation with the Helle claim still held — never a Run that calls itself done.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "version": "<tag or
empty>", "tagged": true or false, "release_url": "<url or empty>", "is_package": true or
false, "pipeline": "succeeded | not run", "up_to_date": true or false}`.

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

Then write the Output JSON: `{"verdict": "clean", "findings": [], "issue": "<id>",
"issue_url": "<url>", "checked_off": true or false, "status": "renovated | renovated with
exceptions | up to date", "exceptions": ["what was deferred and why", ...]}`.
