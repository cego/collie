# ADR-0030: A workflow is one definition, and its agent is decided in scope

Status: accepted

## Context

A workflow module exported five things: an `id`, a `title`, a `description`, an `input` and
`make(registrationName)`, which built an Effect workflow under a name the host chose and
handed back its Layer and a map of the decisions it might ask. Every piece of work inside it
was passed the run id by hand, and every agent's harness, model and effort was either named
on the call or taken from the operator's configuration. That had three costs.

The shape was ceremony: a registration name an author never reads, a decisions map kept in
step with the code by hand, and a run id forwarded through every helper. A question had to
be declared before the code that asked it, so one asked on only one branch, or once per
item of a list, was a map entry for work that might never happen. And there was nowhere to
say "this part of the work runs on opus": a helper in another file had to take the model as
an argument and pass it to each call, and switching harness on a call silently kept the
configured model for another harness.

## Decision

**A workflow is its default export.** `defineWorkflow({ id, input, output, run, … })` is the
whole of it, with the declarations — `hints`, `outcome`, `checkout`, `actions`,
`followUps` — in the same object, and `agents`, `layer` and `error` beside them when they
are needed. What is left out has a default: the title is the id, the description is empty,
the input is an empty struct and the output is `Schema.Void`. Nothing that would have to be
made up is invented: identities, what an agent is told and required business inputs stay
explicit. The host builds the Effect workflow under its own registration name. There is no
builder chain and no second definition format; the old exports are refused with what to
write instead. The declarations are data, readable without running anything.

**The Run is a service, and `run` is ordinary Effect code.** The host provides `Run` to
each execution, and `agentWork`, `ask`, `child` and `requireApproved` read it; none of them
takes a run id. `agentWork` also defaults its checkout to where the host placed the Run, and
its output to plain text, so a schema is an opt-in to structured, validated output. A
question is asked when execution reaches it: `ask({ name, prompt, options })` records it and
waits on a deferred made from its name, and an answer finds that deferred by the same name,
so there is no registry of questions.

**Agent preferences are a scoped context.** `withAgents(preferences)` provides a
`Context.Reference` over an effect, and every piece of agent work inside it — through
helpers, and into children — reads the scopes in force when it is asked for. Parallel
branches have their own. A child is started with what its parent prefers as serializable
options, never the parent's Context, services or Layers. The order is built-in defaults,
the operator's configuration, the definition's own `agents`, the Run's `--harness`,
`--model` and `--effort`, the enclosing scopes, then the call's own options; `--model`
therefore needs no workflow-specific support, and a deliberate choice on one call still
wins. We rejected a separate forcing configuration.

**Harness, model and effort are resolved together.** A layer that switches harness keeps
nothing chosen below it, and what is left open is that harness's own default; a combination
it does not take is refused with what it would take, never replaced. A Run's own is checked
at admission, and anything else before its agent starts.

**The choice is recorded before the agent is launched.** An Activity named after the work
records the resolved harness, model and effort first, and launch, collection, revival and
recovery all use it. Recording it only in the launch's own result left a window in which a
crash lost the choice. The recorded choice fixes that one started piece of work, not the
workflow, its code or its dependencies.

**A running agent stays the agent it is.** A conversation cannot change harness. Work that
names an agent already running under its `agent` name continues it: what is asked for at
the work itself — its own options or a scope around it — has to agree with what it runs
as, and a request it cannot meet is refused rather than ignored. What only defaults below
that decides for fresh agents alone, so a workflow that sets its agent up once and hands it
later steps is not refused for the steps it did not configure.

**Identity stays explicit, and permissions stay separate.** The same operation or question
name is the same logical work, and a loop names its items; we rejected automatic naming and
another identity registry. Preferring a model never changes permissions or which commands
Collie may run for the Run.

**Effect stays available directly.** Custom Activities, services and Layers, concurrency,
typed failures and direct `LanguageModel` calls wrapped in an Activity are Effect's own.
Collie adds no classifier API, and a harness preference never overrides a provider an author
supplied.

## Consequences

A module is shorter, and a question, an agent or a child can appear anywhere the code
reaches without being declared first. A shipped workflow expresses its ordinary preference
as `agents` on its definition, so an operator's `--model` reaches all of its work. A fork is
a spread of the definition it forks under a new id.

A module in the old shape no longer loads, and a workflow that switched harness on a call
while relying on the configured model is now refused where it used to start an agent with a
model its harness did not take.
