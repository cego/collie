# Writing a workflow in TypeScript

This is the native contract: a workflow as a TypeScript module that Collie loads and
Effect runs. [`authoring.md`](authoring.md) is the Markdown one, and the five shipped
workflows are still written that way; the two do not mix, and neither supersedes the other
until the shipped ones are converted.

Everything here is `collie/native`, which the executable serves from its own bundle — so
the `Effect` your module imports is the one running it, and a service the host declares is
the service your Layer satisfies. [ADR-0014](adr/0014-native-workflows-run-on-effects-own-engine.md)
is why.

## A module

```ts
import { NativeHost, ask, decision, defineWorkflow, type WorkflowMetadata } from "collie/native";
import { Effect, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";

export const id = "echo";
export const title = "Repeat a line, then ask whether to keep it";
export const description = "The typed-module example: a custom service and one decision.";

export const input = { text: Schema.String, times: Schema.Int };

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  const keep = decision("keep", { prompt: "Keep this result?", options: ["yes", "no"] });
  const layer = workflow.toLayer(
    Effect.fnUntraced(function* (payload) {
      const host = yield* NativeHost;
      const line = yield* Activity.make({
        name: "echo",
        success: Schema.String,
        execute: host
          .record(payload.runId, payload.input.text)
          .pipe(Effect.as(payload.input.text.repeat(payload.input.times))),
      });
      return `${line}|${yield* ask(payload.runId, keep)}`;
    }),
  );
  return { workflow, layer, decisions: { keep } };
};
```

Five exports, and only `make` is a function Collie calls. `id` is what an operator types;
`registrationName` is the host's and opaque, and a second load of the same file gets a new
one. Constructing a workflow starts nothing.

`defineWorkflow` fixes two things and leaves the rest to you. The payload is
`{ runId, input }` — the host supplies the run, you supply the input schema — and
idempotency is the run alone, so a retried request is the same execution and a new start
is a new one. The error is `WorkflowError`, which carries a `reason`: a Run that ended
badly is a Run, not a value another workflow destructures.

## What a caller may put in your input

Your schemas settle every launch, in the host, before a Run, a claim or an execution
exists — so a value one of them refuses costs nothing to refuse, and your body is handed
values of the types you declared.

`--input k=v` is what a human typed. It is tried as text first and read as JSON only where
your schema will not take text: `Schema.Int` takes `--input times=3` as the number,
`Schema.Array(Schema.String)` takes `--input labels='["a","b"]'` as the list, and a
`Schema.Union([Schema.String, Schema.Number])` takes `--input ref=12` as the string,
because text wins where both would do. `--inputs-json` is typed and settles what text
cannot — `false`, `0`, `[]` and `null` — and is how a caller says the number in that union.

An input nobody gave is absent rather than empty, so `Schema.optionalKey` means what it
says and a required field nobody gave is named back to the caller with its own schema
beside it. Write your inputs as schemas that decode without services of their own: a launch
is settled before any Layer of yours has been built, and `InputFields` says so in the type.

## Where a module lives

Three directories, nearest first:

| Layer   | Where                                             |
| ------- | ------------------------------------------------- |
| project | `.herdr/workflows/*.workflow.ts`                  |
| user    | `~/.collie/user/workflows/*.workflow.ts`          |
| shipped | `workflows/*.workflow.ts` inside the installation |

Save `echo.workflow.ts` in one of them and it is found: nothing to register it in, nothing
to rebuild, no host to restart. Only entry files take part — a `helper.ts` or a `notes.md`
beside one is reached because your entry imports it, not because it was found.

The file name is what shadows. A project's `review.workflow.ts` overrides the user's, which
overrides the shipped one; the `id` inside is the public name an operator types. Two files
in one layer claiming one id are both refused, each naming the other, and an override that
does not compile refuses its own id and says which file — it never falls through to the
module it was written to replace, and the entries beside it keep working.

An edit reaches the next run. Your entry, the helpers it imports and the Markdown it reads
are one thing — the directory a generation is staged from — so editing any of them sends
new work to a new registration while a run already going keeps the code it started on.
Deleting a file takes its id away; putting it back brings it, and any run waiting on it,
back. [ADR-0016](adr/0016-a-workflow-module-is-found-where-it-was-saved.md) is why each of
those is the way it is.

## Replay, and what belongs in an Activity

Recovery re-enters your workflow body from the top. What happened before is not repeated
because Effect gives back what it recorded — and it only recorded what was inside an
`Activity`.

- **Anything with an effect outside this process goes in an `Activity`.** Writing a file,
  launching an agent, opening a merge request. A completed Activity's result is replayed
  rather than run again.
- **Anything that must be re-read on every attempt stays out of one.** An operator's hold
  is the example: read inside an Activity, replay would hand back the answer from the
  attempt that first ran, and releasing it would change nothing.
- **Separate a launch from the wait for it.** One Activity that starts an agent and one
  that waits: replaying a combined one would start a second agent. The wait re-enters, the
  launch does not.
- **Suspend the instance you are in.** Inside an Activity, `WorkflowEngine.WorkflowInstance`
  is that Activity's own. Suspending the enclosing workflow from in there abandons the
  Activity rather than parking it, and the next attempt has nothing to re-enter.
- **Pure helpers stay plain code.** A function of its arguments needs no durability.

Arbitrary edits to a module have no seamless-resume guarantee. Adding an Activity before
one that has already completed changes what replay matches; a run in flight is best
finished before that kind of edit, and a new one started after it.

## Services

A service of your own is an ordinary `Context.Service`, and your Layer provides it:

```ts
class Stamp extends Context.Service<Stamp, { readonly around: (t: string) => string }>()(
  "echo/Stamp",
) {}
const StampLayer = Layer.sync(Stamp)(() => Stamp.of({ around: (t) => `<${t}>` }));

const layer = workflow.toLayer(body).pipe(Layer.provide(StampLayer));
```

`Layer.provide` is the word that matters. Merging a Layer beside a workflow supplies it
nothing, and the mistake is invisible until the body asks for the service — at which point
the host reports `Service not found` against the file that asked. There is no dependency
resolver and no registry: what your workflow needs, your Layer provides, explicitly.

What the host provides is `NativeHost`, `NativeAgents`, `NativeChildren` and the workflow
engine. Everything else is yours.

### Two projects, two implementations

A shared contract with more than one implementation is an ordinary service with more than
one Layer. Which one a Run gets is decided by which module it is running, and a module is
found by where it was saved — so a project that keeps its own copy of a module keeps its
own copy of what that module provides.

Nothing looks anything up for you. There is no binding table, no override registry and
nothing a service is resolved through at run time: the host builds each module's Layer as
that module wrote it, once per loaded generation, and two projects running at the same
moment are two Layers that never meet.

Two copies of a contract in two directories are two modules and one service, because a
service is its key and not the file that declared it. Keep the key stable and an override
satisfies the same contract its original did.

## Having an agent do the work

`agentWork` is one call for one piece of agent work: it builds the prompt, launches the
agent, collects what it wrote, decodes it against your schema, and hands you a value of
your own type.

```ts
const Verdict = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]).annotate({
    description: "clean only when there is nothing left for the implementer",
  }),
  note: Schema.String.annotate({ description: "one sentence a human reads" }),
});

const verdict =
  yield *
  agentWork({
    runId: payload.runId,
    operation: "review",
    role: "reviewer",
    cwd: payload.input.cwd,
    instructions: notes,
    inputs: { target: payload.input.target },
    output: Verdict,
  });
```

- **`operation` is the identity.** The Activity names and the agent's name come from it, so
  it has to be stable within the run and different from every other operation in it.
- **`instructions` is your Markdown**, rendered with `{{inputs.x}}` from the values you
  pass, plus `{{role}}`, `{{cwd}}` and `{{output_path}}`. The prompt then names where the
  Output goes and carries the JSON Schema `output` draws to. A field's `description` is the
  judgment being asked for, so write it as one.
- **`output` decides.** A file that does not decode is unusable however plausible it reads,
  and every issue with it is reported at once.
- **One unusable Output buys one repair**, sent back to the agent that wrote it, with the
  schema's own issues. A second one fails the run with `output-unusable`.
- **`cwd` is yours to say.** The host knows its own state directory, not which checkout
  this piece of work belongs in.
- **`role`, `harness`, `model` and `permissions`** default to the operation's name and to
  the operator's configuration. The role is injected as a Step's persona is.

Skipped work is work you do not ask for: return without calling `agentWork` and no tab
opens, no agent starts and no Output is fabricated. Say why in what you return.

A restart is safe in both directions. The launch is an Activity, so a replayed collection
reattaches rather than starting a second agent; the repair is an Activity of its own, so a
restart does not hand out another one. None of that makes an external launch exactly once —
an agent already there by that name is reattached to, and a herdr that cannot say what it
has stops the work with that as the reason rather than starting a second agent.
[ADR-0020](adr/0020-an-agent-is-launched-once-and-its-output-is-decoded.md) is why.

`promptFor` builds the same prompt without launching anything, and `decodeOutput` reads a
file against a contract. Both are plain functions, so a test of yours can use them.

## Waiting for a human

`decision(name, { prompt, options })` is a question, and `ask(runId, question)` is how you
wait for it. Wait with `ask` and not with `DurableDeferred.await`: `ask` tells the host what
the run is waiting on, and a host that does not know that cannot show the question, cannot
refuse an answer to one nobody asked, and cannot tell a second answer from the first. A
module that awaits a deferred directly gets a Run nobody can answer.

- **`options` is what it takes.** An answer outside them is refused before your workflow is
  told anything. Leave it out for a question answered in the operator's own words.
- **One answer, whoever sends it.** Two answers racing make one piece of work; the second is
  refused with what the run already has, and retrying one under the same request id is the
  same answer rather than another.
- **The question survives a restart**, and so does its answer. What is waiting is in
  `run show`, and `run answer <run> <value> --decision <name>` settles it.

## A workflow made of other workflows

`child({ runId, invocation, workflow, input })` starts another workflow as part of this one
and waits for it. `workflow` is a public id, selected in your Run's own project, so a
project that overrides that module overrides it here too. Importing a function from a file
beside yours does the opposite on purpose: the file decides, and no lookup happens at all.

- **`invocation` is the identity.** The child's Run id is your Run id and this name, so
  replaying your body asks for the child you already have rather than a second one, and a
  different name is a different child. Giving one invocation different input later is
  refused, not run twice.
- **The child's schema decides.** Your input is decoded against the child before anything
  exists. A value it will not take is your workflow's failure, naming the field, with no
  child Run and nothing to clean up.
- **It belongs to you.** The child carries your Run as its parent and your Task as its Task,
  it shows up in `run list` beside you, and interrupting you reaches it. It does not belong
  to whatever client asked for your Run — that can go, and neither of you notices.

How many children there are, and in what order, is TypeScript:

```ts
const graded =
  yield *
  Effect.forEach(payload.input.notes.split(","), (note) =>
    child({
      runId: payload.runId,
      invocation: `grade-${note}`,
      workflow: "graded",
      input: { note },
    }),
  );
```

Name the invocation after the work, not its position in a list: a list that is reordered
between attempts must not hand one item's child to another. `children.start` and
`children.result` are the same thing in two halves, for starting several before waiting on
any of them.

`options` is the host's own — `repo`, `workspace`, `branch`, the names in
`RESERVED_INPUTS` — and nothing else is taken: a parent cannot put a field into a child's
payload that its author never declared. It is how a repository gets its share of a plan
that spans several:

```ts
const plan = yield * planReposOf(asked.plan, asked.root);
if (plan.refusal !== null) return yield * new WorkflowError({ reason: plan.refusal.message });
for (const wave of plan.waves) {
  yield *
    Effect.forEach(
      wave,
      (repo) =>
        child({
          runId,
          invocation: `repo-${repo}`,
          workflow: "share",
          input: { plan: asked.plan, tickets: ticketsFor(repo) },
          options: { repo, workspace: `${asked.root}/${repo}` },
        }),
      { concurrency: "unbounded" },
    );
}
```

`readPlanRepos` (and `planReposOf`, against a directory) says which repositories a plan
changes and in what order their Runs may start — a wave waits on the one before it — or
refuses the whole plan: a cycle, a ticket number claimed twice, a repository with no
checkout to work in. Refuse at the parent, where no child exists yet and there is nothing
to clean up.

[ADR-0022](adr/0022-a-workflow-is-made-of-workflows.md) is why each of those is the way it
is, and why nothing here is a dependency resolver.

## A list of work, one item at a time

A list is `Effect.forEach` over whatever you enumerated; what Collie adds is the two things
a list of _work_ needs, which are the same two a declared `each:` uses.

- **An item is known by its own name.** `agentWork`'s `operation` is the identity: what it
  launched, what it collected and what it wrote are all recorded under it, so replaying the
  body reuses an item's result by name and never by where it sat in the list. Enumerate
  again on every pass rather than freezing the list — a plan that gained a ticket has work
  left, and one that was reordered has none — and let the identities decide what is done.
  `identityProblem(keys)` refuses a list before any of it is started: an identity is a name
  of its own, and two items nobody can tell apart would share one result.
- **The item before it is a hand-off, not a transcript.** `renderProgress(done)` is what the
  items already finished left behind — their work, their commits, what was verified while
  they ran — for the next item's prompt. `agent` on `agentWork` puts several items on one
  agent, which is what the baseline does: one implementer, each item its own prompt and its
  own Output.

```ts
const tickets = yield * orderedTicketsOf(asked.plan);
const problem = identityProblem(tickets.map((ticket) => ticket.file));
if (problem !== null) return yield * new WorkflowError({ reason: problem });
const handed: Handed[] = [];
for (const [at, ticket] of tickets.entries()) {
  if (ticket.checks.length === 0) {
    yield * host.record(runId, `skipped ${ticket.file}: it names no checks`);
    continue;
  }
  const built =
    yield *
    agentWork({
      runId,
      operation: ticket.file,
      agent: "implementer",
      cwd: asked.cwd,
      instructions: INSTRUCTIONS,
      inputs: {
        ticket: ticket.file,
        at: at + 1,
        of: tickets.length,
        progress: renderProgress(handed),
      },
      output: FixOutputSchema,
    });
  handed.push({
    item: ticket.file,
    title: ticket.title,
    commits: built.fixed.map((one) => one.title),
  });
}
```

`orderedTickets` (and `orderedTicketsOf`) reads a plan directory as tickets in an order they
can be built in — `Blocked by` before blocked, plan order among the rest — narrowed to one
repository where you name one. Skipping is your own `continue` with a reason recorded: no
agent, no tab and no Output written as though somebody had answered. An empty list is no
work, and findings are yours to carry — nothing here ends a list because an item found
something.

[ADR-0024](adr/0024-a-list-of-work-is-known-by-its-names.md) is why an item is known by its
name rather than its place.

## Reviewing and fixing, until it converges

A review/fix rally is a loop you write, over the functions the engine uses for a declared
one. There is no repeat declaration, no scheduler and no second reading of when a loop is
done: a workflow that writes its own rally converges, stands on a dispute and runs out of
rounds exactly where a declared one does, because it is the same three decisions.

- **`splitDisputed(findings, disputed)`** — what is still the implementer's. A finding the
  implementer already rejected with a reason stops driving the loop; a reviewer who answers
  that reason with a `rebuttal` puts it back.
- **`settleRound({ live, disputed, at, seen })`** — where this round goes: `fix` with the
  blocking set that drives it, `clean` when nothing blocking is left, or `halt` when a
  dispute stands unanswered or the same blocking findings came back unchanged. `seen` is
  the previous round's `keys`; without it nothing can notice a rally going round.
- **`settleFinalFix(live, fix, evidence)`** — the last round has no review after it, so the
  fix's own account is what is left. Every blocking finding needs a disposition, and every
  check it names needs a passing verification on the tree as it stands.

`ReviewOutputSchema`, `FixOutputSchema` and `SynthesisSchema` are the shapes those steps
write. Hand one to `agentWork` and what comes back is its own type — the same contract the
shipped steps are held to, not a copy of it.

## Proving it, rather than saying so

`host.evidence(runId, cwd)` is what has been verified for your Run and what the tree is
now. `settleFinalFix` reads it: a check an Output names is a claim until the journal has a
passing record of it, collected on this exact revision. A commit or an edit since makes an
earlier pass history — it is not that the result went off, it is that it is about another
tree.

`host.verify({ runId, name, cwd })` runs one of the commands your Run was started under the
authority of, and records what it did. The list is `.herdr/verify.json`, read when the Run
started — a name nobody approved is refused, and a workflow cannot add to it. Anyone else
collects the same way from outside: `collie verify --run <your run id> -- <command>`.

[ADR-0023](adr/0023-a-rally-is-a-loop-and-a-claim-is-not-proof.md) is why the rally is a
loop and why a claim is not proof.

## What an operator can do to your Run

None of it is yours to implement, but it decides where your workflow can be interrupted.

- **A hold parks the Run at its next boundary.** Read it with `host.held(runId)` as a plain
  Effect and suspend the run's own instance; `agentWork` already does this before it starts
  an agent. It must not be an Activity: an operator sets a hold between attempts, and an
  Activity would hand back what the first attempt saw.
- **A stop parks a wait.** Read `host.stopRequested(runId)` inside the Activity that waits
  and suspend _that_ Activity's own instance, never the workflow's — suspending the run from
  inside an Activity abandons the wait rather than parking it. `agentWork` does this while it
  is collecting, so a stop lands even mid-collection and what resumes reattaches to the
  launch already recorded.
- **Stopping a Run does not stop its agent.** The agent keeps what it is holding; halting a
  harness is its own action. Steering — `run steer` — says something to that agent through
  the one sender, and says whether it was delivered.

[ADR-0021](adr/0021-one-host-answers-for-a-run.md) is why each of those is the way it is.

## Metadata

`metadata` says what the workflow _is_. Nothing in it is consulted by a body, and nothing
in it is a step.

```ts
export const metadata: WorkflowMetadata = {
  hints: { text: "work-source" },
  outcome: { selectable: ["feature", "docs"] },
  followUps: [{ id: "echo-again", title: "Echo it again", workflow: "echo", when: "succeeded" }],
  actions: [
    {
      id: "echo-louder",
      title: "Echo it louder",
      workflow: "echo",
      arguments: { text: Schema.String, times: Schema.Int },
      eligible: (facts) => facts.succeeded && !facts.disposed,
    },
  ],
};
```

- **`hints`** attach inference to a field. `work-source`, `diff-target` and
  `gitlab-repository` are exclusive: one field each, so renaming `plan` to `spec` changes
  nothing about how it is inferred, what it names a branch after, which label its Run is
  listed under, or which previous review it is given.
- **`outcome`** is `fixed` or `selectable`, never both. `selectable` offers only the kinds
  a human may ask an implement Run for — `review` and `plan` are what a workflow proves.
- **`followUps` and `actions`** carry an `id` that is stable and a `title` a human reads.
  Two fields, because a retitled action is the same action and a card matching on the
  title would start a different one. `arguments` is the child's schema; eligibility is
  decided from facts, never from a workflow's name.

Both are what a finished Run offers to do next, and both front doors make the same offer:
`collie run actions <run>` lists them and `collie run action <run> <id> --input k=v` does
one. Everything is decided again at that moment — that your module still declares the
offer, what your `eligible` says about the facts as they are now, and whether the child
takes the arguments — so an offer edited away, one whose facts have moved, and arguments
the child refuses each start nothing at all. A `followUp` is hidden once somebody has said
what became of the work; an `action` is given `disposed` and decides for itself.

A conflict is refused at load — before a Run, a worktree or an agent exists — and the
refusal names every one of them rather than the first:

```
workflow id "Conflicted" is not an identity: lower case, digits and dashes;
input "branch" collides with a host option: Branch selection for mutating work…;
"here" and "there" both claim work-source;
an outcome is either fixed or selectable, not both
```

`RESERVED_INPUTS` is the published list of names the host supplies at launch — `branch`,
`task`, `workspace`, `repo`, `outcome`, `risks`, `previous`. An input of one of those would
be shadowed without you ever seeing it, so declaring one is refused.

## The shapes the shipped steps write

`ReviewOutputSchema`, `SynthesisSchema`, `FixOutputSchema`, `MrOutputSchema` and
`PlanOutputSchema` are exported so a step you write declares the same contract the engine
reads, rather than a copy of it. `FindingSchema`, `FixedSchema` and `CheckSchema` are the
pieces they are built from.

They are deliberately loose where judgement lives. `severity` is free text: `blocker`,
`major` and `minor` are what the shipped prompts ask for, but a fork's own word is a
judgement and only `minor` is non-blocking. `file`, `line`, `detail` and `rebuttal` are
optional: a reviewer with no line number has still said something worth reading. None of
them is closed against extra keys.

## JSON Schema

`jsonSchemaFor` draws a schema for a prompt or a listing, and says what the drawing does
not say:

```ts
const { document, limits } = jsonSchemaFor(Schema.Struct(input));
```

`document` is null when nothing could be drawn, and `limits` names each place the drawing
constrains nothing — a `Schema.declare`, for instance, becomes `{}`. Neither makes the
schema invalid. What is lost is the copy a model is held to at its own end; your workflow
is still held to the native one.

## Typechecking a module

```sh
collie native --dir <state>        # then, on stdin:
{"op":"provision","dir":"<your workflow directory>"}
{"op":"check","dir":"<your workflow directory>","entry":"<…>/echo.workflow.ts"}
```

`provision` writes `package.json`, `tsconfig.json` and `collie-native.d.ts` into a
directory that has none — leaving any you already have alone — and installs the toolchain
with the executable's own embedded Bun, so neither Bun nor Node has to be on the machine.
The `effect` it pins is the one the host runs.

`check` reports each diagnostic with its file and line, one module at a time: an error in
one says nothing about the one beside it. With nothing installed to check with, the answer
is `toolchain_unavailable` rather than a module reported as fine.
