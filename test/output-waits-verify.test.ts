import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Fiber, Schema, flow, pipe as pipe_, Result } from "effect";
import { connect } from "../src/host";
import { resetExecutors } from "../src/executors";
import { deliveredTo, launchOf } from "./support/records";
import { exec } from "./support/command";
import { stopHost, until } from "./support/host";
import { collie, proves } from "./support/world";
import type { World } from "./support/world";

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

const setUp = (world: World, outputs: ReadonlyArray<Schema.Json>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`${world.home}/outputs.json`, encode(outputs));
    yield* fs.writeFileString(`${world.project}/thing.txt`, "one\n");
    yield* exec(["git", "add", "-A"], { cwd: world.project });
    yield* exec(
      ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "one"],
      { cwd: world.project },
    );
  }).pipe(Effect.orDie);

const began = (world: World, module: string, input: Record<string, Schema.Json>) =>
  Effect.gen(function* () {
    resetExecutors();
    const client = yield* connect(world.state);
    const { runId } = yield* client.start({
      project: world.project,
      id: module,
      request: "start",
      input,
    });
    return { client, runId };
  }).pipe(Effect.orDie);

const buildOf = (world: World, runId: string, operation = "build") =>
  until(
    () => launchOf(world.state, runId, operation),
    (one) => one !== undefined,
  ).pipe(Effect.map((one) => one!));

// WARNING: collection polls every 2 seconds, so a verify held for less than that can be missed.
const held = (world: World, runId: string, agent: string, operation = "build") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const underway = `${world.home}/${operation}-verify-underway`;
    const go = `${world.home}/${operation}-verify-go`;
    const running = yield* collie(
      world,
      [
        "verify",
        "--run",
        runId,
        "--cwd",
        world.project,
        "--name",
        "unit",
        "--",
        "sh",
        "-c",
        `printf underway > '${underway}'; echo running; until [ -f '${go}' ]; do sleep 0.05; done`,
      ],
      { COLLIE_AGENT: agent },
    ).pipe(Effect.forkScoped);
    yield* until(
      () => fs.exists(underway),
      (one) => one,
    );
    yield* until(
      () =>
        fs
          .readDirectory(`${world.state}/evidence/${runId}/verify`)
          .pipe(Effect.orElseSucceed(() => [])),
      (names) => Arr.some(names, (one) => pipe_(one, Str.includes("unit"))),
    );
    return { go, running };
  });

const told = (world: World, runId: string) =>
  until(
    () => deliveredTo(world.state, runId),
    (all) => Arr.some(all, (one) => pipe_(one.cause.ref, Str.startsWith("verify-"))),
  );

type Viewed = { readonly waiting: ReadonlyArray<{ prompt: string; answer: string | null }> } | null;
const prompts = (view: Viewed) =>
  Arr.map(
    Arr.filter(view?.waiting ?? [], (one) => one.answer === null),
    (one) => one.prompt,
  );

test("an Output written while its own verify runs is not taken, and the one after the tell is", () =>
  proves(
    "collie-output-waits-1-",
    (world, core) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* setUp(world, [{ output: null, status: "idle" }]);
        const { client, runId } = yield* began(world, "collected", {});
        const build = yield* buildOf(world, runId);
        const { go, running } = yield* held(world, runId, build.agent);
        yield* fs.writeFileString(build.output, encode({ verdict: "stale" })).pipe(Effect.orDie);
        yield* Effect.sleep("2500 millis");
        expect(prompts(yield* client.run({ runId }).pipe(Effect.orDie))).toEqual([]);

        yield* fs.writeFileString(go, "").pipe(Effect.orDie);
        yield* told(world, runId);
        yield* core.report(build.agent, "working");
        yield* fs.writeFileString(build.output, encode({ verdict: "fresh" })).pipe(Effect.orDie);
        yield* core.report(build.agent, "idle");

        const [asked] = yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => prompts(view).length > 0,
        ).pipe(Effect.map((view) => prompts(view)));
        expect(asked).toBe("collected fresh");
        yield* fs.writeFileString(go, "").pipe(Effect.orDie);
        yield* Fiber.await(running);
      }).pipe(Effect.ensuring(stopHost(world.state))),
    ["collected.workflow.ts"],
  ));

test("an unread status does not stand in for the end of the agent's turn", () =>
  proves(
    "collie-output-waits-8-",
    (world, core) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* setUp(world, [{ output: null, status: "idle" }]);
        const { client, runId } = yield* began(world, "collected", {});
        const build = yield* buildOf(world, runId);
        const { go, running } = yield* held(world, runId, build.agent);
        yield* fs.writeFileString(build.output, encode({ verdict: "unread" })).pipe(Effect.orDie);
        yield* core.report(build.agent, "working");
        yield* Effect.sleep("2500 millis");
        yield* fs.writeFileString(go, "").pipe(Effect.orDie);
        yield* Fiber.await(running);
        yield* core.report(build.agent, "halfway");
        yield* Effect.sleep("6000 millis");
        expect(prompts(yield* client.run({ runId }).pipe(Effect.orDie))).toEqual([]);

        yield* core.report(build.agent, "idle");
        const [asked] = yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => prompts(view).length > 0,
        ).pipe(Effect.map((view) => prompts(view)));
        expect(asked).toBe("collected unread");
      }).pipe(Effect.ensuring(stopHost(world.state))),
    ["collected.workflow.ts"],
  ));

test("an agent that lets its Output stand after the tell has that one taken at the end of its turn", () =>
  proves(
    "collie-output-waits-2-",
    (world, core) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* setUp(world, [{ output: null, status: "idle" }]);
        const { client, runId } = yield* began(world, "collected", {});
        const build = yield* buildOf(world, runId);
        const { go, running } = yield* held(world, runId, build.agent);
        yield* fs.writeFileString(build.output, encode({ verdict: "stood" })).pipe(Effect.orDie);
        yield* Effect.sleep("2500 millis");
        expect(prompts(yield* client.run({ runId }).pipe(Effect.orDie))).toEqual([]);

        yield* fs.writeFileString(go, "").pipe(Effect.orDie);
        yield* told(world, runId);
        yield* core.report(build.agent, "working");
        yield* core.report(build.agent, "idle");

        const [asked] = yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => prompts(view).length > 0,
        ).pipe(Effect.map((view) => prompts(view)));
        expect(asked).toBe("collected stood");
        yield* Fiber.await(running);
      }).pipe(Effect.ensuring(stopHost(world.state))),
    ["collected.workflow.ts"],
  ));

test("a verify another agent of the same Run started holds nothing back", () =>
  proves(
    "collie-output-waits-3-",
    (world, core) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* setUp(world, [
          { output: null, status: "idle" },
          { output: null, status: "idle" },
        ]);
        const { client, runId } = yield* began(world, "attended", { work: "it" });
        const build = yield* buildOf(world, runId);
        yield* fs.writeFileString(build.output, encode({ verdict: "built" })).pipe(Effect.orDie);
        yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => prompts(view).length > 0,
        );
        yield* client
          .answer({ runId, decision: "go", value: "yes", request: "answer-go" })
          .pipe(Effect.orDie);
        const check = yield* buildOf(world, runId, "check");
        const { go, running } = yield* held(world, runId, build.agent, "check");
        yield* fs.writeFileString(check.output, encode({ verdict: "checked" })).pipe(Effect.orDie);
        yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete",
        );
        yield* fs.writeFileString(go, "").pipe(Effect.orDie);
        yield* Fiber.await(running);
      }).pipe(Effect.ensuring(stopHost(world.state))),
    ["attended.workflow.ts"],
  ));

test("an Output a foreground verify held is taken once the turn it ended in is over", () =>
  proves(
    "collie-output-waits-4-",
    (world, core) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* setUp(world, [{ output: null, status: "idle" }]);
        const { client, runId } = yield* began(world, "collected", {});
        const build = yield* buildOf(world, runId);
        const { go, running } = yield* held(world, runId, build.agent);
        yield* fs
          .writeFileString(build.output, encode({ verdict: "foreground" }))
          .pipe(Effect.orDie);
        yield* core.report(build.agent, "working");
        yield* Effect.sleep("2500 millis");
        yield* fs.writeFileString(go, "").pipe(Effect.orDie);
        yield* Fiber.await(running);
        yield* core.report(build.agent, "idle");

        const [asked] = yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => prompts(view).length > 0,
        ).pipe(Effect.map((view) => prompts(view)));
        expect(asked).toBe("collected foreground");
      }).pipe(Effect.ensuring(stopHost(world.state))),
    ["collected.workflow.ts"],
  ));

test("an Output written after its verify ended is taken while the agent still works", () =>
  proves(
    "collie-output-waits-7-",
    (world, core) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* setUp(world, [{ output: null, status: "idle" }]);
        const { client, runId } = yield* began(world, "collected", {});
        const build = yield* buildOf(world, runId);
        const { go, running } = yield* held(world, runId, build.agent);
        yield* core.report(build.agent, "working");
        yield* fs.writeFileString(go, "").pipe(Effect.orDie);
        yield* Fiber.await(running);
        yield* fs.writeFileString(build.output, encode({ verdict: "later" })).pipe(Effect.orDie);

        const [asked] = yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => prompts(view).length > 0,
        ).pipe(Effect.map((view) => prompts(view)));
        expect(asked).toBe("collected later");
      }).pipe(Effect.ensuring(stopHost(world.state))),
    ["collected.workflow.ts"],
  ));

test("a tell the agent never received does not release the Output it was about", () =>
  proves(
    "collie-output-waits-5-",
    (world, core) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* setUp(world, [{ output: null, status: "idle" }]);
        const { client, runId } = yield* began(world, "collected", {});
        const build = yield* buildOf(world, runId);
        const { go, running } = yield* held(world, runId, build.agent);
        yield* fs.writeFileString(build.output, encode({ verdict: "unheard" })).pipe(Effect.orDie);
        yield* Effect.sleep("2500 millis");
        core.refuse("terminal.send", "invalid_argument", "the pane refused the prompt");
        yield* fs.writeFileString(go, "").pipe(Effect.orDie);
        yield* Fiber.await(running);
        yield* Effect.sleep("6000 millis");

        expect(prompts(yield* client.run({ runId }).pipe(Effect.orDie))).toEqual([]);
      }).pipe(Effect.ensuring(stopHost(world.state))),
    ["collected.workflow.ts"],
  ));

test("the Output read again after the wait is released is the one taken", () =>
  proves(
    "collie-output-waits-6-",
    (world, core) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* setUp(world, [{ output: null, status: "idle" }]);
        const { client, runId } = yield* began(world, "collected", {});
        const build = yield* buildOf(world, runId);
        const { go, running } = yield* held(world, runId, build.agent);
        yield* fs.writeFileString(build.output, encode({ verdict: "stale" })).pipe(Effect.orDie);
        yield* core.report(build.agent, "working");
        yield* fs.writeFileString(go, "").pipe(Effect.orDie);
        yield* Fiber.await(running);
        yield* Effect.sleep("2500 millis");

        const release = core.hold("terminal.get");
        yield* Effect.sleep("2500 millis");
        yield* fs.writeFileString(build.output, encode({ verdict: "fresh" })).pipe(Effect.orDie);
        yield* core.report(build.agent, "idle");
        release();

        const [asked] = yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => prompts(view).length > 0,
        ).pipe(Effect.map((view) => prompts(view)));
        expect(asked).toBe("collected fresh");
      }).pipe(Effect.ensuring(stopHost(world.state))),
    ["collected.workflow.ts"],
  ));
