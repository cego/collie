# Native workflows run on Effect's own engine

**Status: accepted, and proven rather than argued.** The proof is
`test/native-runtime.test.ts`, the mechanism is `src/native.ts`, and
`collie native --dir <dir>` is the host it drives. Nothing described here is in the path of
a Markdown workflow yet; converting those is later work.

A workflow will be a TypeScript file an author writes, outside this repository, and Collie
will run it. That means Collie either builds durability, replay, suspension and recovery,
or it uses Effect's. This says it uses Effect's, records exactly which settings that takes,
and records the four upstream behaviours the proof found rather than assumed.

## Decision

**D1. Effect's workflow engine, not Collie's.** `Workflow`, `Activity` and
`DurableDeferred` are the vocabulary; `ClusterWorkflowEngine` over `SingleRunner` over
`@effect/sql-sqlite-bun` is the backend. Collie owns the domain — which module, which
generation, which run — and none of the execution. There is no Collie interpreter, no step
vocabulary and no second scheduler.

**D2. Two settings are not the defaults, and both are about recoverable work.**

| Setting                     | Collie | Upstream default | Why                                                                                                                                                             |
| --------------------------- | ------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preemptiveShutdown`        | false  | true             | A host told to stop must not take a running workflow down with it. What it was doing finishes; what is left is the next host's.                                 |
| `entityRegistrationTimeout` | ∞      | 1 minute         | A workflow whose module is missing has no entity to receive its messages. Failing them after a minute turns "the file is not there yet" into a terminal result. |

**D3. The binary serves the SDK to the module it loads.** An external file's `effect`
resolves from its own directory — a second copy, whose `Effect.succeed` builds values this
process's runtime does not recognise and whose service keys are not the host's. A Bun
runtime plugin serves `effect`, its submodules, `effect/unstable/workflow`'s submodules and
`collie/native` from the binary's own bundle, so what the module imports is what the host is
running. The author's directory still holds an `effect` — that is where their declarations
come from, which is exactly why serving the bundled one has to win.

**D4. A load is a generation, not a reload.** Loading an entry mints an opaque registration
name of its own (`proof@1`, `proof@2`), and that name is persisted with the run. New work
goes to the newest generation; a run keeps the one it started on, because the registration
name is the tag its executions are stored under. A restart reconstructs every recorded
generation from the module **as it is now** — not from anything kept.

**D5. A generation is staged as a copy, because Bun's module registry has no
invalidation.** Re-importing an entry under a new query does re-read the entry, but its
`./helper.ts` resolves to the path already cached, so an edited helper stays invisible.
Each generation is copied into `<state>/generations/<name>` and imported from there. The
directory is wiped when a host starts: it is a cache of this host's lifetime, never the
archive a past run is recovered onto.

**D6. Registrations are built in the host's scope.** They outlive the command that asked
for one and are finalized when the host goes.

**D7. A hold is read at a boundary, never inside an Activity.** An Activity's result is
durable and replay hands back the answer from the attempt that first ran, so a hold read
inside one could never be released. A resumable stop is the mirror: the wait Activity
suspends its **own** `WorkflowInstance`, not the run's, because suspending the enclosing
workflow from inside an Activity abandons it rather than parking it. Setting the flag is
not enough — a run parked on its decision has nothing that would make it read the flag, so
stopping wakes it and the wait suspends itself.

**D8. The typechecker is provisioned with the embedded Bun.** `BUN_BE_BUN=1` makes the
compiled executable the `bun` CLI, so `bun install` and a compiler run need neither Bun nor
Node on the machine. The author's directory gets a `package.json` pinning `effect` to the
host's version, a `tsconfig.json` mapping `collie/native`, and the declarations themselves.
Existing files of an author's are never replaced. Nothing to install with and no compiler
yet is `toolchain_unavailable`, said out loud — never a module reported as fine.

## What upstream actually does

Four things the proof measured rather than assumed. Each is a test.

1. **Registering a name twice keeps the first.** It does not fail and it does not replace:
   the second registration is silently ignored. So duplicate registration is not a reload
   API and not a refusal a host can rely on — hence D4.
2. **A completed Activity comes back across a process boundary.** The launch runs once
   however many hosts, holds, stops and resumes the run passes through.
3. **A pending `DurableDeferred` survives a kill.** A host killed with `SIGKILL` mid-run
   leaves the work suspended rather than failed, and the next host finishes it.
4. **Interruption is not promised.** Nothing here relies on native interrupt being prompt,
   terminal in every state, or resumable. Stop and hold are durable flags the workflow
   reads; what they suspend, it suspends itself.

## What this does not decide

The shape of the public module contract, where a user's workflows live, the host Collie
ships, typed inputs, cards, and converting the five Markdown workflows. `collie native` is
a fixture host for this proof, not that host: one process, one state directory, one client,
and a JSON line each way.

## Consequences

- The dependency set moves together — `effect`, `@effect/platform-bun` and
  `@effect/sql-sqlite-bun` at one version — and an upgrade rechecks this proof.
- `bun run test` carries about two minutes of real subprocesses and SQLite files. The
  questions being asked have no answer in an in-memory engine.
- `COLLIE_TEST_BINARY=bin/collie bun test test/native-runtime.test.ts` runs the same proof
  against the compiled executable, which is the one that matters.
