# ADR-0029: One host acts for a Run, and a workflow's name decides nothing

Status: accepted. Supersedes ADR-0004's per-Run inbox and its refusal of a daemon and
SQLite, ADR-0008's "the Driver is the only actor over agents", and ADR-0010's D1, "freeze
the definition per Run". The rest of each stands.

## Context

Three earlier decisions were written about a detached process per Run. ADR-0004 kept Run
state in files a Driver owned and fed through an inbox. ADR-0008 made that Driver the only
thing that could act on a Run's agents. ADR-0010 froze the resolved Markdown workflow into
the Run so a resume could not run different code. ADR-0027 removed that process and its
engine, but those three still read as current.

The release gate also asks a question the per-Run design never had to: whether a workflow
behaves the same whatever it is called. Collie used to classify work by name — a Run
called `plan` was ready to implement, `implement` and `renovate` were the ones that got a
checkout, and tabs were sorted `plan`, `implement`, `review`.

## Decision

**The host is the one actor over a Run.** It is the process that owns a state directory
(ADR-0015), the only thing that starts, answers, holds, stops or steers a Run, whichever
door the request came in by (ADR-0021). What ADR-0008 decided about agents stands with the
host in the Driver's place: one Dispatcher sends, a reservation is written before herdr is
called, submitted, acknowledged and verified are separate facts, and a claim nobody can
read is `unknown`, never permission.

**A resume runs current code, not a frozen copy.** Recovery re-enters the module as it is
now and reuses every Activity already done. An unchanged workflow loses nothing; one whose
shape changed has no seamless-resume promise, and one whose module is missing waits with
its file named (ADR-0014, ADR-0016). What ADR-0010 decided about evidence stands: a
verification is collected against a revision, an Output field is a claim, and usage is
recorded and never enforced.

**A workflow's name decides nothing in Collie.** Cards come from facts, offers from the
module's own declaration, a checkout from its metadata, and tabs from start order. A
module composes by id — plan starts `implement` — and that is ordinary. The generic
runtime and the board are read for name-based dispatch by `test/workflow-names.test.ts`,
which also plants the old plan and renovate classification back into the files it lived
in to prove it would be caught. Every shipped scenario in `test/baseline.test.ts` runs a
second time, saved as a user's entry under an id that shares nothing with the shipped one,
and has to pass unchanged.

**A control does only what it says.** A hold is released by a human: nothing in the host
lifts one at a time, so neither `run hold` nor `collie_hold` takes one.

## Consequences

- The Driver, its inbox, its ownership claim and the frozen snapshot appear only in
  history: `src/history.ts` reads what they left, and nothing else does.
- Some of what the per-Run process did has no counterpart yet, and the docs say so rather
  than describe it: a Run of a module carries no Intent, so nothing checks it for drift;
  nothing sends the per-Run notifications; and tabs carry no state glyph.
- A name-based rule reintroduced anywhere in `src/` fails the suite before it ships, and a
  behaviour that depends on a shipped id fails the renamed baseline pass.
