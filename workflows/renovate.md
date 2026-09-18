---
name: renovate
title: renovate — merge the month's dependency updates, tag, release and record it
description: Claims the repository in Helle and waits its turn, merges or accounts for every Renovate Bot merge request, tags and watches the release, then checks the repository off the team's shared Renovate issue in Linear.
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
    # The claim is waited for in the runner, so a queue of hours costs no tokens.
    waits: helle
    output: assess.json
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
the operator's, and never bind a branch to this one.

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

This Run now holds the repository in Helle — Collie claimed it and waited for the turn
before this step started — or the repository has no Helle project. Either way the
repository is yours to work in until the Run ends.

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
"consulted": ["what I decided", ...], "up_to_date": true or false}`.

## merge

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
- Tag annotated, with tag notes saying what shipped.
- Create a GitLab release with release notes **only where the repository is a package**
  that publishes from its tag pipeline. An application or a frontend gets the tag alone.
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
