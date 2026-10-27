# Collie files and fixes what its own Runs show is wrong with it

**Status: accepted, to be built.** It needs the forge interface of ADR-0050 to be built first.

Once a day, Collie reads the Runs its Machine admitted that day. It looks for what went
wrong or was slow, and for where a person or an agent had to work around Collie. It files
each new problem as an issue on Collie's own repository, or comments on the open issue it
matches. Then it plans and builds a fix for each new issue, up to a bound, and leaves a
reviewed merge request for a person to merge. This is the `self-improve` Workflow, started
by a [Schedule](0052-a-schedule-is-a-saved-start-its-host-fires.md).

## What was true before

What went wrong in a Run was found only when someone happened to notice it. One day in
October gave five examples:

- `implement`'s merge request step was GitLab-only on a GitHub repository, so no pull
  request was opened.
- A Run parked when Codex showed no readiness within 120 seconds, and resuming it did not
  recover it.
- Branch naming asked gitlab.com for a login from a GitHub checkout.
- A failed Run that was resumed did not retry.
- Follow-ups on stopped Runs were refused.

Each one was found by hand, and filed by hand when it was filed at all. Collie already
recorded what is needed to find them: each Run's audit trail with who asked, its log,
launches, Outputs, drift, check passes, deliveries and parks, plus the host log and
`collie run report --since`.

## Decision

**D1. `self-improve` is a Workflow of Collie's own repository.** It is a project module in
cego/collie's `.collie/workflows/`. It is not shipped to every installation, because it
files on, and builds in, the repository it runs in, and only Collie's own repository can
take its fixes. It runs in a checkout of that repository. It reads only the Runs of the
Machine it runs on, so each Machine whose Runs should be read has its own Schedule.

**D2. It reads one day of that Machine's Runs, through Collie's own records.**

- **Scope:** the Runs admitted in the 24 hours before it started, other than its own Run
  and its Run's children. Earlier `self-improve` Runs and the fixes they started are
  included, so its own failures are evidence too.
- **Starting point:** Collie's report of those Runs.
- **Then, for each Run:**
  - its audit trail, including refused operations and, for a chat's request, the human's
    words;
  - its log, launches and agents' log;
  - its Outputs, including assumptions and disputed findings;
  - its drift, check passes and deliveries;
  - why it parked or stalled.
- **Also:** the host log and the News of the same day.
- **Not read:** a harness transcript is read only where a record points to it. The Flock
  chat's transcripts belong to Desktop and are not read.
- **No Runs:** where that day admitted no Run, it ends at once and starts no agent.

**D3. It files only what the records show, and never the same problem twice.**

- **What counts:** a finding is a defect or a friction in what this repository builds,
  meaning Collie, its Workflows, Personas and docs. It is backed by at least one Run of
  that day and the record that shows the problem.
- **What does not:**
  - a project's own code or tests;
  - an outage of a service Collie does not run;
  - a human's deliberate choice, such as stopping a Run they no longer wanted.
- **Matching:** each finding is matched against every open issue on the repository's
  forge, whoever filed it.
  - A match gets one comment, "seen again", naming the new Runs.
  - Anything else is filed as a new issue that carries the finding's key. An open issue
    that already carries that key gets a comment instead of a second issue.
- **Cap:** at most ten issues are filed or commented on per Run.
- **Forge:** the forge interface gains three operations, in both adapters: listing open
  issues, filing one, and commenting on one.

**D4. What reaches the public repository is about Collie, and only Collie.** An issue, a
comment and the goal of an Improvement describe what Collie did. They cite Run ids and
Collie's own files.

- **Never included:** a Run's goal, a human's words, an agent's transcript, or another
  repository's name, paths or content.
- **Redacted:** credential-shaped values, by the same redaction the Conversation uses,
  before anything leaves the Machine.

**D5. An Improvement is one merge request's worth of issues.** It runs as `plan`
(child of this Run, own Task, `then=implement`) → `implement`.

- **Grouping:** the triager groups the new issues it filed into Improvements. Each is one
  issue, or several that one change should close together.
- **How many:** up to `improvements` start, in the triager's order. It is an Input, 3 by
  default, and 0 files without building. They start together.
- **Each one:** a `plan` child of this Run that is a Task of its own (D6), started with
  `then=implement` (D7). The plan's goal is its issues. `plan` writes the spec and tickets
  without asking and chains `implement`.
- **Review:** `implement` builds the change, reviews it with the pass `review` runs, fixes
  what that review finds, and opens the merge request that closes the issues. No separate
  `review` Run follows: that rally is the review. A standalone `review` would end in a
  menu that nobody is there to answer.
- **What is not built:**
  - issues beyond the bound stay filed;
  - a finding that matched an issue already open is commented on and never built, because
    that issue may already be someone's work.
- **The end:** the Run waits for its Improvements, then ends with a summary in its
  directory. The summary lists each issue filed or commented, each Improvement's Run and
  how it ended, and each finding left out, with the reason.

**D6. A child can be work of its own.** A parent can start a child as a Task of its own,
with its own workspace and its own card. The label is inferred from its work, as any fresh
start's is. It is still the parent's child: stopping or resuming the parent reaches it,
the parent waits on it, and it is in the parent's Lineage. Without that option a child is
in its parent's Task, as before. The Improvements need this: each is a merge request a
person merges, so each needs its own card and its own Ready to release.

**D7. `plan` can be told to build without asking.** `plan` takes the Input `then`.

- **`implement`:** the planner is told that nobody is watching. It decides each open
  question itself and records it under `decided`. The end menu is not asked: the plan
  chains `implement` as Implement now would. A plan whose tickets cannot be built fails
  the Run, with the reason, rather than parking at a menu nobody reads.
- **Empty:** the menu works as it does today.

A person can ask for this too: "plan this and build it, don't ask me."

**D8. What bounds it is work, and the one yes is the merge.**

- **What bounds it:** at most `improvements` per Run. A Schedule never starts a Run while
  its last one is still going (ADR-0052 D5). So at most one day's Improvements are in
  flight at once.
- **Usage and cost:** recorded and never enforced (invariant 8). An Exhausted Subscription
  only moves work along the fallback chain
  ([ADR-0049](0049-work-goes-to-an-agent-with-usage-left.md)).
- **No yes in between:** nobody is asked before an issue is filed, a plan is written or an
  implementation starts. Such a yes would protect nothing, because nothing lands without
  the merge.
- **The merge:** the person's. Collie never merges and never turns on auto-merge.
  `implement` already refuses to push to a merge request that has auto-merge on. Each
  merge request is its Task's card, and is Ready to release once its checks pass.

## Consequences

- Collie's own failures turn into issues, and then into reviewed merge requests, without
  anyone filing them.
- Every fix still goes through a human merge. That covers a change to `self-improve`
  itself, or to the Schedules that start it.
- A day with many problems gives up to ten filed or commented issues and up to
  `improvements` merge requests. More waits for a later day, or for a person.
- An Improvement that fails or parks is its own card, waiting on a person. Its
  `self-improve` Run waits on it, and so does the next day's occurrence.
- Not decided here: reading the Flock chat's transcripts, reading other Machines' Runs from
  one place, and retrying a failed Improvement by itself.

## Amended 2026-10-12: the triage follows the `retro` skill

The human asked for Matt Pocock's `retro` skill in this flow, to find recurring problems
and optimizations in the day's agent Outputs and logs, not only failed Runs.

- Installed, like every skill
  ([ADR-0005](0005-skills-float-and-are-not-pinned.md)): `retro` and the
  `writing-for-agents` skill it reads come from `mattpocock/skills` through `prepare.sh`
  and `collie upgrade`, and float with them. Nothing is copied into the repository, and
  nothing pins them. The `retrospective` Persona names `{{skill:retro}}`, which Collie
  renders as the installed `SKILL.md` to read and follow, so upstream marking it
  user-invoked does not matter: this flow invokes it on the human's explicit request.
  A Machine without it fails the Run before any agent starts.
- The Workflow's Markdown adapts it and wins where the two differ: the session is the
  day's Runs (D2), its categories become each finding's, a `defect` category covers Collie
  misbehaving, its presentation becomes the Output, and what it would change becomes
  issues and Improvements. A finding other than a `defect` must recur, in two Runs or on
  an issue already open, to be filed.

## Amended 2026-10-15: a shipped Workflow for any project

The human asked for `self-improve` to serve every project, not only Collie's.

- **D1 becomes: `self-improve` is a shipped Workflow for any project.** It lives in the
  installation's `workflows/`, with the `retrospective` Persona in `personas/`, and files
  and builds in the checkout it runs in. The reasoning that it is not shipped to every
  installation is withdrawn: any repository can take fixes for what its own Runs show.
  Like every shipped Workflow, it decides nothing from the project's name or remote.
- **D2's scope is the `runs` Input**, which is required and never inferred:
  - `checkout` reads the Runs whose project is the checkout it runs in. Nothing about
    another project reaches its triage, and Collie misbehaving is left out as "about
    Collie".
  - `machine` reads every Run on its Machine, and alone files `defect`s.
- **Collie's own daily Schedule is the `runs=machine` one**, in a Collie checkout, so
  Collie's bugs seen in any project's Runs are filed on Collie's tracker.

## Amended 2026-10-15: a worktree of its own

The checkout a Schedule starts it in is shared with other Runs, and may be dirty or behind
its remote, so a Run working there could collide with other work or triage stale code.

- **It works in a roaming checkout** (`checkout: "roaming"`), as `renovate` does: the host
  fetches `origin` and cuts a worktree detached at the default branch from the checkout it
  was started in, before the Run exists. Triage, filing and its Improvements' `plan` Runs
  all work from there. An `origin` that will not fetch refuses the start rather than
  cutting the worktree from a stale base. A Run of that repository that has not ended and holds one of
  its roaming checkouts refuses the start, as it refuses a second `renovate`. A roaming checkout an
  ended Run kept work in is passed over
  ([ADR-draft-a-kept-roaming-checkout-is-passed-over](draft-a-kept-roaming-checkout-is-passed-over.md)).
- **The Runs it reads are still that checkout's.** A Run's project is where it was started,
  not where it was placed, so `runs=checkout` and the Schedule's saved start are unchanged.
- **The cleanup sweep removes the worktree** once the Run has ended, succeeded or failed,
  and nothing is working in it: an Improvement still running there keeps it, and a failed
  Run, which the next roaming start would take over from anyway, does not
  ([ADR-0045](0045-collie-removes-what-it-made-once-nothing-needs-it.md)).
