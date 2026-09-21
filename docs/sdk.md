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
import { NativeHost, decision, defineWorkflow, type WorkflowMetadata } from "collie/native";
import { Effect, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";
import * as DurableDeferred from "effect/unstable/workflow/DurableDeferred";

export const id = "echo";
export const title = "Repeat a line, then ask whether to keep it";
export const description = "The typed-module example: a custom service and one decision.";

export const input = { text: Schema.String, times: Schema.Int };

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  const keep = decision("keep");
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
      return `${line}|${yield* DurableDeferred.await(keep)}`;
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

What the host provides is `NativeHost` and the workflow engine. Everything else is yours.

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
  nothing about how it is inferred.
- **`outcome`** is `fixed` or `selectable`, never both. `selectable` offers only the kinds
  a human may ask an implement Run for — `review` and `plan` are what a workflow proves.
- **`followUps` and `actions`** carry an `id` that is stable and a `title` a human reads.
  Two fields, because a retitled action is the same action and a card matching on the
  title would start a different one. `arguments` is the child's schema; eligibility is
  decided from facts, never from a workflow's name.

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
