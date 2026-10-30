import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConfigProvider, Effect, Exit, FileSystem, Path, Schema, flow, Result } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { Host } from "../src/sdk";
import { controlPath, evidenceDir, foundationLayer, runDir, STOP } from "../src/engine";
import { Store } from "../src/store";
import { appendVerification, collect, readVerifications } from "../src/verify";
import { VerifySpecSchema } from "../src/verify-spec";
import { memoryWaitOf } from "../src/memory-wait";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";

let rig: Rig;
let dir: string;
let tool: string;
const runId = "r-once";

const asApproved = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Array(VerifySpecSchema))),
  Result.getOrThrow,
);

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      const fs = yield* FileSystem.FileSystem;
      dir = `${rig.root}/host`;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.makeDirectory(rig.projectDir, { recursive: true });
      for (const args of [
        ["init", "-q"],
        ["config", "user.email", "t@example.com"],
        ["config", "user.name", "t"],
      ])
        yield* exec(["git", ...args], { cwd: rig.projectDir });
      yield* fs.writeFileString(`${rig.projectDir}/thing.ts`, "export const one = 1;\n");
      yield* exec(["git", "add", "-A"], { cwd: rig.projectDir });
      yield* exec(["git", "commit", "-qm", "first"], { cwd: rig.projectDir });
      // Outside the tree, so running it moves nothing; red while the flag file is there.
      tool = `${rig.root}/unit`;
      yield* fs.writeFileString(tool, `#!/bin/sh\n[ ! -f ${rig.root}/red ]\n`);
      yield* fs.chmod(tool, 0o755);
      yield* fs.makeDirectory(evidenceDir(dir, runId), { recursive: true });
      yield* fs.writeFileString(
        `${evidenceDir(dir, runId)}/approved.json`,
        asApproved([{ name: "unit", executable: tool, argv: [], cwd: "." }]),
      );
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

/** An agent's `collie verify`, as the host collects it. */
const agentRan = (argv: ReadonlyArray<string> = [], expect: "pass" | "fail" = "pass") =>
  collect(evidenceDir(dir, runId), {
    run: runId,
    name: "mine",
    executable: tool,
    argv,
    cwd: rig.projectDir,
    by: "agent",
    expect,
  }).pipe(Effect.orDie);

const journal = () => readVerifications(evidenceDir(dir, runId)).pipe(Effect.orDie);

/** The host's check of `unit`, for the gate unless asked otherwise, once `before` has run inside that host. */
const gate = <A>(
  before: Effect.Effect<
    A,
    never,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Store | Host
  >,
  asked: { readonly pass?: "gate"; readonly expect?: "fail" } = { pass: "gate" },
) =>
  Effect.gen(function* () {
    yield* (yield* Store).admit({
      request: `req-${runId}`,
      run: runId,
      workflow: "proof",
      project: rig.projectDir,
      input: {},
      provenance: {},
      options: {},
      generation: "proof@1",
      execution: `execution-${runId}`,
      task: null,
      parent: null,
    });
    const earlier = yield* before;
    const host = yield* Host;
    const ran = yield* host
      .verify({ runId, name: "unit", cwd: rig.projectDir, ...asked })
      .pipe(Effect.orDie);
    return { earlier, ran };
  }).pipe(
    Effect.provide(foundationLayer({ dir, userDir: rig.userDir })),
    Effect.scoped,
    Effect.orDie,
  );

const ranAgain = (got: { readonly ran: { readonly id: string; readonly by: string } }) =>
  Effect.gen(function* () {
    expect(got.ran.by).toBe("collie");
    expect((yield* journal()).at(-1)?.id).toBe(got.ran.id);
  });

test("the gate answers with an agent's pass of exactly its command on this tree, and runs nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const got = yield* gate(agentRan());
      expect(got.ran.id).toBe(got.earlier.id);
      expect(yield* journal()).toHaveLength(1);
      const log = yield* (yield* FileSystem.FileSystem).readFileString(
        `${runDir(dir, runId)}/log.txt`,
      );
      expect(log).toContain(`gate: unit relies on verification ${got.earlier.id}`);
    }),
  ));

test("a pass with another argument is not the check's, so the gate runs it", () =>
  runEffect(gate(agentRan(["--bail"])).pipe(Effect.flatMap(ranAgain))));

test("a pass collected in another environment is not relied on", () =>
  runEffect(
    gate(
      agentRan().pipe(
        Effect.tap((passed) =>
          appendVerification(evidenceDir(dir, runId), {
            ...passed,
            id: "elsewhere",
            environment: "another toolchain",
          }).pipe(Effect.orDie),
        ),
      ),
    ).pipe(Effect.flatMap(ranAgain)),
  ));

test("a pass recorded before this host started is not relied on", () =>
  runEffect(
    Effect.gen(function* () {
      yield* agentRan();
      yield* ranAgain(yield* gate(Effect.void));
    }),
  ));

test("a verification expecting a failure always runs", () =>
  runEffect(
    Effect.gen(function* () {
      const got = yield* gate(agentRan(), { expect: "fail" });
      expect(got.ran.expect).toBe("fail");
      yield* ranAgain(got);
    }),
  ));

test("where the latest record of that command on this tree failed, the gate runs it again", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const red = `${rig.root}/red`;
      const got = yield* gate(
        Effect.gen(function* () {
          yield* agentRan();
          yield* fs.writeFileString(red, "").pipe(Effect.orDie);
          const failed = yield* agentRan();
          yield* fs.remove(red).pipe(Effect.orDie);
          return failed;
        }),
      );
      expect(got.earlier.result).toBe("fail");
      expect(got.ran.result).toBe("pass");
      yield* ranAgain(got);
    }),
  ));

/** The host's check, on a Machine whose memory is read from this rig and again every 50 ms. */
const gateOnRig = <A>(
  before: Parameters<typeof gate<A>>[0],
  asked?: Parameters<typeof gate<A>>[1],
) =>
  gate(before, asked).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ ...rig.env(), COLLIE_MEMORY_EVERY: "50 millis" }),
      ),
    ),
  );

const waitingFor = () => memoryWaitOf(runDir(dir, runId));

test("a Check pass waits while its Machine is short of memory, runs nothing meanwhile, then runs", () =>
  runEffect(
    Effect.gen(function* () {
      let ranWhileWaiting = -1;
      const freeOnceWaiting = Effect.gen(function* () {
        while ((yield* waitingFor()) === null) yield* Effect.sleep("20 millis");
        ranWhileWaiting = (yield* journal()).length;
        yield* rig.memory(50).pipe(Effect.orDie);
      });
      const got = yield* gateOnRig(
        Effect.gen(function* () {
          yield* rig.memory(2).pipe(Effect.orDie);
          yield* Effect.forkChild(freeOnceWaiting);
        }),
      );
      expect(ranWhileWaiting).toBe(0);
      yield* ranAgain(got);
      expect(yield* waitingFor()).toBeNull();
      const log = yield* (yield* FileSystem.FileSystem).readFileString(
        `${rig.root}/host/agents/${runId}/agents.log`,
      );
      expect(log).toContain("gate: unit: waiting for memory on ");
      expect(log).toMatch(/gate: unit: waited \S+ for memory/);
    }),
  ));

test("a stop of a Run whose Check pass waits for memory runs nothing, however soon memory frees", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stopOnceWaiting = Effect.gen(function* () {
        while ((yield* waitingFor()) === null) yield* Effect.sleep("20 millis");
        yield* fs.writeFileString(controlPath(dir, STOP, runId), "").pipe(Effect.orDie);
        yield* rig.memory(50).pipe(Effect.orDie);
      });
      const got = yield* gateOnRig(
        Effect.gen(function* () {
          yield* rig.memory(2).pipe(Effect.orDie);
          yield* Effect.forkChild(stopOnceWaiting);
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(got)).toBe(true);
      expect(yield* journal()).toHaveLength(0);
      expect(yield* waitingFor()).toBeNull();
    }),
  ));

test("a gate answered from an agent's pass on the same tree does not wait for memory", () =>
  runEffect(
    Effect.gen(function* () {
      const got = yield* gateOnRig(
        Effect.gen(function* () {
          const passed = yield* agentRan();
          yield* rig.memory(2).pipe(Effect.orDie);
          return passed;
        }),
      );
      expect(got.ran.id).toBe(got.earlier.id);
      expect(yield* waitingFor()).toBeNull();
    }),
  ));
