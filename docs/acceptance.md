# Acceptance: proving the experience, not the suite

0.8.0 shipped with 1191 tests passing and a Home whose conversation composer was hidden
behind a `:` keypress, whose untargeted message was dropped on the floor, and whose
conversation was filtered to the selected Run. Every one of those is a promise the
product makes and none of them had a check, so a green suite was silent about all three.

This page is the answer to that: a list of the promises in the words a person would use,
each with the thing that would prove it, and a command that says which are proved **at
this revision**. It is not a second test suite. It is the index from promise to evidence,
and the refusal to call an unproved promise kept.

## Running the gate

```sh
bun run acceptance
bun run acceptance --evidence operator-evidence.json
```

It prints one row per check and exits non-zero when a check fails. Missing manual
observations stay `PENDING` without blocking development; they are not counted as passes.
The registry is
`CHECKS` in [`tools/acceptance.ts`](../tools/acceptance.ts) — one entry per promise, with
its owner, the layer that can settle it, and its proof.

| State     | What it means                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------------- |
| `PASS`    | The proof ran at this revision, reaches the layer the statement is about, and passed.                                 |
| `FAIL`    | The proof ran and failed. The promise is broken.                                                                      |
| `PENDING` | Nothing that settles the statement ran — including a proof that only reaches a layer beneath it. The note says which. |

`PENDING` is not `PASS`. The summary keeps that distinction. You do not need to collect
manual sign-offs to make the command succeed, and success does not certify pending checks.

### A proof only settles a statement at its own layer

This is the rule the registry got wrong on its first draft, and getting it wrong
reproduces exactly the false confidence the gate was built to end. Three layers:

| Layer      | What it reaches                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `backend`  | A service, a journal, a pure function. Silent about whether any front door calls it.                |
| `ui`       | The key handler, state machine or rendered region a person touches. Reaches the backend beneath it. |
| `operator` | What only a person at a terminal can see: a live process, a restart, an agent's own state.          |

The worked example is the one that caught us. `operations.steer` with no target answered
about the whole flock and refused to become a proposal — a backend test proved it, and it
was true in 0.8.0. In that same release the Home's composer dropped a message typed with no
row selected, so the question never reached the backend that answered it well. A backend
pass standing in for the front-door promise read as green over a feature nobody could use.

The conversation is a native harness now ([ADR-0011](adr/0011-the-conversation-is-a-native-harness.md)),
and the same rule decides its rows. That a harness starts is a `backend` fact. That a
person can type into it and be answered is an `operator` one, and `tools/chat-live.ts` is
what makes it — against the real pane, in a disposable Herd. Three defects were found that
way that no fake adapter could have shown.

The same applies to a restart. A journal that round-trips on disk is necessary for the
conversation to survive the Home closing, and it is not proof that a restarted Home draws
it. That is an `operator` row.

Three proof kinds are possible. A **test** names a file, a test name, and the layer it
reaches. An **operator** check is one only a person at a terminal can make, read from the
evidence file. **None** means the promise is written down and nobody has proved it yet;
the owner column says who can.

### Recording an operator result

Some checks cannot be automated — that a restarted Home still draws its conversation, that
a goal submitted to an agent is actually in force in it. Those are recorded by hand, as
JSON keyed by check id:

```json
{
  "front-door/conversation-survives-home-restart": {
    "result": "pass",
    "revision": "b59be1af26394c65fd766aec7d07e6b16fb2cee7",
    "by": "mk",
    "note": "three turns on screen, killed the Home, restarted: same three turns"
  }
}
```

**The evidence file is checked before any of it is believed.** A key that is not a check
in the registry, a `result` that is not `pass` or `fail`, a `revision` that is not a full
40-character sha, or a `by`/`note` that is not a string stops the gate with exit 2 and
names the key. A file that says something the gate cannot read is a mistake in the thing
that decides whether a release may claim it was checked, so it is not quietly skipped.

**A recorded result counts only against a clean tree at the revision it names.** Three
ways it stops counting, each of them back to `PENDING`:

- The revision differs. Yesterday's observation is not about today's code.
- The working tree is dirty. A dirty tree has no identity — the sha says one thing and the
  files say another, and an observation cannot be known to survive an edit made since.
- `git` could not be asked, or did not answer with a sha. A tree nobody can name cannot
  carry evidence about itself.

An operator check carried forward from an earlier release is exactly the "disclosed but not
run" state 0.8.0 shipped in, and it must read as `PENDING` rather than as a pass.

## What a reviewer asks

Review criteria are about outcomes, not activity. A step that ran, a message that was
accepted, an agent that is busy and a suite that is green are all activity. None of them
is the thing the work was for.

For each claim in a merge request, in this order:

1. **What was promised, in a user's words?** If the change cannot be stated as something
   a person would notice, the claim is about mechanism, and the outcome is still missing.
2. **What proves it, and did that run here?** A test name, a verification record bound to
   the tree, or a recorded observation. A summary written by the agent that did the work
   is not evidence of its own success.
3. **What is still pending, and who owns it?** Named pending work is a finding about
   integration. Unnamed pending work is a claim of completeness that is not true.
4. **Does the evidence belong to this revision?** A verification whose fingerprint is not
   the current tree is stale, and a stale pass is worse than no pass.

A finding may legitimately cite an unchanged caller or something that was never
implemented. Relevance to the change decides whether a finding stands, never whether the
file it names appears in the diff.

## Submitted is not done

The states a message passes through are separate facts, and collapsing them is how a send
gets reported as progress. The delivery ledger's states and what each one rests on are
canonical in [Steering](steering.md#the-four-states-and-why-they-are-four); in short: `reserved` is
Collie's intent to send, `submitted` says herdr accepted the text, `acknowledged` needs
the agent's own ack file, and `verified` needs an independent check. `unknown` is the
honest state when nobody can say, and only a person settles it.

The same distinction applies one level up, at the agent's own front door, where Collie
has no ledger:

- **Submitted** — `herdr agent prompt` returned. The text reached herdr.
- **Queued** — the agent was busy, so the text is waiting for its current turn to end.
  Accepted is not started.
- **Suggested** — the text is sitting visible in an editor or composer and has not been
  sent. Visible is not submitted.
- **Working** — the pane shows `working`. This says a turn is running. It does not say
  which turn, and it is the state most often mistaken for the next one.
- **Activated** — the agent's own state names this instruction: the goal is in force, the
  hook is registered, the skill is loaded. Nothing outside the agent shows this, so it is
  read from the agent, not from the pane.
- **Completed** — the agent produced the result the instruction asked for. Only the result
  shows this; an agent that says it is continuing has said nothing.

`herdr agent prompt --wait` does not track turns: an agent that was already working can
match on the completion of the turn it was already in, so a `working` badge after a
submission may belong entirely to the turn before it. **A badge is not activation.**
Submitting a `/goal` proves the text was taken; only the agent's own goal or Stop-hook
state proves the goal became the agent's, and that is what the
`lifecycle/goal-activation-observed` row asks a person to record. Until somebody does, it
stays `PENDING` — an honest unknown, never a synthesised pass.

## A Run's execution and what became of its work

A Run's status records how its execution ended. It is history, and it is never rewritten
— a Run that failed still failed, even after a person finished the work by hand and
merged it. What changes is what became of the work, which is a separate fact recorded
beside the status rather than over it. A board that shows only execution status leaves a
red row against work that shipped; one that overwrites the status to tidy the row has
falsified what happened. Both are wrong, and they are wrong in opposite directions.

That separate fact is a [Disposition](../CONTEXT.md), recorded with
[`run disposition`](cli.md#what-became-of-the-work).

**This is integrated at the CLI only.** `run disposition` records it and `run show` reports
it. The board and the Live region do not read it yet, so the stale red row a person
actually looks at is unchanged — that is the
`front-door/disposition-visible-where-the-stale-row-is` row, which is `PENDING` and owned
by whoever owns the board. Saying the stale row is fixed would be the same mistake as
letting a backend test settle a front-door promise.

## Authority is not suspended by who started the turn

A proposal Collie raises unprompted goes through the same `validate` path as one a person
asked for. What a human already granted this Run — automatic correction included — stays
granted, and may be carried out. What was never granted still waits for a human. A
proactive turn neither becomes blanket confirmation-only nor grants anything new: who
started the turn is not an input to what is permitted. Testing this means testing the
existing authority path, not asserting that nothing Collie says unprompted can have
happened already — which would quietly revoke a grant the user chose to make.
