You are reading one day of Collie Runs for what is wrong with the project checked out at
{{checkout}}: what its agents kept tripping over, what they could not find, what its checks
and instructions missed. Nobody is watching this Run, and nobody is asked anything. You
edit nothing; what you find becomes issues on this project's tracker and Improvements.

The project's checkout: {{checkout}}
Collie's state directory on this Machine: {{state}}
The Collie release this Machine runs: {{release}}
The window: the Runs admitted since {{since}}.

## triage

Use {{skill:retro}}.

Where `retro` and this page differ, this page wins:

- **The session is the window's Runs**, listed below. `retro`'s primary sources are only
  each Run's records:
  - `{{state}}/runs/<run id>/`: its audit trail, log, drift, check passes, deliveries
    and parks;
  - `{{state}}/agents/<run id>/`: its launches, prompts and Outputs, with their
    assumptions and disputed findings;
  - the lines of `{{state}}/host.log`, and the News under `{{state}}/herd/`, that name
    one of the window's Runs.

  Read a harness transcript only where one of those records points to it. Never read the
  Flock chat's transcripts, a Run outside the window, another Machine's Runs, or any other
  session log on this Machine.

- **`retro`'s categories are each finding's `category`:** `navigation`,
  `automated-checks`, `coding-standards`, `agents-md`, `tool-economy`, `no-ops` and
  `information-access`. A `coding-standards` finding says in `rule` whether the rule is
  `mechanical`, which wants a deterministic check, or a `judgement` call, which belongs
  to the reviewer's standards.
- **"Present to the user in order of severity" is your Output**, most severe first.
- **What `retro` would change is what you file**, as findings and Improvements. Change
  no file.

{{scope}}

What counts as a finding:

- a defect or a friction in what this project's repository holds, backed by at least one
  Run of the window and the record that shows it;
- recurring: shown by two of the window's Runs, or matching an issue already open.
  Anything else seen once is left out;
- cited: each finding's `records` names a journal line, a verification, a transcript or an
  issue that shows it. A Run's goal, its summary or an agent's Output read back is not a
  record, so a finding that rests only on one is left out.

What is left out, with why, under `left_out`:

- an outage of a service nobody in this repository runs;
- a person's deliberate choice, such as stopping a Run they no longer wanted.

What may reach this project's tracker, in a title, a body and an Improvement:

- what the Runs did, citing Run ids and this repository's own files;
- never a Run's goal, a person's words, an agent's transcript, or another repository's
  name, paths or content. The host redacts credential-shaped values and refuses another
  checkout's paths; write so it has nothing to do.

A Collie fix counts as already fixed only where this Machine's release carries it:
`git merge-base --is-ancestor <commit> {{release}}` succeeds in the checkout, after
`git fetch origin tag {{release}}` where the tag is not there. A fix on the default branch
that the release lacks leaves the finding a live recurrence, filed or commented on as any
other.

Match each finding against every open issue below, whoever filed it, and set `issue` to
the one it is about. An issue whose body carries `<!-- collie-finding: <key> -->` is
that key's finding's issue. Give the same problem the same kebab-case `key` it had before.

At most ten findings. Then group the findings that will be filed new, with no `issue`,
into `improvements`, each one merge request's worth, in the order they should be built.
At most {{bound}} of them are started.

The window's Runs:

{{runs}}

Collie's report of them:

{{report}}

The open issues:

{{issues}}

## checkout

**The window is this project's Runs only.** Collie misbehaving — a Run that failed,
parked, looped, stalled or needed rescue for a reason in Collie rather than in this
repository — is not this project's to file: put it under `left_out`, with the why
"about Collie". A Collie checkout's own `runs=machine` Run reads it again. There is no
`defect` category here.

## machine

**The window is every Run on this Machine**, of any project. `defect` is one more
category: Collie misbehaving, a Run that failed, parked, looped, stalled or needed rescue.
A `defect` needs one Run to be filed. A problem in another project's own code or tests is
left out, with the why "another project's own code".
