// A plan's tickets as a list of work: three items, one agent, and a hand-off between them.
//
// What is being proved is what a list may forget and what it may not. An item is known by
// its own name, so a plan that is reordered or added to between attempts reuses the work
// it already has and does only what is left — never one item's result under another's
// name. Findings do not stop the list, an Output nothing can be made of does, an empty
// plan is no work at all, and a ticket nothing would prove is skipped with a reason and
// no agent at all.
//
// The agents are herdr's through the real dispatcher, the engine is Effect's over real
// SQLite in a directory, and every second pass below is a second host on the same file.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Path, Result, Schema } from "effect";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import { Rig, FakeHerdr } from "./support/recorder";
import { runEffect } from "./support/effect";
import { Agents, agentsLayer, type AgentHost } from "../src/agents";
import { Children, Host, WorkflowError } from "../src/sdk";
import { answerDecision, foundationLayer, loadEntry } from "../src/engine";
import { Store } from "../src/store";
import { events, fixtures, until } from "./support/host";

let rig: Rig;
let dir: string;
let plan: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      const fs = yield* FileSystem.FileSystem;
      dir = `${rig.root}/host`;
      plan = `${rig.root}/plan`;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.makeDirectory(`${plan}/issues`, { recursive: true });
      yield* fs.makeDirectory(rig.projectDir, { recursive: true });
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

/** One ticket, as the planning step writes them. */
const ticket = (
  file: string,
  title: string,
  over?: { readonly blockedBy?: string; readonly checks?: string },
) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.writeFileString(
        `${plan}/issues/${file}`,
        [
          `# ${title}`,
          "",
          `**Blocked by:** ${over?.blockedBy ?? "None"}`,
          "",
          "**Repo:** .",
          "",
          `**Checks:** ${over?.checks ?? "test"}`,
          "",
        ].join("\n"),
      ),
    ),
    Effect.orDie,
  );

const hostOf = (): AgentHost => ({
  dir,
  env: rig.pluginEnv(),
  herdr: new FakeHerdr(rig.pluginEnv()),
  harness: "claude",
  model: "opus",
  permissions: "auto",
  compactAtTokens: 0,
  pollMs: 20,
  collectMs: 400,
});

/** This suite starts no children; the service is here because a registration takes one. */
const nothing = () => Effect.die("no children in this suite");

/** One host's lifetime: a fresh engine on the same directory is what a restart is. */
const session = <A, E>(
  run: Effect.Effect<
    A,
    E,
    | WorkflowEngine.WorkflowEngine
    | Agents
    | Children
    | Host
    | Store
    | FileSystem.FileSystem
    | Path.Path
  >,
) =>
  run.pipe(
    Effect.provide(agentsLayer(hostOf())),
    Effect.provide(Layer.succeed(Children)(Children.of({ start: nothing, result: nothing }))),
    Effect.provide(foundationLayer({ dir })),
    Effect.scoped,
    Effect.orDie,
  );

/** The module as a host loads it, on the registration name a later pass comes back to. */
const loaded = (entry: string, runId: string) =>
  loadEntry(`${fixtures}/${entry}`).pipe(
    Effect.map((described) => described.make(`${described.id}@${runId}`)),
    Effect.orDie,
  );

const payloadFor = (runId: string) => ({ runId, input: { plan, cwd: rig.projectDir } });

const worked = (runId: string, entry = "roster.workflow.ts") =>
  session(
    Effect.gen(function* () {
      const made = yield* loaded(entry, runId);
      return yield* made.workflow
        .execute(payloadFor(runId))
        .pipe(Effect.result, Effect.provide(made.layer));
    }),
  );

/**
 * The same, for work that parks on its question: a suspended execution never returns, so
 * it is submitted and then waited on until the host has been told what it is asking. The
 * registration is held open across both, because the work is the engine's now.
 */
const parked = (runId: string, entry = "roster.workflow.ts") =>
  session(
    Effect.gen(function* () {
      const made = yield* loaded(entry, runId);
      const store = yield* Store;
      return yield* Effect.gen(function* () {
        yield* made.workflow.execute(payloadFor(runId), { discard: true });
        return yield* until(
          () => store.asked(runId),
          (rows) => rows.some((row) => row.decision === "carry-on"),
        );
      }).pipe(Effect.provide(made.layer));
    }),
  );

/** The human answers, in a host that never saw the attempt that asked. */
const answered = (runId: string, value: string, entry = "roster.workflow.ts") =>
  session(
    Effect.gen(function* () {
      const made = yield* loaded(entry, runId);
      const payload = payloadFor(runId);
      return yield* Effect.gen(function* () {
        yield* answerDecision(made, {
          name: "carry-on",
          executionId: yield* made.workflow.executionId(payload),
          value,
        }).pipe(Effect.orDie);
        return yield* made.workflow.execute(payload).pipe(Effect.result);
      }).pipe(Effect.provide(made.layer));
    }),
  );

const said = (result: { readonly _tag: string; readonly success?: unknown }) =>
  result._tag === "Success" ? String(result.success) : "";

const failed = (result: Result.Result<unknown, unknown>) =>
  Result.isFailure(result) && Schema.is(WorkflowError)(result.failure) ? result.failure.reason : "";

const prompts = () =>
  rig.calls().pipe(Effect.map((calls) => calls.filter((call) => call.cmd === "agent prompt")));

/** What an operation was actually asked, which is the file its message named. */
const promptFile = (runId: string, operation: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${dir}/agents/${runId}/${operation}.prompt.md`)),
    Effect.orDie,
  );

const starts = () =>
  rig.cmds().pipe(Effect.map((cmds) => cmds.filter((cmd) => cmd === "agent start")));

const built = (what: string, findings: ReadonlyArray<Schema.Json> = []) => ({
  verdict: findings.length === 0 ? "clean" : "findings",
  fixed: [{ title: what }],
  findings,
  checks: [{ name: "test" }],
});

const blocker = (title: string) => ({
  severity: "blocker",
  title,
  file: "src/thing.ts",
  detail: "it goes wrong when the list is empty",
});

test(
  "three tickets are three pieces of work, in order, each told what the ones before it left",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* ticket("01-api.md", "Serve the thing");
        yield* ticket("02-ui.md", "Show the thing");
        yield* ticket("03-docs.md", "Say what it does");
        yield* rig.queueOutputs([built("api"), built("ui"), built("docs")]);

        const result = yield* worked("r-three");
        expect(said(result)).toBe(
          "3 of 3: 01-api.md=api+02-ui.md=ui+03-docs.md=docs, 0 finding(s)",
        );
        // One agent for the whole plan, three prompts: the hand-off is what the next item
        // is given, rather than a transcript it has to read its way back through.
        expect(yield* starts()).toHaveLength(1);
        const asked = yield* prompts();
        expect(asked).toHaveLength(3);
        // The message names the file the work is in; the work is what was written there.
        const third = yield* promptFile("r-three", "03-docs.md");
        expect(third).toContain("item 3 of 3");
        expect(third).toContain("- 01-api.md — Serve the thing");
        expect(third).toContain("    api");
        expect(third).toContain("- 02-ui.md — Show the thing");
        // Nothing was asked of a human: the question is for findings, and there are none.
        expect(yield* events(dir, "r-three")).toEqual([]);
      }),
    ),
  120_000,
);

test(
  "findings do not stop the list: they are carried to the end, and the end asks a human",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* ticket("01-api.md", "Serve the thing");
        yield* ticket("02-ui.md", "Show the thing");
        yield* rig.queueOutputs([built("api", [blocker("empty list")]), built("ui")]);

        // The blocking finding parks the run on its question rather than ending the list.
        const asking = yield* parked("r-findings");
        expect(asking.map((row) => row.prompt)).toEqual(["Findings were raised. Carry on?"]);
        expect(yield* prompts()).toHaveLength(2);

        const done = yield* answered("r-findings", "yes");
        expect(said(done)).toBe("2 of 2: 01-api.md=api+02-ui.md=ui, 1 finding(s)");
        // Answering replayed the list; neither item was handed to an agent again.
        expect(yield* prompts()).toHaveLength(2);
      }),
    ),
  120_000,
);

test(
  "a plan edited between attempts does what is left, and gives nobody else's result away",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* ticket("01-api.md", "Serve the thing");
        yield* ticket("02-ui.md", "Show the thing");
        yield* ticket("03-docs.md", "Say what it does");
        yield* rig.queueOutputs([
          built("api", [blocker("empty list")]),
          built("ui"),
          built("docs"),
          built("late"),
        ]);
        yield* parked("r-edited");
        expect(yield* prompts()).toHaveLength(3);

        // The plan moves under the run: a ticket is added, and the order changes.
        yield* ticket("04-late.md", "Think again");
        yield* ticket("01-api.md", "Serve the thing", { blockedBy: "03" });

        const done = yield* answered("r-edited", "yes");
        // In the order the plan now asks for, with each ticket's own result under its own
        // name — and one prompt for the one ticket that had none.
        expect(said(done)).toBe(
          "4 of 4: 02-ui.md=ui+03-docs.md=docs+04-late.md=late+01-api.md=api, 1 finding(s)",
        );
        expect(yield* prompts()).toHaveLength(4);
        expect(yield* starts()).toHaveLength(1);
      }),
    ),
  120_000,
);

test("a plan with no tickets in it is no work at all", () =>
  runEffect(
    Effect.gen(function* () {
      const result = yield* worked("r-empty");
      expect(said(result)).toBe("nothing to do");
      expect(yield* starts()).toEqual([]);
      expect(yield* prompts()).toEqual([]);
    }),
  ));

test(
  "a ticket nothing would prove is skipped with a reason, and no agent is opened for it",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* ticket("01-api.md", "Serve the thing", { checks: "None" });
        yield* ticket("02-ui.md", "Show the thing");
        yield* rig.queueOutputs([built("ui")]);

        const result = yield* worked("r-skipped");
        expect(said(result)).toBe("1 of 2: 02-ui.md=ui, 0 finding(s)");
        // The reason is recorded, and nothing was written as though an agent had answered.
        expect(yield* events(dir, "r-skipped")).toEqual(["skipped 01-api.md: it names no checks"]);
        expect(yield* prompts()).toHaveLength(1);
        const tabs = (yield* rig.cmds()).filter((cmd) => cmd === "tab create");
        expect(tabs).toHaveLength(1);
      }),
    ),
  120_000,
);

test(
  "an Output nothing can be made of stops the list where it is",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* ticket("01-api.md", "Serve the thing");
        yield* ticket("02-ui.md", "Show the thing");
        yield* ticket("03-docs.md", "Say what it does");
        // The second item answers with something the contract refuses, twice: the repair
        // is the one more attempt it gets, and then the list is over.
        yield* rig.queueOutputs([built("api"), { verdict: "maybe" }, { verdict: "maybe" }]);

        const result = yield* worked("r-unusable");
        expect(failed(result)).toContain("output-unusable");
        // Two prompts and one repair; the third ticket was never handed to anyone.
        expect(yield* prompts()).toHaveLength(3);
        expect(yield* events(dir, "r-unusable")).toEqual([]);
      }),
    ),
  120_000,
);

test(
  "the same list of work under a name that shares nothing with it does the same thing",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* ticket("01-api.md", "Serve the thing", { checks: "None" });
        yield* ticket("02-ui.md", "Show the thing");
        yield* rig.queueOutputs([
          built("ui", [blocker("empty list")]),
          built("ui", [blocker("empty list")]),
        ]);

        // Both of them: the skip, the list, the question a finding raises and the answer.
        const under = (entry: string, runId: string) =>
          Effect.gen(function* () {
            yield* parked(runId, entry);
            const done = yield* answered(runId, "yes", entry);
            return { said: said(done), events: yield* events(dir, runId) };
          });
        const roster = yield* under("roster.workflow.ts", "r-roster");
        const sweep = yield* under("sweep.workflow.ts", "r-sweep");

        expect(sweep).toEqual(roster);
        expect(roster.said).toBe("1 of 2: 02-ui.md=ui, 1 finding(s)");
        // Once per pass: the answer replays the body, and eligibility is decided again
        // rather than remembered — which is what makes a ticket that gained checks in the
        // meantime work rather than a skip somebody recorded once.
        expect(roster.events).toEqual([
          "skipped 01-api.md: it names no checks",
          "skipped 01-api.md: it names no checks",
        ]);
      }),
    ),
  120_000,
);
