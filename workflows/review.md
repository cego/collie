Review target: {{inputs.target}}
Project root: {{cwd}}
Spec: {{inputs.plan}}
Outcome the change has to prove (not given means unclassified): {{inputs.outcome}}

A note you hand on — to a later step, another agent or a human — goes in
`{{run.dir}}/handoffs/`, never `/tmp`: the Run's record lists it, and it is kept as long
as the Run is.

Read the target first:

- `mr:<project>!<iid>` or `mr:github.com/<owner>/<repo>#<n>` — a {{mr.forge}} {{mr.noun}}.
  The project is part of the target, so you do not need a checkout of it: `{{mr.diff}}`
  for the change and `{{mr.view}}` for the description. An older target is a bare
  `mr:<iid>`, which means the merge request of the project you are standing in.
- `branch:<base>...<head>` — `git diff <base>...<head>`.
- `worktree`, or no target — the change in front of you: `git status` and `git diff HEAD`
  for uncommitted work, and `git log --oneline {{base}}..HEAD` plus `git diff
  {{base}}...HEAD` for commits this branch has that the default branch does not.

The spec above is a directory when this review has one: read `SPEC.md` and the tickets
in `issues/` and hold the change to them. When it is not given, no spec was handed to
this review, and the spec axis says exactly that.

## review

Iteration {{iteration}} of at most {{max_iterations}}.

{{previous.review}}

The first review of a change — iteration 1, with no earlier review above — is the
comprehensive one: both review skills, the whole spec, the whole change, and the code
around it. A later iteration is a follow-up, and so is any review with an earlier review
above it: do not run the full review skills again over the whole change. The previous
round's review is at `{{run.dir}}/review.md` and the implementer's account of it — what
it fixed, what it disputed, what it checked — is its Output at `{{previous.fix}}`. Check each of its
findings against the code as it is now and say what happened to it — still there,
changed but not fixed, or fixed. Then review what has changed since that review, and the
callers and tests the fixes touched, and raise what is new. A finding you carry forward
is the same finding: keep its file and title unless the code moved under it.

Review against the project's own standards too — `CLAUDE.md`, `README.md` and the code
around the change. Of `CONTEXT.md`, read only the entries for the terms the diff touches,
never the whole glossary.

Every finding has one of three severities: `blocker` (wrong, unsafe, or breaks a
contract), `major` (will bite us), `minor` (worth fixing, not worth blocking). Only `minor`
lets a change ship without another fix, and a severity outside the three blocks.

A Tautology is a finding. It is a `blocker` where it is the only proof of a criterion or a
promised check, which is then unproved, and a `minor` otherwise, with comments grouped as
your comment rules say.

Where a finding is one instance of a class of bug, list every instance of it in the diff
in that finding, or say there is no other.

{{risks}}

Every `blocker` and `major` says **where** and **why**: a `file` it is at, and a `detail`
of one or two sentences saying what goes wrong and what it costs. A blocking finding
without both is not actionable, and Collie will send it back rather than put it in front
of the implementer. The file need not be one the change touched — an unchanged caller this
change breaks, or a file that should exist and does not, is exactly the kind of blocker
worth raising; name the file it is about and say why the change puts it wrong.

You may be the only reviewer of this change, in which case your review is the review the
human reads: write `summary` — two sentences, what this change does and what is wrong with
it — and `public_summary` for the MR's audience, describing only repository concerns in
ordinary words. Write `dropped`: findings you withdraw with a `reason`, or `[]` where there are none, and
`fixed`: each finding of the review above that you verified was corrected, as
`{"file": "path", "title": "its title", "note": "how it was fixed"}`, alongside the fields
below. Write them whether or not anyone else is reviewing; they cost a line and they are
what makes your review readable on its own.

Already disputed — the implementer looked at these and did not apply them, with reasons:

{{disputed}}

Check the disputed reason against the code, requirements and recorded decisions. If it
holds, withdraw the finding under `dropped` with its exact file and title and a `reason`
explaining why you accept it. If the finding has since been corrected, record it under
`fixed`. If the reason does not hold, raise the finding with a `rebuttal` that answers it;
that puts it back in front of the implementer. If you cannot decide, keep it under
`disputed` for the human. An omitted finding or a clean verdict alone does not settle a
dispute. A finding still in `findings` or `disputed` remains unresolved even if you also
list it as dropped or fixed.

The checks already recorded for this Run, the latest of each — `by collie` is one Collie
ran itself, `by agent` one an agent ran through the collector:

{{checks}}

Read these rather than running them again. `collie verify` answers a command already
recorded on this tree with that record; `--again` reruns it, only to look for a flake. Run
only targeted checks — the test file or command that confirms or refutes a finding — and
never the whole suite.

Each check says whether a failing run of the same command was recorded on an earlier tree.
The failing-first rule applies only to checks recorded for a Run that built this change.
For those checks, a new test never seen failing is an internal finding: nothing shows it can fail.
For an MR no Run built, raise no finding about missing failing-first evidence.

Mark a finding `"internal": true` when it exists only because of Collie's own process,
such as missing Run evidence or a Tautology phrased in Collie's terms. Keep it in the
review; it still blocks approval. Public findings about test strength or comments use
ordinary words and cite the target repository's own testing or comment convention.

Where you run something to check a finding, run it through the collector so the result
is bound to the tree you checked it on: `collie verify -- <command>`; Collie records the result
against the tree it ran on, and only that is a verification — an Output that says the
tests pass is a claim. Say in your Output which verifications you ran, by name.

A `collie verify` you started in the background is reported to you when it ends,
so you may end your turn waiting on it. Never end a turn waiting on any other
background job.

{{criteria}}

### Your judgement on the outcome

The outcome above decides one extra field in your Output, a boolean that only a reviewer
can honestly give. Write the one that applies and none of the others; an unclassified
change (empty outcome) or a `bug` needs none — its proof is a verification, not your word.

- **feature** — `"scope_met": true` when every ticket in the spec is built, as the spec
  describes it, and nothing the spec asked for is missing or left to a follow-up.
- **refactor** — `"behavior_preserved": true` when the observable behaviour is identical:
  same inputs, same outputs, same errors, and the tests that pinned it are unchanged.
- **investigation** — `"supported": true` when the conclusion in the run's
  `plan/INVESTIGATION.md` follows from the evidence it cites, and that evidence is in the run.
- **docs** — `"accurate": true` when the instructions match what the code does, and the
  commands they show were run and passed as verifications.
- **migration** — `"compatible": true` when it goes both ways and the code on either side
  of it still reads the data.
- **performance** — both `"behavior_preserved": true`, as for a refactor, and
  `"measurement_valid": true` when the benchmark measures what the change claims to speed
  up, on cases a user meets, and nothing in the change only games it.

`true` is a judgement you can defend from the diff. Where you cannot, write `false` and
say why in a finding: the run will not open its merge request until it is settled, and
that is the point of the field. Never omit it to be kind.

{{obstacle}}

Change nothing outside your Output file.

## synthesize

The reviewing is done; do not run the review skills again. Every reviewer has written
their own review of this change:

{{fan_in}}

Read all of them, then read the target yourself, and write the one review this change
gets — the review a careful colleague would leave on it.

{{obstacle}}

{{previous.review}}

The implementer's carried disputes are:

{{disputed}}

Account for each: keep it unresolved, verify a correction under `fixed`, or accept the
reason under `dropped` with the same file and title and your reason. Read the reviewers'
withdrawals and the target before accepting one. A clean verdict or omission alone does
not settle a dispute; do not list an accepted dispute under `disputed` as well.

Where a review of this target appears above, every finding it raised is accounted for:
carried with its own words if it is still there, or listed under `fixed` if it is not.
The human is watching a rally, not a new list every time.

- One entry per problem. Where two reviewers found the same thing, say it once, in
  whichever of their words is clearer.
- A finding the previous review raised keeps the same file and title when the problem is
  the same: that is how Collie tells a round that fixed nothing from one that moved. Give
  a finding new words only when the problem is genuinely new.
- Every finding has one of the three severities. Anything else is treated as blocking.
- Where they disagree, settle it against the diff. A finding only one of them raised
  survives only if you can defend it from the diff yourself.
- A finding that only repeats the goal or the diff is dropped: it tells the human nothing
  they cannot read for themselves.
- Everything you do not carry goes in `dropped` with a one-line `reason`. Nothing is
  dropped silently.
- Order the findings `blocker`, then `major`, then `minor`.
- Each finding is one or two plain sentences, with the `file` and `line` it is at. Say
  what goes wrong and what it costs. Never say which model or which skill found it.
- `summary` is two sentences: what this change does, and what is wrong with it.
- `public_summary` is for the MR's audience, in the human's voice, describing only
  repository concerns. It names no Collie process. With no public concern, say so.
- Mark findings that exist only because of Collie's process `"internal": true` and keep
  them in `findings`. Public findings use ordinary words and cite the repository's own
  convention for concerns about test strength or comments. Classifying a finding as
  internal never withdraws it or clears it for approval.
- A finding that arrives with a `"rebuttal"` keeps it word for word. It answers a
  dispute the implementer has already made, and dropping it would end that argument
  without anyone deciding it.
- Do not edit files, commit, push, or comment anywhere. This Output is the whole job.
- The outcome field: where the outcome above names one (`scope_met`, `behavior_preserved`,
  `supported`, `accurate`, `compatible`, or `measurement_valid` beside `behavior_preserved`,
  as the review step's own section lists them),
  carry it as `true` only when every reviewer that wrote it wrote `true` and you can defend
  it from the diff yourself. Otherwise `false`, with the finding that says why.

Then write the Output JSON: `{"verdict": "clean" | "findings", "summary": "two
sentences", "public_summary": "for the MR's audience", "findings": [{"file": "path", "line": 12, "severity": "blocker|major|minor",
"title": "one line", "detail": "what goes wrong and what it costs", "rebuttal": "kept
from the reviewer that wrote it", "internal": false}], "dropped": [{"file": "path", "severity": "minor",
"title": "what one reviewer raised", "reason": "why it did not survive"}],
"fixed": [{"file": "path", "title": "what the last review raised", "note": "how it was
fixed"}]}`, plus the one outcome field where the outcome names one.

## fix

The review is written and you are fixing it, in this run, on this target. The findings
are `{{run.dir}}/review.md`, and the same findings as JSON are
`{{run.dir}}/findings.json`. Worst severity first.

You are in `{{cwd}}`, the checkout of `{{branch}}` the review was pointed at. Commit
there, and check out nothing else: this checkout is this Run's own, and what its checks
are bound to.

This is fix round {{iteration}} of at most {{max_iterations}}. The findings to act on:

{{findings}}

Already disputed, for the next review to reconsider against your reason:

{{disputed}}

Apply the findings you agree with and commit them. A finding you believe is wrong is not
silently skipped: record it under `disputed` with your reason, and the human sees it. Run
the typecheck and the test files you touched, each through
`collie verify -- <command>`, and never the whole suite.
Say what you ran: what Collie watched is a verification, and anything else is a claim.

A `collie verify` you started in the background is reported to you when it ends,
so you may end your turn waiting on it. Never end a turn waiting on any other
background job.

At the end of the round, where `{{branch}}` has an open merge request (a pull request on
GitHub), push this round's commits to it: a plain push, never forced. A rejected push is
reported, never retried with force — someone else's commits may be on that branch. Collie
checked before this round started that it does not merge itself once green. Where
`{{branch}}` has no open merge request, do not push.
Never open or edit a merge request, and never comment anywhere. Report `"pushed"` and the
`branch` your commits are on, so a local-only result is never mistaken for a landed one.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "fixed": ["what you
changed", ...], "disputed": [{"file": "path", "severity": "minor", "title": "the
finding", "detail": "why I disagree"}], "commits": ["<subject>", ...], "branch":
"<branch>", "pushed": true, "tests": "what you ran and what it said"}`.
