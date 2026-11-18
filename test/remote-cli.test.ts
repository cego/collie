import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Effect, Exit, FileSystem, Fiber, Schema, Scope, Stream, flow, Result } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { connect } from "../src/host";
import { evidenceDir, runDir } from "../src/engine";
import { appendMetric } from "../src/metrics";
import { appendDrift } from "../src/drift";
import { readCards } from "../src/cards";
import { INTENT_FILE, readIntent } from "../src/intent";
import { RunRecords } from "../src/run-records";
import { appendLine } from "../src/steering";
import { hostRecords, hostRunRecords, ledgerOf, recordsAt, registeredAt } from "./support/records";
import { recordsReadLayer } from "../src/records";
import { readAudit } from "../src/audit";
import { encodeVerifying, readVerifications, VERIFYING } from "../src/verify";
import { runEffect } from "./support/effect";
import { exec } from "./support/command";
import { until } from "./support/host";
import { twoMachines, type Side } from "./support/peers";
import { collieCommand } from "./support/world";

const started = flow(
  Schema.decodeUnknownResult(Schema.Struct({ runId: Schema.String })),
  Result.getOrThrow,
);
const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

let held: Scope.Closeable;
let first: Side;
let second: Side;
let runId: string;
let dir: string;
let evidence: string;

beforeAll(() =>
  runEffect(
    Effect.gen(function* () {
      held = yield* Scope.make();
      yield* twoMachines(
        "collie-remote-record-",
        (one, two) =>
          Effect.gen(function* () {
            first = one;
            second = two;
            const fs = yield* FileSystem.FileSystem;
            yield* exec(["git", "remote", "add", "origin", "git@example.test:team/app.git"], {
              cwd: second.world.project,
            });
            const outputs = `${second.world.home}/outputs.json`;
            yield* fs.writeFileString(outputs, encode([{ verdict: "done" }]));
            const launch = yield* second.cli([
              "run",
              "start",
              "plain",
              "--goal",
              "remote goal",
              "--input",
              "note=remote",
            ]);
            expect(launch.envelope.ok).toBe(true);
            runId = started(launch.envelope.data).runId;
            const owner = yield* connect(second.world.state);
            yield* until(
              () => owner.run({ runId }),
              (view) => view?.status.status === "complete",
            );
            dir = runDir(second.world.state, runId);
            evidence = evidenceDir(second.world.state, runId);
            yield* fs.writeFileString(
              `${dir}/remote-output.json`,
              encode({ answer: "from the owner" }),
            );
            yield* fs.symlink(first.world.home, `${dir}/outside`);
            yield* fs.writeFileString(
              `${first.world.home}/private.json`,
              encode({ secret: "outside the Run" }),
            );
            yield* appendMetric(evidence, {
              at: "2026-10-12T00:00:00Z",
              kind: "slice",
              subject: "remote-slice",
              value: 1,
              note: "done",
            }).pipe(Effect.provide(recordsAt(second.world.state)));
            yield* appendDrift(dir, {
              kind: "skipped",
              at: "2026-10-12T00:00:00Z",
              run: runId,
              reason: "remote drift",
            }).pipe(Effect.provide(recordsAt(second.world.state)));
            yield* first.lists([second]);
          }),
        ["plain.workflow.ts", "completed-agent.workflow.ts"],
      ).pipe(Scope.provide(held));
    }),
  ),
);

afterAll(() => runEffect(Scope.close(held, Exit.void)));

test("an empty caller reads a Run's records from its owning Machine, named or not", () =>
  runEffect(
    Effect.gen(function* () {
      expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
      const caller = yield* connect(first.world.state);
      expect(yield* caller.runs({ task: null })).toEqual([]);
      for (const prefix of [[], ["--machine", "second"]]) {
        const outputs = (yield* first.cli([...prefix, "run", "output", runId, "--full"])).envelope;
        expect(outputs).toMatchObject({
          ok: true,
          data: {
            outputs: expect.arrayContaining([
              { path: "remote-output.json", value: { answer: "from the owner" } },
            ]),
          },
        });
        expect(encode(outputs)).not.toContain("outside the Run");
        expect((yield* first.cli([...prefix, "run", "metrics", runId])).envelope).toMatchObject({
          ok: true,
          data: { metrics: { slices: { done: 1, total: 1 } } },
        });
        expect(encode((yield* first.cli([...prefix, "run", "drift", runId])).envelope)).toContain(
          "remote drift",
        );
        const cards = yield* hostRecords(second.world.state, readCards(dir));
        expect(cards.length).toBeGreaterThan(0);
        expect(encode((yield* first.cli([...prefix, "run", "cards", runId])).envelope)).toContain(
          cards[0]!.id,
        );
        expect(
          (yield* first.cli([...prefix, "run", "intent", "show", runId])).envelope,
        ).toMatchObject({ ok: true, data: { intent: { goal: "remote goal" } } });
        expect((yield* first.cli([...prefix, "run", "checks", runId])).envelope).toMatchObject({
          ok: true,
          data: { running: null, done: [] },
        });
        expect((yield* first.cli([...prefix, "run", "actions", runId])).envelope.ok).toBe(true);
      }
    }),
  ));

test("an Intent mutation from an empty caller lands once on its owning Machine", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const owner = yield* connect(second.world.state);
      const change = [
        "run",
        "intent",
        "set-goal",
        runId,
        "amended remotely",
        "--request-id",
        "remote-intent",
      ];
      expect((yield* first.cli(change)).envelope.ok).toBe(true);
      expect((yield* first.cli(change)).envelope.ok).toBe(true);
      expect(
        Option.getOrUndefined(
          Option.map(
            Option.fromNullishOr(yield* hostRecords(second.world.state, readIntent(dir))),
            (present) =>
              Arr.filter(present.history, (one) => pipe_(one.change, Str.includes("goal"))),
          ),
        ),
      ).toHaveLength(1);
      expect(
        (yield* first.cli(["run", "intent", "authority", runId, "auto_correct=false"])).envelope.ok,
      ).toBe(true);
      expect(
        (yield* first.cli(["run", "intent", "add-constraint", runId, "keep the evidence"])).envelope
          .ok,
      ).toBe(true);
      const added = Option.getOrUndefined(
        Arr.findFirst(
          (yield* hostRecords(second.world.state, readIntent(dir)))!.constraints,
          (one) => one.text === "keep the evidence",
        ),
      )!;
      expect(
        (yield* first.cli(["run", "intent", "remove-constraint", runId, added.id])).envelope.ok,
      ).toBe(true);
      expect(
        (yield* hostRecords(second.world.state, readIntent(dir)))?.authority.auto_correct,
      ).toBe(false);
      yield* owner.declare({ frontDoor: "cli" });
      const invalidAuthority = yield* owner
        .changeIntent({
          runId,
          change: { kind: "authority", patch: { max_corrections_per_constraint: -1 } },
          propagate: false,
          request: "invalid-authority",
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(invalidAuthority)).toBe(true);
      expect(
        (yield* hostRecords(second.world.state, readIntent(dir)))?.authority
          .max_corrections_per_constraint,
      ).toBe(2);

      expect(
        (yield* first.cli(["run", "intent", "verification", runId, "--name", "unit", "--", "true"]))
          .envelope.ok,
      ).toBe(true);
      const replay = {
        runId,
        change: {
          kind: "verification" as const,
          name: "replay",
          command: { executable: "true", argv: [], cwd: "worktree" },
        },
        propagate: false,
        request: "grant-replay",
      };
      const granted = yield* owner.changeIntent(replay);
      expect((yield* owner.changeIntent(replay)).version).toBe(granted.version);
      yield* owner.changeIntent({
        ...replay,
        change: { ...replay.change, command: null },
        request: "withdraw-replay",
      });
      const withdrawn = (yield* hostRecords(second.world.state, readIntent(dir)))!;
      yield* owner.changeIntent(replay);
      expect(yield* hostRecords(second.world.state, readIntent(dir))).toEqual(withdrawn);
      expect(Arr.map(withdrawn.authority.run_verification, (one) => one.name)).not.toContain(
        "replay",
      );
      yield* owner.grant({
        runId,
        name: "legacy",
        command: { executable: "true", argv: [], cwd: "worktree" },
        request: "legacy-grant",
      });
      expect(
        (yield* first.cli([
          "run",
          "intent",
          "verification",
          runId,
          "--name",
          "legacy",
          "--request-id",
          "legacy-grant",
          "--",
          "true",
        ])).envelope.ok,
      ).toBe(true);
      expect((yield* first.cli(["run", "intent", "remember", runId])).envelope.ok).toBe(true);
      expect(yield* fs.exists(`${second.world.config}/verify/example.test/team/app.json`)).toBe(
        true,
      );
      expect(yield* fs.exists(`${first.world.config}/verify/example.test/team/app.json`)).toBe(
        false,
      );
      const audit = yield* readAudit(dir).pipe(
        Effect.provide(recordsReadLayer(second.world.state)),
      );
      expect(
        Option.getOrUndefined(Arr.findFirst(audit, (one) => one.request === "remote-intent"))?.actor
          .origin,
      ).toBe("cli");
    }),
  ));

test("a verify from an empty caller runs and is recorded on its owning Machine", () =>
  runEffect(
    Effect.gen(function* () {
      expect(
        (yield* first.cli([
          "verify",
          "--run",
          runId,
          "--name",
          "remote-check",
          "--",
          "sh",
          "-c",
          "printf 'owner output\\n'; pwd",
        ])).envelope,
      ).toMatchObject({
        ok: true,
        data: {
          verification: {
            result: "pass",
            cwd: second.world.project,
            tail: { stdout: expect.stringContaining("owner output") },
          },
        },
      });
      expect(
        Arr.map(
          yield* hostRecords(second.world.state, readVerifications(evidence)),
          (one) => one.name,
        ),
      ).toContain("remote-check");
      expect(
        yield* hostRecords(
          first.world.state,
          readVerifications(evidenceDir(first.world.state, runId)),
        ),
      ).toEqual([]);
      expect((yield* first.cli(["--machine", "second", "run", "report"])).envelope).toMatchObject({
        ok: true,
        data: {
          workflows: [{ workflow: "plain", verifications: { pass: 1, fail: 0, unstable: 0 } }],
        },
      });
    }),
  ));

test("disposition and resume from an empty caller answer as the owning Machine does", () =>
  runEffect(
    Effect.gen(function* () {
      expect(
        (yield* first.cli([
          "run",
          "disposition",
          runId,
          "--as",
          "abandoned",
          "--note",
          "remote record",
        ])).envelope.ok,
      ).toBe(true);
      expect(encode((yield* first.cli(["run", "disposition", runId])).envelope)).toContain(
        "remote record",
      );
      const ownerResume = (yield* second.cli(["run", "resume", runId])).envelope;
      expect(ownerResume.ok).toBe(false);
      expect((yield* first.cli(["run", "resume", runId])).envelope).toMatchObject({
        ok: false,
        error: { code: ownerResume.error?.code, message: ownerResume.error?.message },
      });
    }),
  ));

test("clearing an override from an empty caller clears it on the owning Machine", () =>
  runEffect(
    Effect.gen(function* () {
      const owner = yield* connect(second.world.state);
      const built = started(
        (yield* second.cli(["run", "start", "completed-agent", "--input", "goal=override"]))
          .envelope.data,
      );
      yield* until(
        () => owner.run({ runId: built.runId }),
        (view) => view?.status.status === "complete",
      );
      const agent = Option.getOrUndefined(
        Arr.findFirst(yield* registeredAt(second.world.state), (one) => one.runId === built.runId),
      )!;
      const terminal = agent.incarnation!.terminalId;
      yield* appendLine({
        kind: "manual_override",
        at: "2026-10-12T00:00:00Z",
        incarnation: terminal,
        by: "hook:UserPromptSubmit",
      }).pipe(Effect.provide(recordsAt(second.world.state)));
      expect(
        (yield* first.cli(["run", "clear-override", built.runId, agent.agent])).envelope.ok,
      ).toBe(true);
      expect((yield* ledgerOf(second.world.state, terminal)).at(-1)).toMatchObject({
        kind: "override_cleared",
      });
    }),
  ));

test("a grant from an empty caller holds when the owning Machine's Intent is broken", () =>
  runEffect(
    Effect.gen(function* () {
      yield* RunRecords.use((records) => records.put(runId, INTENT_FILE, "broken intent")).pipe(
        Effect.provide(recordsAt(second.world.state)),
      );
      const held = yield* first.cli([
        "run",
        "intent",
        "verification",
        runId,
        "--name",
        "held",
        "--",
        "true",
      ]);
      expect(held.envelope).toMatchObject({
        ok: true,
        data: {
          approved: expect.arrayContaining([
            { name: "held", executable: "true", argv: [], cwd: "worktree" },
          ]),
          warning: expect.stringContaining("The grant holds"),
        },
      });
    }),
  ));

test("a remote check's CLI follow prints output while the owning host's marker is still present", () =>
  runEffect(
    twoMachines(
      "collie-remote-log-",
      (first, second) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { runId } = started(
            (yield* second.cli(["run", "start", "plain", "--input", "note=log"])).envelope.data,
          );
          const owner = yield* connect(second.world.state);
          yield* until(
            () => owner.run({ runId }),
            (view) => view?.status.status === "complete",
          );
          yield* first.lists([second]);
          expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
          const records = hostRunRecords(() => second.world.state);
          const evidence = evidenceDir(second.world.state, runId);
          yield* fs.makeDirectory(evidence, { recursive: true });
          const log = `${evidence}/live.log`;
          yield* fs.writeFileString(log, "");
          yield* records.setControl(
            VERIFYING,
            runId,
            encodeVerifying({
              name: "remote-live",
              executable: "true",
              argv: [],
              pass: "finish",
              round: null,
              revision: "remote-revision",
              base: null,
              started: "2026-10-12T00:00:00Z",
              log,
            }),
          );
          const [command, ...argv] = yield* collieCommand;
          const handle = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
            ChildProcess.make(command!, [...argv, "--json", "run", "checks", runId, "--follow"], {
              env: { ...first.env },
              extendEnv: false,
              stdout: "pipe",
              stderr: "pipe",
              stdin: "ignore",
            }),
          );
          const stderr = `${first.world.home}/follow.txt`;
          yield* fs.writeFileString(stderr, "");
          const drain = yield* Stream.runForEach(Stream.decodeText(handle.stderr), (chunk) =>
            fs.writeFileString(stderr, chunk, { flag: "a" }).pipe(Effect.orDie),
          ).pipe(Effect.forkChild);
          const stdout = yield* Stream.runFold(
            Stream.decodeText(handle.stdout),
            () => "",
            (text, chunk) => text + chunk,
          ).pipe(Effect.forkChild);
          yield* fs.writeFileString(log, "the remote line arrives\n");
          yield* until(
            () => fs.readFileString(stderr),
            (text) => pipe_(text, Str.includes("the remote line arrives")),
          );
          expect(yield* records.control(VERIFYING, runId)).not.toBeNull();
          yield* records.setControl(VERIFYING, runId, null);
          expect(Number(yield* handle.exitCode)).toBe(0);
          yield* Fiber.join(drain);
          expect(yield* Fiber.join(stdout)).toContain('"ended":null');
        }),
      ["plain.workflow.ts"],
    ),
  ));
