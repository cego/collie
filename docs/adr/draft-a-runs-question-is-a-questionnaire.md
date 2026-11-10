# A Run's question is a questionnaire

**Status: draft.** Decided by the grill step of run-5520175a. Amends
[ADR-0062](0062-an-agents-question-is-asked-on-its-run.md): an agent's question with options no
longer takes an answer in the human's own words, and one that is not to standard is repaired
once before it is posted.

## What was true before

As of `cego/collie@59b8000f` (0.118.0):

- **Options were plain strings.** `collie_decisions.options` held a JSON array of titles. An
  agent's `AskUserQuestion`, `ask_user_question` or App Server question reached the Run with
  its options flattened into the prompt and none on the row, so its card read a paragraph and
  took any words as the answer.
- **No option was recommended.** Many workflow Choices offered two options, none said which
  Collie would take, and a Desktop click on one sent at once.
- **"None of these" had no place on the card.** A human who wanted something else steered
  the agent separately, and the card did not offer it.

## Decision

A recorded question's options are **solutions**: an id an answer names, a title, a one-line
detail, and a recommended flag. Every front door shows them in the host's order, the
recommended one first. A free-text **steering entry** is always last.

**D4: A recommendation is metadata, never approval.** Nothing selects, submits, times out
into or auto-takes the recommended solution. A pick is sent only when someone submits it.
Picking a recommended solution answers that question and nothing else: it changes no
Permissions and approves no other operation. "Decided at launch" and "a Choice with one option
left is taken" are unchanged; they are about options, not recommendations.

**D6: Hold the Run is the third path for a Choice its authors gave fewer than three
options.** It is not an option and never an answer. A front door carries it out with the
existing hold control, reason `held at question <name>`: the Run is held and the question
stays open. Answering it later moves the workflow on, and the work it starts waits for the
hold to lift. On a Run already held the path is shown disabled. An agent's question is
never offered Hold; one short of standard carries a shortfall flag instead.

**D10: Repair once, then post flagged.** An agent's question is to standard when it is
single-select, has at least three options with distinct titles, and exactly one ends
` (Recommended)`. One that is not is refused once, saying what is missing: through the
`PreToolUse` hook for Claude, the tool's own result for pi, and a `repair` Delivery for
Codex, whose question tool returns at once. The agent's next question call is posted
whatever it holds, with `shortfall` naming what is still missing. The call after a repair is
never repaired again.

**D12: Steering is a Delivery, not an answer.** The steering entry sends the human's words
as a human's Delivery: to the agent that asked, for an agent's question, and to `run steer`'s
default agent for a workflow Choice. The Superseded-question rules then apply unchanged
([ADR-draft-a-humans-message-supersedes-a-runs-open-question](draft-a-humans-message-supersedes-a-runs-open-question.md)).
Nothing is chosen, approved, released or confirmed. An agent's question with options refuses
words that are not an option, as a workflow Choice already did: words go through steering.

## Consequences

- A row whose options are plain strings is read as titles: each is its own id, with no
  detail and no recommendation. Nothing is rewritten, so a question that waited across the
  upgrade lists and answers as before.
- An answer names a solution's id or its title, in any case, ids first. It is recorded as the
  id, which is what `ask` returns.
- The board's `Question` gains optional keys (`recommended` and `detail` per option; `hold`,
  `steer` and `shortfall`), so older and newer Desktops and hosts still read each other.
