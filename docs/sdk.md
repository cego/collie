# Writing a workflow in TypeScript

A workflow is a TypeScript module that Collie loads and Effect runs. Every workflow Collie
ships is written this way — modules in `workflows/`, held to everything below, with their
Markdown beside them as content. [`authoring.md`](authoring.md) is where modules and
personas live and how a fork follows its parent.

Everything here is imported from `collie`, which the executable serves from its own bundle — so
the `Effect` your module imports is the one running it, and a service the host declares is
the service your Layer satisfies. [ADR-0014](adr/0014-native-workflows-run-on-effects-own-engine.md)
is why.

## A workflow

```ts
import { Host, Run, ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";

export default defineWorkflow({
  id: "echo",
  title: "Repeat a line, then ask whether to keep it",
  input: Schema.Struct({ text: Schema.String, times: Schema.Int }),
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const line = yield* Activity.make({
        name: "echo",
        success: Schema.String,
        execute: host
          .record((yield* Run).id, input.text)
          .pipe(Effect.as(input.text.repeat(input.times))),
      });
      const keep = yield* ask({ name: "keep", prompt: "Keep this?", options: ["yes", "no"] });
      return `${line}|${keep}`;
    }),
});
```

That is the whole workflow: one default export, and nothing else Collie reads. `id` is what
an operator types. What you leave out has a default — the title is the id, the description
is empty, the input is an empty struct and the output is `Schema.Void` — and nothing you
would have to make up is invented for you: the identities of your work and questions, what
an agent is told, and any input your work really needs stay yours to write.

`run` is ordinary Effect code. Branches, loops, helpers in other files, parallel work and
lists you build as you go are TypeScript, and a helper can itself ask an agent, ask a
human, start a child or branch again: there is no step graph to keep in step with the code.
A [`path`](#steps-and-the-path-a-run-expects) is a forecast of the Steps a Run expects to
take, never a precondition, and nothing draws an edge the code did not take.

The host executes `run` as a Run, and the Run is supplied rather than passed:
`yield* Run` is its `id` and the public id of the workflow it is a Run of, and `agentWork`,
`ask` and `child` read it themselves. Each Run is one execution keyed on
its id, so a retried request is the same execution and a new start is a new one.

A failure is a `WorkflowError`, which carries a `reason`. A workflow with failures of its
own declares their schema as `error`, and fails with them typed: a Run that ends that way
shows the failure as that schema encodes it, and carries the encoded value for a client to
decode. Nothing else about Effect is wrapped — [Effect stays yours](#effect-stays-yours).

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

| Layer   | Where                                       |
| ------- | ------------------------------------------- |
| project | `.collie/workflows/*.workflow.ts`           |
| user    | `~/.collie/user/workflows/*.workflow.ts`    |
| shipped | `~/.collie/release/workflows/*.workflow.ts` |

Save `echo.workflow.ts` in one of them and it is found: nothing to register it in, nothing
to rebuild, no host to restart. `collie workflow create <id>` writes one there for you, and
`collie workflow fork <id> --name <yours>` writes one that keeps what it forked. Only entry
files take part — a `helper.ts` or a `notes.md` beside one is reached because your entry
imports it, not because it was found.

`~/.collie/user/` is yours whichever installation runs: every upgrade replaces `release/`
whole and never writes `user/`
([ADR-draft-an-installation-is-the-release-its-runner-carries](adr/draft-an-installation-is-the-release-its-runner-carries.md)).

The file name is what shadows. A project's `review.workflow.ts` overrides the user's, which
overrides the shipped one; the `id` inside is the public name an operator types. Two files
in one layer claiming one id are both refused, each naming the other, and an override that
does not compile refuses its own id and says which file — it never falls through to the
module it was written to replace, and the entries beside it keep working.

An edit reaches the next run. Your entry, the helpers it imports and the Markdown it reads
are one thing — the directory a generation is staged from, and whatever it imports by a
relative path from outside it — so editing any of them sends
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

A service of your own is an ordinary `Context.Service`, and your definition's `layer`
provides it to `run`:

```ts
class Stamp extends Context.Service<Stamp, { readonly around: (t: string) => string }>()(
  "echo/Stamp",
) {}

export default defineWorkflow({
  id: "echo",
  layer: Layer.sync(Stamp)(() => Stamp.of({ around: (t) => `<${t}>` })),
  run: () =>
    Effect.gen(function* () {
      /* yield* Stamp */
    }),
});
```

There is no dependency resolver and no registry: what `run` needs and the host does not
lend, `layer` provides, and a `run` that asks for a service nothing provides fails to
typecheck — and, where nothing typechecked it, the host reports `Service not found` against
the file that asked.

What the host lends is `Run`, `Host`, `Agents`, `Children`, the workflow engine, the file
system, paths and the process spawner. Everything else is yours.

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

### Forking a shipped workflow

A definition is a value, so a fork spreads the one it forks and says what is its own:

```ts
import { defineWorkflow } from "collie";
import review from "../../workflows/review.workflow.ts";

export default defineWorkflow({ ...review, id: "our-review", agents: { model: "sonnet" } });
```

To move one role's agent and leave every other choice the original's, spread its `agents`
too and name the role:

```ts
export default defineWorkflow({
  ...review,
  id: "review",
  agents: {
    ...review.agents,
    roles: {
      ...review.agents?.roles,
      reviewer: { harness: "pi", model: "openai-codex/gpt-6-astra" },
    },
  },
});
```

The shipped workflows put every choice they make for a role there — review's and
implement's reviewer, implement's implementer, plan's second opinion — rather than on the
work itself, so a fork like this reaches all of it and an upgrade still reaches the fork.

A fork that changes part of what a workflow does imports the rest. Where a shipped module
expects to be varied it takes the varying parts as ordinary functions, and a fork supplies
its own:

```ts
import { agentWork, defineWorkflow, template } from "collie";
import {
  Merged,
  RENOVATE,
  Recorded,
  Released,
  RenovateInput,
  asRenovator,
  renovation,
  type Landing,
} from "./renovate.workflow.ts";

const fastForward = template(
  `${RENOVATE.merge.text}\n\nHere, merge fast-forward only.`,
  RenovateInput.fields,
);
const deploy = template(
  "Deploy the default branch of {{inputs.repository}} rather than tag it.",
  RenovateInput.fields,
);

const landing: Landing = {
  merge: (at) =>
    agentWork({ ...asRenovator(at, "merge"), instructions: fastForward, output: Merged }),
  release: (at) =>
    agentWork({ ...asRenovator(at, "release"), instructions: deploy, output: Released }),
  record: (at) =>
    agentWork({
      ...asRenovator(at, "record"),
      instructions: "Write it off on our own board.",
      output: Recorded,
    }),
};

export default defineWorkflow({ ...renovation(landing), id: "landing" });
```

Everything the fork did not write — what it assesses, what it batches, the claim it takes,
the teammate's approval it waits for — is the shipped orchestration, and a baseline change
to any of it reaches the fork. `RENOVATE_ON.gitlab` and `RENOVATE_ON.github` hold each
forge's shipped sections as templates, and `Landed.forge` says which forge a landing step's
repository is on (`Landed.url` and `Landed.noun` are its web address and its word for a
merge request, for a Clearance like the shipped one's), so a fork keeps a section's words for either by starting from
`RENOVATE_ON[at.forge].merge.text` and adds its own sentence. `RENOVATE` is still the GitLab
sections, so a fork written before there were two reads what it read; `asRenovator`
is who does the work and the `input` every shipped section reads.

`Landing.merge` is called once per Renovate merge request on the same conversation.
`at.input.merge_request` names that turn's request; `asRenovator` gives later turns
distinct operations. Keep that scope in a fork's instructions, and return any newly
opened requests in `Merged.remaining_requests` so each gets its own turn. For an
application, the approved batch is merged once and each original request is then settled
against it. The release and record functions are still called once for the repository.

Nothing was added to Collie to make that possible, and nothing needs to be. A workflow
that wants to be varied takes functions, or takes a service and lets a fork provide a
different Layer for it. There is no step to patch and no engine to copy.

## Having an agent do the work

`agentWork` is one call for one piece of agent work: it builds the prompt, launches the
agent, collects what it wrote, decodes it against your schema, and hands you a value of
your own type.

Every agent gets Native chat's whole Toolkit through its harness's MCP wiring, or Pi's
extension. Its prompt names its Run, agent and Machine, with the tool and CLI reply
address. `collie_installation` and `collie_definitions` read its own Machine. Tools naming
a Run find the host that has it; agents push their branch before starting work elsewhere.
See [agents talking to each other](using.md#agents-talking-to-each-other).

```ts
const Verdict = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]).annotate({
    description: "clean only when there is nothing left for the implementer",
  }),
  note: Schema.String.annotate({ description: "one sentence a human reads" }),
});

const review = template("Review {{target}} as the {{role}}.", { target: Schema.String });

const verdict =
  yield *
  agentWork({
    operation: "review",
    role: "reviewer",
    instructions: review,
    input: { target: input.target },
    output: Verdict,
  });
```

- **`operation` is the identity.** The Activity names and the agent's name come from it, so
  it has to be stable within the run and different from every other operation in it.
- **`instructions` is a template or text of your own**, rendered with `{{name}}` from
  `input`, plus `{{role}}`, `{{cwd}}` and `{{output_path}}`, which every piece of work is
  given. The prompt then names where the Output goes and carries the JSON Schema `output`
  draws to. A field's `description` is the judgment being asked for, so write it as one.
- **`output` decides.** A file that does not decode is unusable however plausible it reads,
  and every issue with it is reported at once. Leave `output` out and the agent answers in
  plain text, which is what you are handed; a schema is how you opt into a structured,
  validated answer.
- **One unusable Output buys one repair**, sent back to the agent that wrote it, with the
  schema's own issues. A rewrite the schema still refuses is judged once the agent's turn
  has ended, so a file caught half rewritten is not the answer; one still unusable then fails
  the run with `output-unusable`. A stop while the
  rewrite is awaited parks the wait, as it does the first; the resume starts an agent that
  went with the stop again on the work.
- **A busy pane is waited out, then parked.** Where herdr answers that the agent's pane
  cannot take a prompt yet (`agent_blocked`: a dialog is up), the prompt and its repair are
  tried again, under the same delivery, for up to ten minutes. Past that the Run is
  `suspended` rather than failed, `run show` says what held and for how long, and
  `collie run resume` hands the same prompt to the same agent.
- **The Output budget is idle time.** The agent has two hours to write its Output, counted
  only while herdr reports it `idle`, `done` or `unknown`, or cannot say. While it is
  `working` or `blocked` the clock stops, so a long suite is never parked for being slow.
  It stops too while a question the agent asked is open on the Run
  ([`docs/cli.md`](cli.md#answering-holding-and-steering-one)), and while a `collie verify`
  it asked for waits because its Machine is [Short of memory](using.md#short-of-memory). A
  launch that waits for memory spends none of it either: the budget starts once the agent
  is launched. Past the budget the Run parks saying how many minutes it sat idle, and Collie
  keeps collecting: an Output written later clears the park and the step goes on, with no
  resume. An agent that has gone by the end of another idle budget is started again. Gone is
  an agent herdr no longer lists, or one it still lists but refuses as not active, as it
  does when the agent's process died with its Machine; that one's pane is closed first, so
  the new agent can take its name. A stop still ends the wait.
- **`cwd` is where the host placed the Run** unless you name another checkout.
- **`role`** defaults to the operation's name. The role is injected as a persona, and where
  `personas/<role>.md` exists in the project, on this machine or in the installation, that
  persona is what the agent is started as. A role nobody wrote a persona for is stated in
  one line.
- **`harness`, `model` and `effort`** are [decided in layers](#which-agent-does-the-work),
  and `permissions` is the operator's unless the work asks for `harness`.
- **`skill` starts one.** A skill a workflow names is invoked the way a human invokes one,
  with the first message — which is the only way to reach a skill that refuses to be called
  by a model. A skill _mentioned_ in your Markdown as `{{skill:name}}` renders as the path
  to read instead, so a prompt never spells one harness's syntax.
- **`pushes: true` is read before the agent starts.** The host reads the branch's merge
  request through its forge, and while it merges itself once green the work does not start:
  the Run records `not pushed: auto-merge is on for <url>` and parks as Needs you until
  auto-merge is off and it is resumed
  ([ADR-0050 D4](adr/0050-a-merge-request-is-its-forges.md)). Give it to any work whose
  agent pushes.
- **`clears` is the step's Clearance:** what its agent is told, in its own turn, that it
  may do. Each entry is one sentence naming one action and its target, and Collie types
  them as one line after the step's pointer: `Cleared for this step: <one>; <two>.` That
  line is the agent's user turn, where Claude Code's auto mode reads it as the user asking
  for exactly that action; an instruction in the prompt file is tool output to it. It is
  typed to every harness, and a resend types it again.
  - An entry is one line, and the entries joined are at most 400 characters. The whole
    step message — token, pointer with its real path, command line where `skill` starts
    one, and the Clearance — must fit 700 characters, the budget Claude Code still shows as
    typed. Past either, `agentWork` fails naming the operation (and, for the message, its
    length and prompt path) before anything starts. Work without `clears` is never
    refused for length.
  - Compose it from facts Collie holds — the checkout's branch, `host.mr`'s `url`, a merge
    request the forge adapter found — never from an Output, which an agent wrote.
  - It is not a permission rule: each call is still judged on its own. A vague Clearance
    clears nothing, because the review only honours a request that names the exact action
    and its target
    ([ADR-draft-what-a-run-authorises-reaches-auto-mode](adr/draft-what-a-run-authorises-reaches-auto-mode.md) D1).
- **`input` is what the instructions name.** With a template it is exactly what the
  template declares, so the compiler checks it; with text, `{{run.dir}}` reads `input.run.dir`.
  An expression nothing fills fails the work before any agent starts, never renders empty.

Skipped work is work you do not ask for: return without calling `agentWork` and no tab
opens, no agent starts and no Output is fabricated. Say why in what you return.

`agents.askRoute(role, place.lineage)` is what an agent is told about asking for a decision
its work does not cover: the pane of whoever is live in that role in this Run's lineage —
the Run itself, then the Runs it was started from or builds a plan of, and so on — and
otherwise to decide and record it under `assumptions` in its Output. Another Run's agent in
the same role is never the answer, however recently it was started from the same place. You
name the role — who may be asked is your workflow's declaration, not an assumption Collie
makes about it. Give that work's Output an `assumptions` field and carry what it says to the
human, as implement's `Built` does into the merge request: a field the schema lacks is
decoded away. Ask it again for each piece of work rather than once per Run: a planner that
has gone since is otherwise still described as live. Shipped `implement` asks per ticket.

The work itself is written to `<state>/agents/<run>/<operation>.prompt.md` and the message
names that file. One send is one message and not a transcript: a step's prompt carries a
whole contract, and what the agent is asked is a file it reads rather than a wall of text
in a chat.

A restart is safe in both directions. The launch is an Activity, so a replayed collection
reattaches rather than starting a second agent; the repair is an Activity of its own, so a
restart does not hand out another one. None of that makes an external launch exactly once —
an agent already there by that name is reattached to, and a herdr that cannot say what it
has stops the work with that as the reason rather than starting a second agent.
[ADR-0020](adr/0020-an-agent-is-launched-once-and-its-output-is-decoded.md) is why.

### What every step prompt is given

A Run's attachments — the files given with its start, a steer or a follow-up, and copies of
those of every Run in its Lineage — are the files in its own `runs/<id>/attachments/`, and
every step's prompt lists them, between the instructions and the Output, each with its
name, media type, size and absolute path, so an agent opens a screenshot like any other
file. The list is read when the step is launched: a file a steer brought is in every prompt
after it. A Run with none gets no section. They are not an Input, so your schema declares
nothing for them and every workflow gets them unchanged
([ADR-0046](adr/0046-an-attachment-is-uploaded-once-and-belongs-to-the-run.md)).

`promptFor` builds the same prompt without launching anything — its `attachments` is that
list — and `decodeOutput` reads a file against a contract. Both are plain functions, so a
test of yours can use them.

## Which agent does the work

Harness, model and effort are preferences, and nothing has to forward them. Each piece of
work takes the nearest layer that names one, lowest first:

```text
built-in defaults
→ the operator's configuration
→ the definition's own agents
→ the definition's own agents for the work's role: the seat it sits at (agents.roles)
→ the Run's own: --harness, --model, --effort
→ an enclosing withAgents scope
→ agentWork's own options
```

`withAgents` scopes preferences over everything inside an effect — through helpers in other
files, and into the children it starts:

```ts
yield * reviewAndFix(input).pipe(withAgents({ harness: "claude", model: "opus" }));
```

Scopes nest, the innermost winning, and parallel branches each keep their own; nothing is a
setting that one branch changes for another. A child is handed what its parent prefers
where it starts it — the Run's own preferences and the scopes around the call — as options
it is started with, never the parent's Context, services or Layers. A workflow's ordinary
preference goes in its definition's `agents`, not into every call, so `--model` still
reaches all of its work; one for a kind of work goes in `agents.roles`, keyed by the role
the work names, so a fork can move it; a preference written on one call is a deliberate
choice for that work, and wins over all of these. `roles` is a definition's alone: a scope
names harness, model and effort, which is what a child can be handed.

The three are decided together. A layer that switches harness keeps nothing chosen below
it, so a model named for Claude never follows the work onto codex: what is left open is the
chosen harness's own default. A combination the harness does not take — a model it does not
know, an effort it has none of — is refused with what it would take, never quietly
replaced; a Run's own is checked before it starts, and anything else before its agent is.

The choice is recorded before the agent is launched, as the work's own Activity, so a
recovery, a revival and a restart start the agent the work was given, whatever is
configured by then. An agent that is already running under the work's `agent` name is the
conversation this continues, and a conversation cannot become another agent: what is asked
for at the work itself — its options, or a scope around it — has to agree with what it is
running as, and one that does not is refused rather than ignored. What only defaults below
that decides for fresh agents alone. `permissions` is none of this: preferring a model never
changes what an agent is allowed to do, or which commands Collie may run for the Run.

### Claude subagent policy

`claudeSubagents` belongs to agent preferences: operator defaults, a Workflow's `agents`,
its role seats, `withAgents`, and an `agentWork` call. Its individual fields merge in the
same order as other preferences. Explicit `false` overrides an inherited `true`.

For a Workflow with `implementer` and `researcher` roles, this is an `agents` declaration:

```ts
agents: {
  claudeSubagents: { model: "sonnet", maxDepth: 1, maxConcurrent: 2 },
  roles: {
    implementer: { claudeSubagents: { enabled: false } },
    researcher: { claudeSubagents: { cacheTtl: "1h" } },
  },
}
```

The parent agent's Model remains its own preference. The `model` inside `claudeSubagents`
is a fallback for native workers. Add `forceModel: true` to request enforcement, subject
to [Claude's exceptions](using.md#claude-subagents). The available fields are `enabled`,
`model`, `forceModel`, `cacheTtl`, `maxDepth`, and `maxConcurrent`.

A Harness switch clears an inherited Claude policy alongside the old Model and effort.
Pi, Codex, and OpenCode receive none of its settings. An explicit policy on later Claude
work supplies a new choice; it does not recover one discarded by a Harness switch.

Scopes carry policy into child Runs as a serialized host option. It is recorded with the
agent choice before launch. A running agent keeps its policy: changed defaults apply to
fresh agents, and incompatible policy explicitly requested by a call or scope is refused.
Do not use a settings edit to reconfigure an existing conversation.

Malformed values and unknown models are refused before an affected agent launches.
The force override requires a model after inheritance. `cacheTtl` accepts `5m` or `1h`;
limits require positive whole numbers. No policy is supplied by default.
See the [operator guide](using.md#claude-subagents) for native precedence, compatibility,
and the cost of longer retention.

### When a Subscription is running out

Work runs on its preferred agent until that agent's **Subscription** is **Exhausted**, then
on the first entry of the human's `fallbacks` setting that has usage left
([ADR-0049](adr/0049-work-goes-to-an-agent-with-usage-left.md)). That is the default, and
a workflow sets nothing for it. Two more preferences let a workflow decide sooner:

- `upTo`, a percentage from 1 to 100: past that share of the busiest window that applies
  to it, this agent is not chosen for new work;
- `otherwise`, the choices to try past that point, in order, before the human's chain. Each
  fills in from the preference it follows, so `{ effort: "medium" }` is the same harness and
  model at less effort, and one that names another harness starts from that harness's
  defaults.

They layer as harness, model and effort do: the nearest layer that names either one sets
both, and a layer that switches harness clears both. Neither is handed to a child; the
chain applies there anyway. An `otherwise` entry its harness does not take is refused like
any bad choice. Three policies, each one line of a definition:

```ts
// A cheap model for a light step.
agents: { roles: { griller: { model: "haiku" } } },
// The strongest model for planning while budget allows.
agents: { model: "opus", effort: "xhigh", upTo: 90, otherwise: [{ model: "sonnet" }] },
// Less effort when a window is nearly spent.
agents: { effort: "xhigh", upTo: 80, otherwise: [{ effort: "medium" }] },
```

The agent the work landed on is recorded with what it fell back from and why, and the Run's
record says so. An agent that runs out in the middle of its work is closed and replaced by
one on the next choice with room, given the same work and a hand-over; each step is its own
Activity, so a restart continues with the agent it recorded rather than starting another.
Where work names an `agent` shared across operations, the agent that took over is that
agent from then on: later work naming it goes to the new one, and asking for what the
first one was — `harness: "claude"` for an implementer now on codex — is not refused. A workflow that wants any other policy reads the Machine's usage from its
`Host` and judges it with `usedFor`, which returns the busiest applicable window's percent,
its reset and whether the Subscription is Exhausted, or null where nothing is read for it.
`subscriptionOf` says which Subscription a choice draws on. Read it inside an Activity of
the workflow's own, so a replay takes the same branch:

```ts
run: () =>
  Effect.gen(function* () {
    const host = yield* Host;
    const nearlySpent = yield* Activity.make({
      name: "budget",
      success: Schema.Boolean,
      execute: Effect.gen(function* () {
        const used = usedFor(
          yield* host.usage(),
          { harness: "claude", model: "opus" },
          yield* Clock.currentTimeMillis,
        );
        return used !== null && used.usedPercent >= 80;
      }),
    });
    // …
  }),
```

## Panels: several agents for one role

A role in `agents.roles` may be given a list of seats rather than one — a panel. A `Seat` is
a harness, model and effort, and optionally a `persona` it is started as in place of its
role's, `instructions` it is told in place of its work's own (filled from the same input),
and a `name` to tell its work apart from the others'. `panelOf(role)` is the panel the
definition seats, and `agentWork({ seat })` sits one piece of work at one seat. Nothing else
is decided for you: run the seats together, one after another, or pick one — a panel is a
list, not a step.

```ts
export default defineWorkflow({
  id: "consulted-plan",
  agents: {
    roles: {
      planner: { harness: "claude", model: "fable" },
      consultant: [
        { harness: "codex", model: "gpt-5" },
        { name: "risks", harness: "pi", model: "openai-codex/gpt-6-astra", persona: "skeptic" },
      ],
    },
  },
  run: ({ input }) =>
    Effect.gen(function* () {
      const draft = yield* agentWork({ operation: "draft", role: "planner", instructions: DRAFT });
      const advice = yield* Effect.forEach(
        yield* panelOf("consultant"),
        (seat, at) =>
          agentWork({
            operation: `consult-${seat.name ?? at + 1}`,
            role: "consultant",
            seat,
            instructions: CONSULT,
            input: { draft },
          }),
        { concurrency: "unbounded" },
      );
      return yield* agentWork({
        operation: "revise",
        role: "planner",
        instructions: REVISE,
        input: { advice: advice.join("\n\n") },
      });
    }),
});
```

A seat's agent sits where its role's preference does — over the definition's own, under a
Run's `--harness`, `--model` and `--effort`, a scope, and the work's own options — so a Run
that names a model without a harness asks every seat for it, and a seat on a harness that
does not take it is refused. Work for the role that is given no seat takes the agent of the
role's first seat and keeps its own persona and instructions: the shipped review's
synthesis is reviewer work that sits at no seat. A role given no seat, or an empty list, is
a panel of one seat that prefers nothing of its own.

Because the panel is part of the definition, a fork seats its own and keeps everything else:

```ts
export default defineWorkflow({
  ...review,
  id: "review",
  agents: {
    ...review.agents,
    roles: {
      ...review.agents?.roles,
      reviewer: [
        { harness: "claude", model: "opus", effort: "xhigh" },
        { name: "pi", harness: "pi", model: "openai-codex/gpt-6-astra", effort: "max" },
      ],
    },
  },
});
```

The shipped review, and implement's review rounds, run one reviewer per seat of the
`reviewer` panel at once and reconcile them on the first seat.

## Where your Run is, and what it was given

`host.place(runId)` is the Run as the host admitted it, and it is how a module that was not
handed a path still knows where to work. The host's own calls take the Run's id, which is
`(yield* Run).id`.

```ts
const place = yield * host.place((yield * Run).id);
// place.cwd       — where this Run works: its own worktree, or the checkout it started from
// place.dir       — this Run's own directory, made as you ask for it
// place.options   — the host's own launch options: branch, task, workspace, repo, outcome,
//                   risks, previous, harness, model, effort
// place.task      — the Task it belongs to, whose workspace its agents open in
// place.workspace — a workspace of its own, where the Run asked for one; null otherwise
// place.lineage   — this Run, then the Runs it was started from or builds a plan of, and
//                   so on: whose agents `askRoute` and `handOffWork` may reach
// place.authority — the branch this Run created, whether it roams, and the human door and
//                   words that started it: what a Claude agent's auto mode is told
```

`place.cwd` is decided before your body runs. A workflow that
[declares](#what-a-definition-declares) `checkout` is given a worktree of its own there;
every other one works where it was started, and a child where its parent works. One call
moves it: `host.checkoutReviewed(runId)` asks for the checkout of the branch the Run's
diff target names — the one git already has, or one cut from that branch — and records it
as the Run's own, so read `place` again after it rather than keeping `place.cwd`
([ADR-0054](adr/0054-a-reviews-fix-works-in-the-reviewed-branchs-checkout.md)). It answers
`{ cwd, branch }`, or `{ refused }` in the resolver's own words where the target has no
branch to work on; asking again answers from the record. Take it inside an `Activity`, so a
replay does not cut a second checkout. Shipped `review` takes it before its own fixer starts.
`host.reviewedBranch(runId)` answers `{ branch }`, or the `{ refused }` the checkout would
give, by the same resolution, and cuts and records nothing; shipped `review` asks it before
its first menu, so a fix that cannot run is not offered.

`place.dir` is where what a Run produces belongs, and where the things that read a Run look:
a plan's tickets under `plan/issues/`, a review's prose in `review.md` and its findings in
`findings.json` — `leaveReview` writes both. A card counts those; nothing counts a Run's
prose. `findingsIn(dir)` reads the findings back. After a last fix `settleFinalFix`
accepted, `leaveOutstanding(dir, outstanding)` leaves the findings it says still stand, and
the review's prose as it was. Shipped `implement` also leaves every blocking dispute still
the human's among them at its own severity, whichever review wrote last, so the card counts
it.

`place.options` is the other half of the launch. The names in `RESERVED_INPUTS` are the
host's, so they are never in your payload — a caller asking for extra review axes or naming
an earlier Run to compare against is doing it there, and this is where you read it.
`outcome` is the one that can change while the Run is live, with `run intent set-outcome`:
read it again, inside an `Activity`, wherever the kind decides something.

`host.post` puts a file on the merge request a Run was pointed at, as one note Collie sends
rather than an agent writes out again, through the merge request's own forge. With
`approve`, it approves it too — the shipped review passes it when nothing live is left to
fix — and the message says whether the approval landed. Its refusal is its message: not a
merge request, no CLI or login for its forge, or one assigned to whoever is running this —
whose findings are theirs to fix rather than to post to themselves.

`mrForgeFacts(target)` is pure: for an `mr:` target it gives the forge's name and noun and
the `diff`, `view` and `checkout` command lines a prompt hands a reviewer, written by that
forge's adapter, and null for any other target. `target_repo` is still filled in for a
fork that reads it: `--repo <project>` is what both CLIs take.

`host.config(dotted)` is one value from the operator's own configuration, and empty where
they have set none. What a workflow must not hard-code — which team it files issues with,
where this installation keeps its logs — is asked for here rather than written into its
prose, so the same workflow is usable by somebody else.

`host.mr({ cwd, target?, source? })` is whether a merge request can be opened from here and
what it would carry, on the checkout's own forge (or the target's, where it names one):
the assignee — `<forge>.assignee` from the user's config, else that forge's login — the
repository's own template, the issues the branch answers. `forge` is `GitLab` or `GitHub`
and `noun` is `merge request` or `pull request`; `provider` is `gitlab` or `github`, and
`repository` the repository's path for `--repo`. `url` is the repository's web address as
its forge's adapter writes it, and `branch` the checkout's branch, empty on a detached
one: the facts a Clearance names. `existing` is the URL of this branch's
open one, or empty, and `autoMerge` whether it merges itself once green — a step that
pushes to it should not run. `commands.create` and `commands.comment` are the command
lines an agent runs to open one (with `<title>` and `<file>` left to fill in) or to note on
`existing`, written by the forge's adapter so a prompt names no CLI of its own.
One question rather than two,
because a step that cannot reach its forge has
nothing to fill in — check it before you start an agent, and say the reason where it is no.
Once one is open, `host.mergeRequest(runId, url)` records it as a fact of the Run: its card
links it, waits on it, and follows what the forge says of it.

`host.integrate(runId, cwd)` fetches the default branch and, where it has moved, merges it
into the branch checked out at `cwd` with a merge commit: never a rebase, never a push.
It answers with an `Integration` (`IntegrationSchema` journals it):

- `unchanged`: the branch already contains the default branch.
- `merged`: the default branch was merged in.
- `conflicted`: the merge is left in progress, naming its `files`, for an agent to finish. A
  merge still unfinished is answered the same way, however often it is asked about.
- `waiting`: the checkout had uncommitted changes, untracked files among them, and was left
  alone.
- `unavailable`: nothing was merged, with the `reason`: no default branch, a fetch that
  failed, one that cannot be read, or a merge git refused without a conflict.

`ref` and `sha` are what the branch is measured against from then on, so a reviewer's diff
is `<sha>...HEAD`. Each merge is recorded in the Run log as `integrated <branch>@<sha>`.
Take it inside an `Activity`, so a replay does not merge again. Shipped `implement` calls it
before every ticket after the first, before every review round and before the gate's fresh
review, and goes on only from `unchanged` or `merged`.
The shipped `renovate` workflow still requires GitLab for its merge and release commands.

`host.report(since)` reads this Machine's Runs admitted at or after an ISO moment. It
returns the same report as `collie --json run report --since`: workflow tallies, metrics,
failed and completed results, stopped Runs, and a `runs` list. Each list entry has
`runId`, `workflow`, `parent`, `project`, `created`, and `status`. An invalid date fails with
`WorkflowError`. Read it inside an Activity when its answer decides subsequent work.

`host.skill(name)` answers the installed `SKILL.md` that `{{skill:name}}` would name to an
agent, or `null` where this Machine has none. Check it in an Activity to fail before any
agent starts on a skill the work cannot do without.

`host.issues(runId)` lists the open issues of that Run's checkout, each with `number`,
`title`, `body`, and `url`. The checkout's remote decides its forge.
`host.fileIssue({ runId, title, body })` returns the filed issue's `number` and `url`.
`host.commentIssue({ runId, number, body })` comments on one there.

Before filing or commenting, the host redacts credential-shaped values with the
Conversation's redaction. It refuses text naming another checkout under the Projects
root, by absolute path or remote path, and names the checkout in `WorkflowError`.
A `.git` that leads to no Git directory, such as a tool's copy of a submodule, is not a
checkout: it is refused only by its path. A real repository Git cannot read stops the check.
Both safeguards cover the title and body when filing. A refusal sends nothing to the
forge. The Run's own checkout and repository remain valid references.

These operations fail with `WorkflowError` when the forge refuses or returns an
unreadable answer. If creation returns no issue URL, inspect the repository before
retrying; the issue might already exist. Workflows call these methods directly and
never construct forge CLI commands.

`host.claim({ runId, cwd, adopting, say, deploys })` blocks until this Run holds every shared
claim it needs, each recorded on the Run, and answers `{ slugs }`; `{ unresolved }` says why
they could not be settled, with nothing claimed, and what to do then is your workflow's
call. Without `deploys` it needs the repository's own project. With `deploys`
(`{ applications, jobs }`), it also needs each project of the repository's group that an
application or a deploy job's name (`stage:spilnu`) names. A repository's
`.collie/helle.json`, `{"projects": [...]}`, overrides both, and `[]` declares none.
`ClaimedSchema` journals the answer. Waiting here costs wall clock and no model tokens,
which is the point of claiming before an agent starts rather than after. `adopting` is your
own durable question, asked only where a claim was already the operator's;
`host.release(runId)` gives them all back, and only a Run that finished its work should; it
answers the slugs Helle would not take back, which stay recorded for a later release.

`host.defaultHead(cwd)` is the commit origin's default branch is at now, and fails where
origin cannot be read; take it inside an Activity, so a replay reads the same commit.

`host.merge({ runId, cwd, head })` merges the merge request the Run recorded with
`host.mergeRequest`, at `head`, through the forge's REST merge: never an admin merge, never
auto-merge. It fails with `WorkflowError` for a Run that recorded none. Before the forge is
asked it writes the Run's landing record, which the Run's view shows as `landing`, and
after, what came of it. It answers a `MergeOutcome` (`MergeOutcomeSchema` journals it):

- `Merged`: this call merged it, at `sha`, and the landing is recorded landed.
- `HeadMoved`: the merge request's `head` is no longer the one asked for; nothing merged.
- `MergedOutside`: someone else merged it first, at `sha`, `by` whom and `at` when.
- `Refused`: the forge's `reason`, such as a conflict or a merge request already closed.

The landing is what keeps the merge watch from stopping this Run, and the Runs it was
started from, when the merge lands ([The merge watch](internals.md#the-forge-boundary)).
Take it inside an `Activity`, as `integrate` and `defaultHead` are: a replay after a host
restart settles the attempt it left on the forge's word rather than merging again.
`host.awaitProduction({ runId, cwd, sha, jobs, played, slug, url })` blocks, at no token cost, until
the forge shows production carries `sha`, polling every five minutes. Meanwhile the card
says what it waits for: `jobs` are the production jobs, `slug`, where the Run holds a claim,
is the claim held, and `url` the repository. Jobs left for a person to play park the Run as
Needs you; with `played: true`, or no jobs, the wait is awaited under Working, as nobody has
to act. It answers
`true` once production carries the commit, and `false` where the Run was stopped or held
first. A forge that cannot say keeps it waiting.

`host.review({ runId, cwd, proved, seen })` reads the review of the merge request the Run
recorded once, judged against `proved`, the head its Checks were proved on, and answers a
`ReviewStanding` (`ReviewStandingSchema` journals it): `Merged` (at `sha`, `by` whom and
`at` when), `Closed`, `Moved` (the head is no longer `proved`), `Unanswered` (external
comments nobody answered, other than those named in `seen`), `Ready` (approved, green and
mergeable at `proved`, with its `approvers`), `Waiting` with `why` it is not, or
`Unreadable` with the forge's `reason`. A repository with no pipeline has none to wait for.
`host.awaitReview` takes the same options and reads every five minutes, at no token cost,
until the standing is anything but `Waiting` or `Unreadable`, or a Hold or Stop ends it as
`Held`. Meanwhile what it waits for that comes by itself — CI, a teammate's approval, review
threads resolved, the forge — is recorded as the Run awaiting it, under Working with no
notification ("Waiting for CI and a teammate's approval on `<mr>`."), until it has waited 2
hours (2 days for a person) and parks; a red pipeline, changes requested or a merge the
forge refuses parks it as Needs you while it keeps reading. Both are cleared when it returns. Take either inside an Activity, and suspend on `Held`
there, so a resume waits again.

`host.reply({ runId, cwd, comment, body })` replies to the comment with id `comment` on
the merge request the Run recorded, posting `body` as it is, in the comment's thread where
it has one. It never resolves a thread. It answers `posted`, or `already` where the forge
reads the comment as answered — as after a restart that posted the reply before its
Activity was journaled — and fails with `WorkflowError` when the forge refuses. Take each
reply inside an Activity of its own. `host.reviewHead({ runId, cwd, commits })` reads the
merge request's `head` as the forge reports it, which of `commits` it `carries` once
origin is fetched, and the ids of its external comments still `open`. `settleAnswers`
turns a comment round's answers into the replies they earn and the comments `carried` to
the next round: a `fixed` answer counts only where the head carries its commit.

`host.fastForward({ runId, cwd, head })` fetches origin and fast-forwards the checkout to
`head`, writing the move to the Run's log. It answers `At` with the `head` and where it
moved `from`, or `Refused` with `why`: a checkout with uncommitted changes, a head origin
lacks, or one that does not fast-forward, as after a force push. Nothing is reset or
discarded.

`host.readTag({ runId, cwd, tag, merged, pipeline, proves, stage, production })` reads a
tag back from origin and the forge rather than from an Output, against what it must prove.
Either way the tag is on origin and carries `merged`, and a pipeline counts only where the
forge shows it ran for that tag, at the commit it tags, in the merge request's project.
`proves: "finished"` is a package's: its pipeline — `pipeline`, or where that is null the
newest the forge shows the tag started — finished and succeeded by the forge's word, and a
tag with none at all is proved. A job waiting for somebody to start it by hand has not
finished, and `Unproved`'s `why` names it.
`proves: "staged"` is an application's, read from the forge's deployments and the tag's
pipeline, whose own state is not read: `InProduction` where production already carries
`merged`; `StageFailed` with `why` where one of the `stage` jobs failed or stage's newest
successful deployment does not carry `merged`; `Unproved` where any other job failed or is
still running or waiting to run, a named job is missing or unfinished, or no `production` job waits to be started by
hand; else `Proved`, with each `production` job and its address (`JobLink`), and `at`, the
tag's object on origin.

`host.readProduction({ runId, cwd, tag, at, merged, pipeline, jobs })` reads again before
production jobs are played, where `at` is `Proved`'s: `Carried` where production already
carries `merged`, `Unproved` with `why` where the tag on origin is no longer `at` or no
longer carries it, one of `jobs` is gone or failed,
or any other job failed or is still running or waiting to run, else `Play` with those still waiting to be started by hand — none where somebody
already started them. `host.readRollback({ runId, cwd, off })` answers `Shown` where
stage's newest successful deployment no longer carries `off` — the merged commit, or the
merge request's head staged unmerged — and carries what production's has, else `Unshown`
with `why`.

`host.takeOverLanding({ runId, cwd })`, for a merged merge request the Run recorded, takes
over the landing of the newest Run on this host that landed it, where that Run ended
without succeeding and the forge's merged commit is the one it recorded. It answers
`TakenOver` with the Run it came `from`, the `sha`, the `head` and the `failure`, or
`Refused` with `why`: merged outside a Release Run, already released, still being
released, or merged at another commit. Each of these calls takes its place inside an
Activity. `readMrRef`, `mrUrlOf` and `forgeOfRef` turn a merge request input into its
reference, its URL and its forge.

## Markdown as content

A workflow's Markdown is what its agents are told, and nothing else: what it takes, what it
does and what it asks are its definition's, where they are checked, so `contentOf` refuses a
file with front matter. `contentOf(markdown)` reads the file as what stands above its first
heading and one entry per `## name` section below it, and `content.template(section,
fields)` is that section, with the preamble above it, as a template:

```ts
import markdown from "./architecture.md" with { type: "text" };
const content = contentOf(markdown);
const attended = content.template("attended", { run: Schema.Struct({ dir: Schema.String }) });

agentWork({ operation: "architecture", instructions: attended, input: { run: { dir } } });
```

`template(text, fields)` is the same for text of your own — a template literal, a string
built in code. The fields are a `Schema.Struct`'s, and they are the whole of what the text
may name besides `{{role}}`, `{{cwd}}`, `{{output_path}}` and `{{skill:name}}`: a name they
do not declare, or a `{{…}}` that is not a name, throws where the template is made. Made
where the module loads, as the shipped ones are, it is checked by every load of that module,
so `collie workflow check` and `collie doctor` report it against the workflow it is in. A
section the file does not have is refused the same way, never sent empty.

A name under `inputs.` whose value is the empty string renders as `not given`, so an Input
the Run was not given is said rather than left as a blank the agent has to interpret.

## Waiting for a human

`ask({ name, prompt, options })` asks a human and waits for the answer. It is asked when the
work reaches it — on one branch and not another, once per item of a list — and nothing
declares it ahead. Wait with `ask` and not with `DurableDeferred.await`: `ask` tells the
host what the run is waiting on, and a host that does not know that cannot show the
question, cannot refuse an answer to one nobody asked, and cannot tell a second answer from
the first.

- **`name` is its identity.** The same name is the same question, however often the work
  replays; a question inside a loop is named after its item, never after its position.
- **`options` is what it takes.** An answer outside them is refused before your workflow is
  told anything. Leave it out for a question answered in the operator's own words.
- **One answer, whoever sends it.** Two answers racing make one piece of work; the second is
  refused with what the run already has, and retrying one under the same request id is the
  same answer rather than another.
- **The question survives a restart**, and so does its answer. What is waiting is in
  `run show`, and `run answer <run> <value> --decision <name>` settles it.

## A workflow made of other workflows

`child({ invocation, workflow, input })` starts another workflow as part of this one and
waits for it. `workflow` is a public id, selected in your Run's own project, so a
project that overrides that module overrides it here too; `"self"` is your own, whatever a
fork has renamed it to. Importing a function from a file beside yours does the opposite on
purpose: the file decides, and no lookup happens at all.

- **`invocation` is the identity.** The child's Run id is your Run id and this name, so
  replaying your body asks for the child you already have rather than a second one, and a
  different name is a different child. Giving one invocation different input later is
  refused, not run twice. The child is reached under the execution it was admitted with,
  so a Collie upgrade that derives executions differently resumes it rather than starting
  it again.
- **The child's schema decides.** Your input is decoded against the child before anything
  exists. A value it will not take is your workflow's failure, naming the field, with no
  child Run and nothing to clean up.
- **It belongs to you.** The child carries your Run as its parent and your Task as its Task,
  it shows up in `run list` beside you, and interrupting you reaches it. It does not belong
  to whatever client asked for your Run — that can go, and neither of you notices.
- **It prefers the agents you do** where you start it, unless its options say otherwise.
- **`ownTask: true` makes it work of its own.** It is admitted as a fresh start is: its
  Task's name is inferred from its work, it joins the Task whose work it is about — one
  whose Runs opened or were given its merge request, or an open one whose Runs were placed
  on its branch — or a Task workspace is opened on its checkout. So it has its own card and is
  released on its own merge request. It is still yours: its parent is your Run, you wait
  on it, a stop of yours reaches it, a replay reuses it, and it is in your Lineage. Your
  card does not list it.

How many children there are, and in what order, is TypeScript:

```ts
const graded =
  yield *
  Effect.forEach(input.notes.split(","), (note) =>
    child({ invocation: `grade-${note}`, workflow: "graded", input: { note } }),
  );
```

Name the invocation after the work, not its position in a list: a list that is reordered
between attempts must not hand one item's child to another. `children.start` and
`children.result` are the same thing in two halves, for starting several before waiting on
any of them.

`options` is the host's own — `repo`, `workspace`, `branch`, the names in
`RESERVED_INPUTS` — and nothing else is taken: a parent cannot put a field into a child's
payload that its author never declared. Where the child works is not among what you pass:
it starts from where its parent works and is placed on whatever checkout it declares, in
the parent's Task. `workspace` is only for a child that works somewhere else — a
repository's own checkout, or `new` for a worktree workspace of its own. It is how a
repository gets its share of a plan that spans several:

```ts
// A plan that cannot be read fails with a PlatformError; say so rather than die of it.
const plan =
  yield *
  planReposOf(asked.plan, asked.root).pipe(
    Effect.mapError((cause) => new WorkflowError({ reason: `unreadable plan: ${cause.message}` })),
  );
if (plan.refusal !== null) return yield * new WorkflowError({ reason: plan.refusal.message });
for (const wave of plan.waves) {
  yield *
    Effect.forEach(
      wave,
      (repo) =>
        child({
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
to clean up. A Run whose work source is such a plan, and which was given no `repo`, is
placed as that parent: the host cuts it no checkout, since each repository's Run cuts its
own, and refuses to start it at all where the plan cannot fan out.

[ADR-0022](adr/0022-a-workflow-is-made-of-workflows.md) is why each of those is the way it
is, and why nothing here is a dependency resolver.

### A checkout another tool makes

A tool that makes a development environment often cuts the checkout too. bodil's
`bodil remote up <brands> <name>` cuts `worktrees/<name>/monorepo` on a branch of its own,
and `bodil remote down <name>` stops the instance. A workflow wraps such a tool around a
child: its "up" in an Activity, and the child given the tool's worktree as its `workspace`
and the tool's branch as its `branch`. Where the tool's instance should not outlive the work,
its "down" goes in an Activity once the child has settled, however the child ended. bodil's
is left up, because it is what the human checks the change in.

The child's `checkout` resolves to the worktree the branch already has, as it does for any
checkout already on the branch. Collie records it as not made by Collie
(`created_by_collie: false`), so pruning never removes it, and replaying the parent does not
run "up" again, since the Activity recorded it. Collie has no option for any such tool: the
module is the tool's, and moves with the tool's commands. This is the one for bodil, which
belongs with bodil's own install script and, until then, in
`~/.collie/user/workflows/bodil.workflow.ts`:

```ts
// implement, in a bodil instance. `bodil remote up` cuts the worktree and its branch,
// implement works there, and the instance is left up to check the change in.
// bodil reads the VM from BODIL_REMOTE_VM itself.

import { Host, Run, WorkflowError, child, defineWorkflow } from "collie";
import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Activity from "effect/workflow/Activity";

/** What a command printed, or its own words where it fails. */
const sh = (command: string, args: ReadonlyArray<string>, cwd?: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const ran = yield* spawner.spawn(
      ChildProcess.make(command, args, { cwd, stdout: "pipe", stderr: "pipe" }),
    );
    const [out, err, code] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(ran.stdout)),
        Stream.mkString(Stream.decodeText(ran.stderr)),
        ran.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (code !== 0) {
      return yield* new WorkflowError({ reason: err.trim() || `${command} exited ${code}` });
    }
    return out.trim();
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (cause) => new WorkflowError({ reason: cause.message })),
  );

export default defineWorkflow({
  id: "bodil",
  title: "Implement a plan in a bodil instance",
  description: "Brings a bodil instance up, implements the plan in its worktree, and leaves it up.",
  input: Schema.Struct({
    plan: Schema.String,
    /** What `bodil remote up` brings up, such as `happytiger`. */
    brands: Schema.String,
    /** The instance, and so its worktree and branch; the Run's task name where not given. */
    name: Schema.optionalKey(Schema.String),
  }),
  hints: { plan: "work-source" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const place = yield* (yield* Host).place((yield* Run).id);
      const name = input.name ?? place.options.task;
      if (name === undefined) {
        return yield* new WorkflowError({ reason: "name the instance: --input name=<name>" });
      }
      yield* Activity.make({
        name: "up",
        success: Schema.String,
        error: WorkflowError,
        execute: sh("bodil", ["remote", "up", input.brands, name, "--detach"]),
      });
      const checkout = yield* Activity.make({
        name: "checkout",
        success: Schema.Struct({ worktree: Schema.String, branch: Schema.String }),
        error: WorkflowError,
        execute: Effect.gen(function* () {
          const worktree = `${yield* sh("bodil", ["root"])}/worktrees/${name}/monorepo`;
          // Read, never derived, so bodil's rule for naming its branch stays bodil's.
          const branch = yield* sh("git", ["branch", "--show-current"], worktree);
          return { worktree, branch };
        }),
      });
      return String(
        yield* child({
          invocation: "implement",
          workflow: "implement",
          input: { plan: input.plan },
          options: { workspace: checkout.worktree, branch: checkout.branch },
        }),
      );
    }),
});
```

`name` is optional: without one the instance is named after the Run's task. The VM is
bodil's own `BODIL_REMOTE_VM`, which bodil reads itself. The branch is read from the
checkout rather than worked out again, so bodil's rule for naming it stays bodil's. `up`
passes `--detach` because bodil's foreground mode holds until it is stopped, so the Activity
would never finish. The instance outlives the Run, however it ended, so the human can check
the change in it; `bodil remote down <name>` takes it down once they are done.

## Steps, and the path a Run expects

A **Step** is a value made where its work is written, the way Prefect declares a task. Its
metadata is what a reader needs before it runs: an `id`, a `title`, a `description`, its
`kind` (`agent`, `question`, `workflow` or `check`), its `role`, and what it `produces`
(`plan`, `review`, `evidence` or `merge-request`). Called around an Effect, it runs that
Effect unchanged — no retry, timeout or schedule of its own — and records with the host when
the work enters it and leaves it. An agent's work, a question, a child or a check pass made
inside it is recorded as the Step's.

```ts
import { agentWork, ask, defineWorkflow, forecast, step } from "collie";

const build = step({ id: "build", title: "Build it", kind: "agent", role: "implementer" });
const decide = step({ id: "decide", title: "Ship it?", kind: "question" });
const slice = step({ id: "slice", title: "Build a slice", kind: "agent" });
const review = step({ id: "review", title: "Review", kind: "agent", produces: "review" });

export default defineWorkflow({
  id: "stepped",
  path: [build, decide, review],
  run: () =>
    Effect.gen(function* () {
      yield* build(agentWork({ operation: "build" /* … */ }));
      yield* decide(ask({ name: "go", options: ["yes", "no"] }));
      // Once the Run knows its branch, it may forecast again.
      yield* forecast([build, slice, review]);
      yield* Effect.forEach(items, (item) => slice(agentWork({/* … */}), { item, items }));
      for (const round of [1, 2]) yield* review(agentWork({/* … */}), { round, of: 2 });
    }),
});
```

A call may give its place: `{ item, items }` for one item of a list, which is a
[Slice](#a-list-of-work-one-item-at-a-time), or `{ round, of }` for a round under its bound.
Each call is one run of the same Step, so a Step called per item is one node with a run per
item, and the items it has not reached yet are expected runs.

`path` lists the Steps the Workflow expects to take, in order. A Step is known by its id, so
two values with one id are one Step, and a path that lists one id twice is refused by the
definition check. `forecast` replaces the path from there once the Run knows which branch it
takes; the Steps it drops are no longer drawn. A Step called off the path still runs and is
drawn after the Step that ran before it, and a path Step the Run never reached ends `not run`.
The records are Activities, so a replay records nothing twice, and the host is their only
writer ([ADR-draft-a-step-is-declared-where-its-work-is-written](adr/draft-a-step-is-declared-where-its-work-is-written.md)).

Work that fails in a way a resume can retry parks the Run rather than failing it. Call
`stepFailed(why)` before parking, and the Step it is in is drawn failed, saying why, until
the resume enters it again.

A module that declares no Steps still runs. Its Run's Flow is what happened — its Operations,
questions and children, titled by their names — and forecasts nothing.

## A list of work, one item at a time

A list is `Effect.forEach` over whatever you enumerated; what Collie adds is the two things
a list of _work_ needs.

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
      operation: ticket.file,
      agent: "implementer",
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
repository where you name one. Each ticket's `criteria` are its acceptance criteria, one per
checkbox under its Acceptance criteria heading (`criteriaIn` reads them from a ticket's
text); a ticket with no checkboxes has none. Skipping is your own `continue` with a reason
recorded: no agent, no tab and no Output written as though somebody had answered. An empty list is no
work, and findings are yours to carry — nothing here ends a list because an item found
something.

[ADR-0024](adr/0024-a-list-of-work-is-known-by-its-names.md) is why an item is known by its
name rather than its place.

## Reviewing and fixing, until it converges

A review/fix rally is a loop you write, over three functions every workflow shares. There
is no repeat declaration, no scheduler and no second reading of when a loop is done: every
rally converges, stands on a dispute and runs out of rounds where these three decide.

- **`splitDisputed(findings, disputed)`** — what is still the implementer's. A finding the
  implementer already rejected with a reason stops driving the loop; a reviewer who answers
  that reason with a `rebuttal` puts it back.
- **`settleRound({ live, disputed, at, seen })`** — where this round goes: `fix` with the
  blocking set that drives it, `clean` when nothing blocking is left, or `halt` when a
  dispute stands unanswered or the same blocking findings came back unchanged. `seen` is
  the previous round's `keys`; without it nothing can notice a rally going round.
- **`settleFinalFix(live, fix, evidence)`** — the last round has no review after it, so the
  fix's own account is what is left. Every blocking finding needs a disposition, and every
  check it names needs a passing verification on the tree as it stands. A fix that holds up
  but disputes a blocking finding comes back `dispute_unresolved`, with the same
  `attestation` a fix that stands carries, since the human reads both.

`ReviewOutputSchema`, `FixOutputSchema` and `SynthesisSchema` are the shapes those steps
write. Hand one to `agentWork` and what comes back is its own type — the same contract the
shipped steps are held to, not a copy of it.

## Proving it, rather than saying so

`host.evidence(runId, cwd)` is what has been verified for your Run and what the tree is
now. `settleFinalFix` reads it: a check an Output names is a claim until the journal has a
passing record of it, collected on this exact revision. A commit or an edit since makes an
earlier pass history — it is not that the result went off, it is that it is about another
tree.

`host.verify({ runId, name, cwd })` runs one of your Run's checks, in the directory the
check names, resolved from `cwd` — which has to be the Run's own checkout — and records
what it did. The checks are what the Run started with (`--verify`, else
`.collie/verify.json` as the Run's base has it, else the checks remembered for its remote,
else the user's `verify.json`; a follow-up started from a card starts with its parent's), plus whatever
anyone has named since with `collie run intent verification`
or chat's `set_verification`, the Run's own agent included. Nobody approves them
([ADR-0055](adr/0055-a-run-never-asks-to-run-its-checks.md)). A name not among them is
refused. Anyone else collects the same way from outside:
`collie verify -- <command>` in the Run's agent pane, or
`collie verify --run <your run id> -- <command>` anywhere else.
With `at: "default-base"` it runs at the merge-base of the checkout and its default branch,
in that same checkout so what the build installed is there, and then puts the checkout back;
a checkout with changes of its own, or no default branch to compare with, is refused.

Say why a check runs with `pass`: `"gate"` on the branch, `"rerun"` with one `test` it
failed on, `"recheck"` of the whole check on the same tree to rule out a flake, or `"fix"`
with `round: N` after gate fix N. Every door shows it while
the check runs — the card says `Running test again on the same tree to rule out a flake,
12 min of a usual 20.` — and the record keeps it after
([ADR-0042](adr/0042-a-check-collie-runs-is-seen-while-it-runs.md)). A check at
`"default-base"` is the `baseline` pass whatever you say, the checks Collie runs as a Run
finishes are its `finish` pass, and a check asked for with no pass is a plain `check`.
Collie never works a pass out from your workflow's id.

```ts
yield * host.verify({ runId, name: "test", cwd, pass: "fix", round: 2 });
```

A check's failed record names its failing tests as `failed` where its output is bun test's
and could be read whole: 20 or fewer, its fail count agreeing, and no error outside a test.
A `rerun` runs `bun test ./<file> -t <its whole name>` in the check's directory, from the
sources (a bare path is a filter bun matches against every file), and records it under the
check's name. It passes only where exactly one test ran and passed, and it is never the
check's own pass. `rerunsOwed` says which tests are still to be rerun, `wholeRunsOwed` which
checks only a whole recheck can tell, `recheckOwed` which of those have had no `recheck` on
this tree yet (ADR-0034, amended 2026-10-19), and `flakesOf` which failures were Flakes
(ADR-0034, amended 2026-10-15).

A test still failing after its rerun is run alone at the base with `at: "default-base"` and
that `test`, once per base revision and check directory. Its `baseline` record fails only
where bun ran that one test in one file and named it failing, so a test the base does not
have is the Run's own. `baselinesOwed` says which tests to ask the base about,
`baseFailuresOf` which also fail there, and `settledChecks` which checks failed only on
Flakes and such tests: neither a gap nor a pass.

```ts
for (const { check, test } of rerunsOwed({ ...evidence, approved }))
  yield * host.verify({ runId, name: check, cwd, pass: "rerun", test });
for (const { check, test } of baselinesOwed({
  ...(yield * host.evidence(runId, cwd)),
  approved,
}))
  yield * host.verify({ runId, name: check, cwd, at: "default-base", test });
```

A Check passes once per tree. The host answers with the latest record of exactly that
check's command (the executable as resolved, its arguments and its directory) on the tree
in front of it, without running anything, where that record is a pass collected in the same
[environment](cli.md#verify) since this host started. Who asked for it does not matter: an
agent's `collie verify` of the command is run by the host too. The Run log says
`<pass>: <check> relies on verification <id>`. Otherwise the check runs, and it always runs
with `expect: "fail"` or `at: "default-base"`, or where that latest record failed — as the
gate's recheck after a failure finds it. Your workflow decides nothing about this, so there
is no flag to ask for it.

`host.approved(runId)` is the Run's checks as they stand now, for a prompt to name what the
work will be held to — `renderApproved` writes it out — and
`renderEvidence(host.evidence(...))` is what was actually collected and by whom, for a
merge request to say what it proved. `renderRecordedChecks` writes the same journal for a
reviewer — the latest of each check, by whom, whether on the tree in front of it, when,
whether the same command was seen failing on an earlier tree, and the baseline — so a review reads what was run rather than running it again. The list can grow while the Run works, since an
agent may name a check, so read it again where you need it — at each gate pass, inside the
Activity that runs it, so a replay sees what that pass saw — rather than once at the start.
An empty list stops nothing: where your Run's kind of result needs checks,
`evidenceGapsOf` reports a gap that tells the implementer how to name them.

`evidenceGapsOf` is the gate itself: what a Run of this kind still has no evidence for, one
sentence each, and empty where the evidence is there. It reads the journal, the Run's
checks, the Outputs you hold and the tickets you built — and it will not take a reviewer's
judgement from an implementer's Output, because the agent that wrote the change cannot
vouch for its own scope. Only the latest result for a check on the tree in front of it
counts, so a pass a later fail on the same tree contradicts is not one. Each of the Run's
checks and each ticket's promised check still needs a passing verification on the current
tree, unless every test it failed on was a Flake or also fails at the base, by a `rerun` or
`baseline` record of that one test.

```ts
const gaps = evidenceGapsOf({
  kind: isOutcome(place.options.outcome ?? "") ? place.options.outcome : "unspecified",
  evidence: yield * host.evidence(runId, cwd),
  approved: yield * host.approved(runId),
  outputs: { build, synthesize },
  reviewed: ["synthesize"],
  roots: [place.dir, cwd],
  tickets,
});
```

`checkGapsOf` takes the same question and answers only the gaps a verification on this
tree could close: a check that failed, never ran, or passed on an earlier tree. Those are
what a fix may be handed. A reviewer's judgement and an Output's claim are not moved by
running anything, so a fix handed one spends a session and changes nothing. `reviewGapsOf` answers only the gaps a reviewer's verdict could close, such as
`scope_met`: a fresh review is worth paying for only while one of those remains.

Both read each check through `checkProof`, which you can call yourself. It gives a check's
proof on the tree in `evidence`: `passed`, `failed`, `unstable`, `earlier` (it passed only
on an earlier tree) or `never`, with its runs and the latest of them on this tree. A record
counts where it ran exactly that check's command, whoever asked for it. Where
`evidence.commands` does not name the check, records count by name: anyone's by default, or
only Collie's own with `"collie"`. A check [left to CI](cli.md#what-collie-may-run-itself)
(its spec has `ci`, the job's name) is only ever `waiting` on its job or `proved` by it, and
neither is a gap. `owedLocally` takes the Run's checks and returns those the Run runs itself:
every one but those left to CI. Loop over it, not over the checks, wherever your workflow
runs them.

```ts
const evidence = yield * host.evidence(runId, cwd);
const red = owedLocally(yield * host.approved(runId)).filter(
  (spec) => checkProof(evidence, spec.name).state !== "passed",
);
```

A check left to CI is proved by its job instead, with
`host.ciJob({ runId, cwd, name, wait })`. It reads the job through the forge adapter's one
read for it, the named job on the head commit of the merge request the Run recorded, which
must be `cwd`'s `HEAD`. On GitLab that is the job in the merge request's head pipeline, and
a merged-results pipeline counts for the head only where GitLab shows the merge commit was
built from it; on GitHub it is the check run of that name on the head commit. The adapter
answers `passed`, `pending`, `running`, `failed`, `skipped`, `cancelled` or `missing`, with
the job's URL, or why the forge could not say. A pass is recorded once per tree as the
check's `ci` pass, with `job` (`{ name, url, merge? }`, `merge` being the merged-results
commit) beside its command, start and end tree. That Verification answers `{ proved }`; anything
else answers `{ unproved, state, url }`, the sentence naming the check, the job and the
commit. With `wait: true` a pending or running job is read again every 30 s for up to 2
hours, the Run's log and `collie run checks` saying which check, job and commit it waits
on, and a stop ends the wait. `renderRecordedChecks(evidence, leftToCi)` tells a reviewer
each such check as `left to CI: proved by <job> on the merge request's head`, with the
job's state where you read one.

An unproved answer also carries `log`: the command line that prints the job's log, written
by the forge adapter (`glab ci trace <id> --repo <project>` on GitLab, `gh run view --job
<id> --log --repo <owner/repo>` on GitHub), so a prompt hands an agent the adapter's
command rather than naming a CLI of its own (ADR-0050). With `settle: true` a failed job is
settled first: the adapter reads the same job at the merge-base of the merge request's head
and its target branch, or on the target branch's latest pipeline where that commit has
none, and one that failed there too answers with `before: { at, url }` and is not retried.
Otherwise the adapter retries it once — GitLab's job retry, GitHub's rerun of that job —
and waits on it; a pass then answers `{ proved, retried: true }`, a Flake. Name either on
the merge request with `host.note({ runId, cwd, body })`, which puts a note on the merge
request the Run recorded.

```ts
for (const spec of (yield * host.approved(runId)).filter((one) => one.ci !== undefined)) {
  const read = yield * host.ciJob({ runId, cwd, name: spec.name, wait: true, settle: true });
  if ("unproved" in read) yield * host.parked(runId, read.unproved);
}
```

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
  launch already recorded. Suspension interrupts the current fiber. A race waiting for
  success can swallow that interruption while its other side keeps waiting. Use
  `Effect.raceFirst` at such a boundary so suspension reaches the enclosing Run.
- **Halting the agent is the host's half of a stop.** `run stop` also closes the panes of
  the Run's agents, and of the Runs it started, which is what stops them; the workspace
  keeps its own tab. When the Run resumes, work whose agent has gone and whose Output never
  came is given to a new one with the same prompt. Steering — `run steer`, and `Agents.steer`
  from a module — says something to a live agent through the one sender: `to` names a role
  (`builder`, `reviewer`, `planner`) or an agent, and with none it reaches the agent whose
  step is active, else the builder. It answers whether it was delivered, and with `observed`
  and `how`, whether the agent was seen to take it;
  `handOffWork` does the same from a workflow to the live agent in a role of a Run this one
  was started from, as review hands its findings to an implementer already building the
  work. It answers with
  the agent it reached, or null where none is live; a hand-off nobody can say arrived parks
  the Run until `run deliveries --reconcile` settles it, rather than starting a second agent.

[ADR-0021](adr/0021-one-host-answers-for-a-run.md) is why each of those is the way it is.

## What a definition declares

Beside what it does, a definition says what the workflow _is_, in the same object. None of
it is consulted by `run`, and all of it is read without running anything — a listing, a
card, a launch and a Run's Flow know it from the definition alone.

```ts
export default defineWorkflow({
  id: "echo",
  input: Schema.Struct({ text: Schema.String, times: Schema.Int }),
  hints: { text: "work-source" },
  outcome: { selectable: ["feature", "docs"] },
  agents: { model: "sonnet" },
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
  run: ({ input }) => Effect.succeed(input.text),
});
```

- **`path`** is the [Steps it expects to take](#steps-and-the-path-a-run-expects), in
  order: a forecast the Flow draws, never a precondition.
- **`agents`** is what the workflow's own work prefers, under anything a Run or a scope
  prefers: [which agent does the work](#which-agent-does-the-work).

- **`hints`** attach inference to a field. `goal`, `work-source`, `diff-target` and
  `repository` — a GitLab or GitHub repository URL, or a local checkout — are the launch
  strategies (`gitlab-repository`, its old name, is still read as `repository`, in a hint
  and in a recorded Run), and a module with inputs hints exactly one
  field with one of them ([one launch Input](authoring.md#writing-one)). They are exclusive: one field each, so renaming `plan` to `spec` changes
  nothing about how it is inferred, what it names a branch after, which label its Run is
  listed under, or which previous review it is given.
- **`outcome`** is `fixed` or `selectable`, never both. `selectable` offers only the kinds
  a human may ask an implement Run for — `review` and `plan` are what a workflow proves.
- **`checkout`** is what the workflow needs of the repository. `branch` builds on a
  worktree of its own, on the branch the host resolves for it; `roaming` is detached at
  the default branch and binds none. The host makes it before the Run exists, so a launch
  from a directory that is not a git checkout is refused naming that directory, and no
  Run, worktree, workspace or agent is left behind. Absent, the Run works where it was
  started.
- **`closes: "reported"`** asks the host to close this Run's agents once its report is delivered or recorded as undelivered. It closes the Task workspace only when no other Run needs it and every remaining pane belongs to this Run or is the Task's shell. A human pane or another Run's live agent keeps the workspace. Without the declaration, reporting leaves the agents open.
- **`followUps` and `actions`** carry an `id` that is stable and a `title` a human reads.
  Two fields, because a retitled action is the same action and a card matching on the
  title would start a different one. `workflow` is a public id or `"self"` for the one
  declaring it; `inputs` names what Collie fills in from the Run — `run-dir`, `plan-dir`,
  `diff-target`, `branch`, `merge-request`, or `started-with` for what the Run was started
  with under the same input name — so a card makes the offer without asking a human to type
  a path. `arguments` is the child's schema; eligibility is decided from facts, never from a
  workflow's name, and `facts.claim` is the shared claim a Run still holds. A follow-up says `when` — `succeeded`, `failed` or
  `always` — and may add an `eligible` of its own where how it ended is not the whole of
  it: an offer to carry on with a branch is not an offer where there is no branch. A
  follow-up runs on its Run's branch, in the checkout that branch already has, so it carries
  the work on rather than starting it again. It is started only once its Run has finished; a
  stopped Run counts only where it has no branch, since resuming it would work in the same
  checkout. A
  follow-up declares no `arguments`: it takes whatever inputs its workflow has that
  `inputs` does not fill, and a front door asks for those.

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
`task`, `workspace`, `repo`, `outcome`, `risks`, `previous`, `harness`, `model` and
`effort`. An input of one of those would be shadowed without you ever seeing it, so
declaring one is refused. `workspace` is decoded
before anything exists: `new`, or the absolute path of a directory. Anything else is
`invalid_input` naming it, and so is `new` for a workflow that declares no checkout.

## The shapes the shipped steps write

`ReviewOutputSchema`, `SynthesisSchema`, `FixOutputSchema`, `MrOutputSchema` and
`PlanOutputSchema` are exported so a step you write declares the same contract the engine
reads, rather than a copy of it. `FindingSchema`, `FixedSchema` and `CheckSchema` are the
pieces they are built from.

`CriterionSchema` is how a builder answers one of its ticket's acceptance criteria:
`criterion`, copied from the ticket, and `met`, the test or file that shows it, or
`not met: <reason>`, or `after merge: <reason>` where only CI, a merge or a deploy can show
it. Implement's `Built` carries them as an optional `criteria` list.
`unmetCriteria(ticket, criteria, answers)` turns each criterion left unanswered or not met
into a blocking finding against the ticket; an `after merge` answer is neither.
`afterMergeAnswers(criteria, answers)` is each criterion answered `after merge`, which
shipped `implement` names in its merge request as not settled by the Run. `answerFor(criterion, answers)` is the
answer a criterion has: one to its whole wording, where a copy that dropped the criterion's
formatting still counts, so an answer to earlier wording does not answer an amended criterion. Shipped
`implement` hands what is unmet back to the builder before any reviewer is launched, and
stops the work if any is still unmet after two hand-backs, so no reviewer starts on it. A
hand-back that leaves the head and fingerprint unchanged and reports a blocking finding is
asked about instead (`<ticket>.criteria-stalled-<n>`): `Hand back` reads the ticket again and,
if any criterion is still unmet, hands it back with two tries fresh; `Stop` stops the work. A text work
source's criteria are its own checkboxes; a Linear issue's are read from `plan/SPEC.md`, the
copy of its description the builder makes, and a copy that cannot be read stops the work. The reviewer's prompt
shows every criterion, its answer and the builder's assumptions. A workflow that never reads
the field is unaffected.

They are deliberately loose where judgement lives. `severity` is free text: `blocker`,
`major` and `minor` are what the shipped prompts ask for, but a fork's own word is a
judgement and only `minor` is non-blocking. `file`, `line`, `detail` and `rebuttal` are
optional: a reviewer with no line number has still said something worth reading. None of
them is closed against extra keys.

## JSON Schema

`jsonSchemaFor` draws a schema for a prompt or a listing, and says what the drawing does
not say:

```ts
const { document, limits } = jsonSchemaFor(Schema.Struct({ text: Schema.String }));
```

`document` is null when nothing could be drawn, and `limits` names each place the drawing
constrains nothing — a `Schema.declare`, for instance, becomes `{}`. Neither makes the
schema invalid. What is lost is the copy a model is held to at its own end; your workflow
is still held to the schema itself.

A `Schema.isPattern` is drawn as a `pattern` with or without the `u` flag, as long as its
source is known to match the same strings with it: printable ASCII with no `.`, no negated
class and no `\S`, `\W`, `\D`, `\p`, `\P` or `\u` escape. One whose flags change what it
matches, such as `i` or `m`, is not drawn either.

## Typechecking a module

```sh
collie workflow check echo
```

It imports the module, builds the workflow its definition is registered as and runs the
compiler over it — no run, no agent, no worktree. Each diagnostic comes back with its file and line, one module at a time: an error
in one says nothing about the one beside it.

Three answers, kept apart. A **problem** stops it running: it would not load, it exports no
definition, what it declares contradicts itself, or it does not compile. **`drawn without:`** is a place
the JSON Schema drawn for a prompt or a listing says less than your schema does — your
schema still holds. **`ok, not typechecked`** means no compiler is installed in that
directory; nothing compiled it, and it says so rather than reading as fine.

`collie workflow create <id>` writes the authoring setup — `package.json`, `tsconfig.json`
and `collie.d.ts` — into the directory, merging what it needs into a `package.json` or
`tsconfig.json` you already have without replacing anything of yours, and installs the toolchain with the executable's own embedded Bun, so neither Bun nor Node has
to be on the machine. The `effect` it pins is the one the host runs.

Effect 4.0.0 moved the workflow modules from rc.117's `effect/unstable/workflow` to
`effect/workflow`. A module still on the old path loads and runs until Collie 0.42.0, and
`collie workflow check` reports the old path as a problem, which is how you hear of it.

## Effect stays yours

Collie makes the common cases convenient; it does not stand between you and Effect.

- **An Activity of your own** is `Activity.make`, recorded and replayed like the ones
  `agentWork` makes.
- **A service of your own** is an ordinary `Context` service and Layer, through `layer`.
- **Concurrency** is `Effect.all` and `Effect.forEach`.
- **A typed failure** stays typed, through `error`, and is encoded by its schema.
- **A command of your own** is Effect's `ChildProcess` (`effect/process`) through the lent
  `ChildProcessSpawner`, inside an Activity so that replay does not run it again.
- **A direct model call** uses Effect's own `LanguageModel` with a provider Layer of yours
  in `layer`, wrapped in an Activity so replay hands back what it answered. Collie has no
  classifier API of its own, and preferring a harness or model never overrides a provider
  you supplied; `agentWork` is the way to reach the harness the operator configured.

### Starting work on another Machine

A `collie_do` `start` action may name `machine`, `workspace` and `inputs`, for example:

```json
{
  "actions": [
    {
      "kind": "start",
      "workflow": "investigate",
      "machine": "mk-laptop",
      "workspace": "cego/collie",
      "inputs": { "goal": "Why is the Machines page behind?", "branch": "mk/desktop-fix" }
    }
  ]
}
```

`workspace` also takes a remote URL, such as `https://github.com/cego/collie` or
`git@github.com:cego/collie.git`. The receiving host finds a matching `origin` or `upstream`
under its Projects root. Push the branch before starting work elsewhere. The host fetches
it and cuts the worktree from that commit; a conflicting local branch or a checkout with
local changes is refused. Missing or ambiguous checkouts are refused with where it looked.

`workspace` and `branch` are host launch options, separate from a module's Input schema.
`investigate` declares only `goal`; it returns `{ summary, findings: [{ what, evidence }] }`.

A start by an agent records `requestedBy`: its Run, agent and Machine. When it settles,
the host sends the requester the status, summary or failure reason and
`collie run show <id>` for the full Output. The Delivery uses the agent's sender line and
a request id derived from the started Run. A restart reuses that Delivery. Delivery uses
`boundary`, supported by all harnesses. A gone agent, an unpaired Machine or a Machine
that does not answer within fifteen seconds leaves an undelivered report with its reason;
there is no retry queue. `run show` and the drawer show the requester and report.
