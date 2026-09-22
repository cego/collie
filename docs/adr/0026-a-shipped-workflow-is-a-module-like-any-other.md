# ADR-0026: A shipped workflow is a module like any other

Status: accepted

## Context

`plan`, `review` and `architecture` were Markdown definitions: front matter said what the
steps were, which agent each ran on, what the menu at the end offered and what each choice
started. Collie read that front matter and ran it. Two things followed from it that the
rest of this plan has been removing one ticket at a time.

The first is that a fork lost what it forked. The kind of result a Run proves was decided
by `fixedOutcome(workflow)` — the literal strings `"plan"` and `"review"` in `run.ts` — so
a copy of `plan` saved as `shape-the-work` proved nothing. The second is that what these
three could do was what the interpreter could express. A menu is a list of `choices:`, a
loop is `repeat:`, a list is `each:`, and anything else is a feature request against
Collie.

## Decision

The three are TypeScript modules in `workflows/`, loaded through the same entry contract a
user's own module is loaded through, with their Markdown beside them as content.

**The Markdown is content and nothing else.** `contentOf` reads a file as its preamble and
its `## name` sections; the module picks the section each piece of work is about and
supplies the variables it names. The prose did not move and did not change — the same file
still carries the front matter the Markdown engine reads for `implement`'s embedded review,
until that engine goes.

**What was orchestration is TypeScript.** A menu is `ask` in a loop, and what an answer
starts is an `if`. A second opinion offered at most twice is a counter. The reviewers are
an array, so a second axis is an entry rather than a primitive. Nothing here is a new
declaration for Collie to interpret.

**What a workflow is, it declares.** `outcome: { fixed: "plan" }` in the module, and
`outcome: plan` in the front matter for as long as the Markdown engine runs anything — so
`fixedOutcome(workflow)` is gone from `run.ts` and a renamed copy proves what its own
declaration says. The offers moved the same way: `metadata.actions` and `metadata.followUps`
carry the ids, the titles, what each starts and what Collie fills in from the Run.

**What a module could not know, the host now answers.** `host.place(runId)` is the Run as
the host admitted it — the checkout it was started for, its own directory, and the host's
own launch options. Without it a shipped module would have had to be handed its project
path as an input, which is the caller doing the host's job. A Run's directory is made as
`place` answers, so what a Run produces has somewhere to go: a plan's tickets, and a
review's prose beside the findings a card counts.

**A prompt is a file, and the message names it.** The Markdown engine has always written
the prompt to the run directory and sent a line pointing at it; the native path sent the
whole text, and the shipped review prompt is over the 8 KB one delivery may carry. Both
paths now write the file and name it. One send is one message, not a transcript.

## Consequences

A fork of any of the three is a copy of a file. It keeps the persona, the skills, the
outcome, the offers and the menu, because every one of those is in the module or in the
Markdown beside it rather than in Collie's opinion of what the file is called.

A native chain waits. The Markdown "Implement now" started a child Run and finished; a
module starts a child and waits for it, because a child belongs to its parent — stopping
the parent reaches the child, and the tree says what is going on. The child is its own Run
with its own card either way.

`implement` and `renovate` are still Markdown, so "Implement now" from a native `plan`
reaches a workflow that is not a module yet. They are the next ticket, and the engine that
runs them goes at cutover.

A live implementer is not handed to. The Markdown review offers "Fix findings" as a
hand-off to an implementer already working, where one is; a module has no way to reach
another Run's agent, so the native review fixes on an implementer of its own. Same
decision, same role, one implementation.
