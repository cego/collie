import { Herdr } from "../src/herdr";
import * as Arr from "effect/Array";
import type { ChildProcessSpawner } from "effect/process";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Path, Schema } from "effect";
import { Effect, FileSystem, Layer } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { Rig } from "./support/recorder";
import { runEffect } from "./support/effect";
import { isString } from "../src/schema";
import type { Agents } from "../src/agents";
import { agentsLayer } from "../src/agents";
import type { AgentHost } from "../src/agents";
import type { Host } from "../src/sdk";
import { Children } from "../src/sdk";
import { PARKED, answerDecision, foundationLayer, loadEntry, pollStatus } from "../src/engine";
import { Store } from "../src/store";
import { events, fixtures, until } from "./support/host";
import { hostRunRecords } from "./support/records";

let rig: Rig;
let dir: string;
let plan: string;
let toasts: Array<string>;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* rig.startCore();
      const fs = yield* FileSystem.FileSystem;
      dir = `${rig.root}/host`;
      plan = `${rig.root}/plan`;
      toasts = [];
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.makeDirectory(`${plan}/issues`, { recursive: true });
      yield* fs.makeDirectory(rig.projectDir, { recursive: true });
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

const ticket = (
  file: string,
  title: string,
  over?: { readonly blockedBy?: string; readonly checks?: string },
) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.writeFileString(
        `${plan}/issues/${file}`,
        Arr.join(
          [
            `# ${title}`,
            "",
            `**Blocked by:** ${over?.blockedBy ?? "None"}`,
            "",
            "**Repo:** .",
            "",
            `**Checks:** ${over?.checks ?? "test"}`,
            "",
          ],
          "\n",
        ),
      ),
    ),
    Effect.orDie,
  );

const hostOf: () => AgentHost = () => ({
  dir,
  env: rig.pluginEnv(),
  herdr: new Herdr(rig.pluginEnv()),
  harness: "claude",
  model: "opus",
  permissions: "auto",
  compactAtTokens: 0,
  pollMs: 20,
  collectMs: 400,
});

const nothing = () => Effect.die("no children in this suite");

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
    | ChildProcessSpawner.ChildProcessSpawner
  >,
) =>
  run.pipe(
    Effect.provide(
      agentsLayer(hostOf()).pipe(
        Layer.provideMerge(
          Layer.succeed(Children)(
            Children.of({
              start: nothing,
              result: nothing,
            }),
          ),
        ),
        Layer.provideMerge(
          foundationLayer({
            dir,
            toast: (title, body, sound) =>
              Effect.sync(() => toasts.push(`${sound}|${title}|${body}`)),
          }),
        ),
      ),
    ),
    Effect.scoped,
    Effect.orDie,
  );

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
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Loaded workflows erase the author-declared error schema; this test inspects the captured result.
      return yield* made.workflow
        .execute(payloadFor(runId))
        .pipe(Effect.result, Effect.provide(made.layer));
    }),
  );

const parked = (runId: string, entry = "roster.workflow.ts") =>
  session(
    Effect.gen(function* () {
      const made = yield* loaded(entry, runId);
      const store = yield* Store;
      return yield* Effect.gen(function* () {
        yield* made.workflow.execute(payloadFor(runId), { discard: true });
        return yield* until(
          () => store.asked(runId),
          (rows) => Arr.some(rows, (row) => row.decision === "carry-on"),
        );
      }).pipe(Effect.provide(made.layer));
    }),
  );

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
        // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Loaded workflows erase the author-declared error schema; this test inspects the captured result.
        return yield* made.workflow.execute(payload).pipe(Effect.result);
      }).pipe(Effect.provide(made.layer));
    }),
  );

const said = (result: { readonly _tag: string; readonly success?: unknown }) =>
  result._tag === "Success" ? String(result.success) : "";

const prompts = () =>
  rig
    .calls()
    .pipe(
      Effect.map((calls) =>
        Arr.filter(calls, (call) => call.cmd === "terminal.send" && isString(call.params?.text)),
      ),
    );

const promptFile = (runId: string, operation: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${dir}/agents/${runId}/${operation}.prompt.md`)),
    Effect.orDie,
  );

const starts = () =>
  rig.cmds().pipe(Effect.map((cmds) => Arr.filter(cmds, (cmd) => cmd === "terminal.run")));

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

test("three tickets are three pieces of work, in order, each told what the ones before it left", () =>
  runEffect(
    Effect.gen(function* () {
      yield* ticket("01-api.md", "Serve the thing");
      yield* ticket("02-ui.md", "Show the thing");
      yield* ticket("03-docs.md", "Say what it does");
      yield* rig.queueOutputs([built("api"), built("ui"), built("docs")]);

      const result = yield* worked("r-three");
      expect(said(result)).toBe("3 of 3: 01-api.md=api+02-ui.md=ui+03-docs.md=docs, 0 finding(s)");
      expect(yield* starts()).toHaveLength(1);
      const asked = yield* prompts();
      expect(asked).toHaveLength(3);
      const third = yield* promptFile("r-three", "03-docs.md");
      expect(third).toContain("item 3 of 3");
      expect(third).toContain("- 01-api.md — Serve the thing");
      expect(third).toContain("    api");
      expect(third).toContain("- 02-ui.md — Show the thing");
      expect(yield* events(dir, "r-three")).toEqual([]);
    }),
  ));

test("findings do not stop the list: they are carried to the end, and the end asks a human", () =>
  runEffect(
    Effect.gen(function* () {
      yield* ticket("01-api.md", "Serve the thing");
      yield* ticket("02-ui.md", "Show the thing");
      yield* rig.queueOutputs([built("api", [blocker("empty list")]), built("ui")]);

      const asking = yield* parked("r-findings");
      expect(Arr.map(asking, (row) => row.prompt)).toEqual(["Findings were raised. Carry on?"]);
      expect(yield* prompts()).toHaveLength(2);

      const done = yield* answered("r-findings", "yes");
      expect(said(done)).toBe("2 of 2: 01-api.md=api+02-ui.md=ui, 1 finding(s)");
      expect(yield* prompts()).toHaveLength(2);
    }),
  ));

test("a plan edited between attempts does what is left, and gives nobody else's result away", () =>
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

      yield* ticket("04-late.md", "Think again");
      yield* ticket("01-api.md", "Serve the thing", { blockedBy: "03" });

      const done = yield* answered("r-edited", "yes");
      expect(said(done)).toBe(
        "4 of 4: 02-ui.md=ui+03-docs.md=docs+04-late.md=late+01-api.md=api, 1 finding(s)",
      );
      expect(yield* prompts()).toHaveLength(4);
      expect(yield* starts()).toHaveLength(1);
    }),
  ));

test("a plan with no tickets in it is no work at all", () =>
  runEffect(
    Effect.gen(function* () {
      const result = yield* worked("r-empty");
      expect(said(result)).toBe("nothing to do");
      expect(yield* starts()).toEqual([]);
      expect(yield* prompts()).toEqual([]);
    }),
  ));

test("a ticket nothing would prove is skipped with a reason, and no agent is opened for it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* ticket("01-api.md", "Serve the thing", { checks: "None" });
      yield* ticket("02-ui.md", "Show the thing");
      yield* rig.queueOutputs([built("ui")]);

      const result = yield* worked("r-skipped");
      expect(said(result)).toBe("1 of 2: 02-ui.md=ui, 0 finding(s)");
      expect(yield* events(dir, "r-skipped")).toEqual(["skipped 01-api.md: it names no checks"]);
      expect(yield* prompts()).toHaveLength(1);
      expect(yield* starts()).toHaveLength(1);
    }),
  ));

const parkedAt = (runId: string, entry = "roster.workflow.ts") =>
  session(
    Effect.gen(function* () {
      const made = yield* loaded(entry, runId);
      const engine = yield* WorkflowEngine.WorkflowEngine;
      return yield* Effect.gen(function* () {
        yield* made.workflow.execute(payloadFor(runId), { discard: true });
        const id = yield* made.workflow.executionId(payloadFor(runId));
        const status = yield* until(
          () => engine.poll(made.workflow, id).pipe(Effect.map((one) => pollStatus(one, entry))),
          (one) => one.status === "failed" || one.status === "suspended",
        );
        expect(status.status).toBe("suspended");
      }).pipe(Effect.provide(made.layer));
    }),
  );

const resumed = (runId: string, entry = "roster.workflow.ts") =>
  session(
    Effect.gen(function* () {
      const made = yield* loaded(entry, runId);
      const engine = yield* WorkflowEngine.WorkflowEngine;
      const payload = payloadFor(runId);
      return yield* Effect.gen(function* () {
        yield* engine.resume(made.workflow, yield* made.workflow.executionId(payload));
        // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Loaded workflows erase the author-declared error schema; this test inspects the captured result.
        return yield* made.workflow.execute(payload).pipe(Effect.result);
      }).pipe(Effect.provide(made.layer));
    }),
  );

test("an Output still unusable after its repair parks the list at its item, and a resume goes on from it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* ticket("01-api.md", "Serve the thing");
      yield* ticket("02-ui.md", "Show the thing");
      yield* ticket("03-docs.md", "Say what it does");
      yield* rig.queueOutputs([
        built("api"),
        { verdict: "maybe" },
        { verdict: "maybe" },
        built("docs"),
      ]);

      yield* parkedAt("r-unusable");
      expect(yield* prompts()).toHaveLength(3);
      const why = yield* hostRunRecords(() => dir).control(PARKED, "r-unusable");
      expect(why).toContain(`${dir}/agents/r-unusable/02-ui.md.json`);
      expect(toasts).toEqual([expect.stringMatching(/^request\|.* needs you\|/)]);
      expect(toasts[0]).toEndWith(`|${why}`);

      yield* fs.writeFileString(
        `${dir}/agents/r-unusable/02-ui.md.json`,
        `{"verdict":"clean","fixed":[{"title":"ui"}],"findings":[],"checks":[{"name":"test"}]}`,
      );
      const done = yield* resumed("r-unusable");
      expect(said(done)).toBe("3 of 3: 01-api.md=api+02-ui.md=ui+03-docs.md=docs, 0 finding(s)");
      expect(yield* prompts()).toHaveLength(4);
      expect(yield* starts()).toHaveLength(1);
    }),
  ));

test("the same list of work under a name that shares nothing with it does the same thing", () =>
  runEffect(
    Effect.gen(function* () {
      yield* ticket("01-api.md", "Serve the thing", { checks: "None" });
      yield* ticket("02-ui.md", "Show the thing");
      yield* rig.queueOutputs([
        built("ui", [blocker("empty list")]),
        built("ui", [blocker("empty list")]),
      ]);

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
      expect(roster.events).toEqual([
        "skipped 01-api.md: it names no checks",
        "skipped 01-api.md: it names no checks",
      ]);
    }),
  ));
