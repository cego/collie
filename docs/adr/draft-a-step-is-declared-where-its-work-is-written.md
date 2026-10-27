# A step is declared where its work is written

**Status: proposed.** Amends [ADR-0022](0022-a-workflow-is-made-of-workflows.md)'s "nothing
here is a step" and keeps [ADR-0030](0030-a-workflow-is-one-definition-and-its-agent-is-decided-in-scope.md)'s
rule that nothing is declared before the code that runs it. Keeps
[ADR-0013](0013-the-board-is-cards-of-tasks.md) D3, a card's sentence says what is happening,
and [ADR-0038](0038-the-host-builds-and-serves-the-board.md) D1, the host builds what is drawn.

A **Step** is one declared piece of a Workflow's work. A **Flow** is a Task drawn as the
Steps its Runs took ([`CONTEXT.md`](../../CONTEXT.md)).

## What was true before

- A Workflow's work had no declared unit. `agentWork`'s `operation`, `ask`'s `name` and
  `child`'s `invocation` were identities written at the call. Nothing about the work could
  be read before it ran: no title, no description, no expected order. The SDK guide said
  so: "there is no step graph to keep in step with the code".
- Nothing could say where a Run is in its work. A TaskView's `steps` are its Runs, one glyph
  each, which the TUI draws and Desktop does not. A Run's details carry a `steps` list the
  host always sends empty. The engine's own record never reached a front door. It holds each
  Operation's `boundary`, `agent`, `launch` and `collect` Activities with their attempts, and
  each question with when it was asked and answered and by whom.
- ADR-0030 removed the last declaration of work up front: a map of decisions kept in step
  with the code by hand, where a question asked on one branch, or once per item, was an
  entry for work that might never happen.

## Decision

**D1. A Step is made where its work is written.** As with a Prefect `@task`, a Step is a
value the module makes beside the work it does, with its metadata. `run` calls it when the
work reaches it. A Step on one branch lives on that branch's side of the code, not in a
map, so ADR-0030's rule holds.

**D2. Its metadata is what a reader needs before it runs:** its id, title and description,
its kind (agent work, a question, a child Workflow, a check), its role, and what it
produces: a plan, a review, evidence or a merge request, and so which part of a Run's record
shows it. Nothing in it changes how the Step runs. Retries and timeouts can be added to the
same declaration later, each with an ADR of its own. Usage is still recorded and never
enforced.

**D3. A definition may forecast its path.** Its **path** lists the Steps the Workflow
expects to take, in order. Once a Run knows which branch it takes, as when an implement Run
fans out, its `run` may forecast again, and the Flow forecasts from the latest one. It is a
forecast, never a precondition. A Step called off the
path still runs and is drawn where it happened. A path Step the Run ends without is drawn
`not run`. A Step a loop calls again draws one run per round, and its call may say which
round of how many. A Step called once per item of a list draws one run per **Slice**, named
by its item ([ADR-0024](0024-a-list-of-work-is-known-by-its-names.md)). Without a path, the
Flow shows what happened, plus what the record already knows is coming: a plan's unbuilt
tickets, Waves not started, the follow-up the Run offers, and its merge request's way to
production.

**D4. A Step's run is what the engine recorded, not a new account.** The engine already
keeps:

- each Activity's name and attempt;
- each question's asked and answered times and who answered it;
- each durable timer's wake time;
- whether an execution is running, suspended, completed, failed or died.

A Step's run is those facts. The Step records with the host when its work enters and
leaves it, inside an Activity so a replay records nothing twice, and the launches,
questions, children and Check passes made inside it carry its id and its round or item.
That ties the engine's records to the Step. An Activity annotation would not: it lives
only in memory, and the Flow is built again from what the host stored after every restart.
It adds the launches (agent, harness, model), Check passes and Verifications the Run already
records. An attempt past the first is shown as a retry, with its cause where the record has
one: an interrupted host or a resume.

**D5. The host builds the Flow, and front doors draw it.** One function in the host builds a
Task's Flow from:

- its Runs' records;
- the declarations of the module generation each Run runs on;
- the live agents;
- what its host knows of other Machines.

A TaskView carries the folded Flow a card draws, and a Run's details carry all of it. Desktop
draws it. `collie --json board`, `collie run show --json` and chat's tools read the same
model, so an agent sees the Flow a human does.

A Run started from another Machine names its requester's Run, agent and Machine
([ADR-0058](0058-an-agent-speaks-to-another-as-itself.md) D6). Its host tells the requester's
host over their paired link when it admits the start and again when the Run settles, and the
requesting Run records both, so both ends draw the link. Neither host polls the other: a link
shows what its host was last told, and Desktop says "as of" while that Machine is out of
reach.

**D6. A Workflow that declares nothing still runs and still has a Flow.** A user's module and
a fork keep working unchanged. Their Steps are their Operations, questions and children as
they happen, titled by their identities. Every shipped Workflow declares its Steps through
the same public API ([ADR-0026](0026-a-shipped-workflow-is-a-module-like-any-other.md)).

**D7. A Flow is where the work is acted on, not only seen.**

- **Actions on a node.** Each node offers only the actions that would work now, through the
  executors the card, the CLI and chat already use: retry by resuming, answer, release, deliver
  to its agent, open its pane. The host lists them on the node, so an agent reads the same list
  a human does.
- **Two new controls on a Step,** for humans and agents alike:
  - **A pause before a Step** holds the Run as its work reaches that Step.
  - **A note for a Step** is composed into the front of that Step's next prompt, whether the
    Step has not started yet or is about to be retried.
- **A Step's usual time** comes from this Machine's records of past runs of the same Step. It is
  shown, never enforced.

## Considered

- **Every Step in the definition**, as GitLab declares `stages:`: a `steps` map that `run` may
  only call from. It always gives a complete forecast, but it brings back ADR-0030's map and
  its declarations for work that may never happen. The human chose D1's shape over it.
- **No declaration, drawing only what happened.** It needs no API change, but nothing about a
  Step is known before it runs and its metadata has nowhere to live. The human wanted
  metadata on Steps for more than the view.
- **Re-running a done Step in place**, as a pipeline reruns a job. The engine replays a Run's
  journal. Re-running a finished Step would mean discarding the Step and everything after it,
  and the later work, such as commits and the merge request, was built on what it did. A note
  to its agent or a follow-up Run redoes the work without that rewind. A failed or stopped Step
  retries by resuming, which keeps what is done.
- **The view's name.** "Pipeline" is the forge's word: Desktop already says "its pipeline"
  for a merge request's CI on the same card, and the Flow contains that pipeline as a node.
  "Run" names one Run, while the Flow spans a Task's several Runs and every tab of a record
  is already about one. "Flow" is Prefect's word for what Collie calls a Workflow. The
  human chose it anyway, as the word for where the work is.

## Consequences

- The SDK gains a way to make a Step, and `defineWorkflow` gains `path`. The SDK guide's "no
  step graph" stays true, because a path is a forecast and nothing draws edges the code did
  not take.
- The board protocol gains only optional fields, so `PROTOCOL` does not move (ADR-0038 D5).
  A TaskView's per-Run `steps` stays for the TUI's glyph row.
- Desktop's record gains a Flow tab, first and opened by default. Selecting a node opens an
  inspector under the Flow, with that Step's terminal, log and evidence. A card gains a one-row
  strip under its sentence.
- A hold can name the Step it waits before, and a delivery can name the Step it is for. The CLI
  and chat take both, as they take every other control.
- "Operation" stays the word for a Step whose work is an agent's. Its name still names the
  agent, its files and its Activities.
