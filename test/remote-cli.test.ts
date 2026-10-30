import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, Exit, FileSystem, Fiber, Schema, Stream, flow, Result } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { connect } from "../src/host";
import { evidenceDir, runDir } from "../src/engine";
import { appendMetric } from "../src/metrics";
import { appendDrift } from "../src/drift";
import { readCards } from "../src/cards";
import { readIntent } from "../src/intent";
import { everyRegistered } from "../src/registry";
import { appendLine, ledgerPath, readLedger } from "../src/steering";
import { readAudit } from "../src/audit";
import { encodeVerifying, readVerifications, VERIFYING_FILE } from "../src/verify";
import { runEffect } from "./support/effect";
import { exec } from "./support/command";
import { until } from "./support/host";
import { twoMachines } from "./support/peers";
import { collieCommand } from "./support/world";

const started = flow(
  Schema.decodeUnknownResult(Schema.Struct({ runId: Schema.String })),
  Result.getOrThrow,
);
const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

test(
  "every Run record and Intent mutation reaches its owning Machine from an empty caller",
  () =>
    runEffect(
      twoMachines(
        "collie-remote-record-",
        (first, second) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            yield* exec(["git", "remote", "add", "origin", "git@example.test:team/app.git"], {
              cwd: second.world.project,
            });
            const outputs = `${second.world.home}/agent-outputs.json`;
            yield* fs.writeFileString(outputs, encode([{ verdict: "done" }]));
            const launch = yield* second.cli(
              ["run", "start", "plain", "--goal", "remote goal", "--input", "note=remote"],
              { FAKE_HERDR_OUTPUTS: outputs },
            );
            expect(launch.envelope.ok).toBe(true);
            const { runId } = started(launch.envelope.data);
            const owner = yield* connect(second.world.state);
            yield* until(
              () => owner.run({ runId }),
              (view) => view?.status.status === "complete",
            );
            const dir = runDir(second.world.state, runId);
            const evidence = evidenceDir(second.world.state, runId);
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
            });
            yield* appendDrift(dir, {
              kind: "skipped",
              at: "2026-10-12T00:00:00Z",
              run: runId,
              reason: "remote drift",
            });
            yield* first.lists([second]);
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
            const caller = yield* connect(first.world.state);
            expect(yield* caller.runs({ task: null })).toEqual([]);
            for (const prefix of [[], ["--machine", "second"]]) {
              const outputs = (yield* first.cli([...prefix, "run", "output", runId])).envelope;
              expect(outputs).toMatchObject({
                ok: true,
                data: {
                  outputs: expect.arrayContaining([
                    { path: "remote-output.json", value: { answer: "from the owner" } },
                  ]),
                },
              });
              expect(encode(outputs)).not.toContain("outside the Run");
              expect(
                (yield* first.cli([...prefix, "run", "metrics", runId])).envelope,
              ).toMatchObject({ ok: true, data: { metrics: { slices: { done: 1, total: 1 } } } });
              expect(
                encode((yield* first.cli([...prefix, "run", "drift", runId])).envelope),
              ).toContain("remote drift");
              const cards = yield* readCards(dir);
              expect(cards.length).toBeGreaterThan(0);
              expect(
                encode((yield* first.cli([...prefix, "run", "cards", runId])).envelope),
              ).toContain(cards[0]!.id);
              expect(
                (yield* first.cli([...prefix, "run", "intent", "show", runId])).envelope,
              ).toMatchObject({ ok: true, data: { intent: { goal: "remote goal" } } });
              expect(
                (yield* first.cli([...prefix, "run", "checks", runId])).envelope,
              ).toMatchObject({ ok: true, data: { running: null, done: [] } });
              expect((yield* first.cli([...prefix, "run", "actions", runId])).envelope.ok).toBe(
                true,
              );
            }
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
                Option.map(Option.fromNullishOr(yield* readIntent(dir)), (present) =>
                  Arr.filter(present.history, (one) => pipe_(one.change, Str.includes("goal"))),
                ),
              ),
            ).toHaveLength(1);
            expect(
              (yield* first.cli(["run", "intent", "authority", runId, "auto_correct=false"]))
                .envelope.ok,
            ).toBe(true);
            expect(
              (yield* first.cli(["run", "intent", "add-constraint", runId, "keep the evidence"]))
                .envelope.ok,
            ).toBe(true);
            const added = Option.getOrUndefined(
              Arr.findFirst(
                (yield* readIntent(dir))!.constraints,
                (one) => one.text === "keep the evidence",
              ),
            )!;
            expect(
              (yield* first.cli(["run", "intent", "remove-constraint", runId, added.id])).envelope
                .ok,
            ).toBe(true);
            expect((yield* readIntent(dir))?.authority.auto_correct).toBe(false);
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
            expect((yield* readIntent(dir))?.authority.max_corrections_per_constraint).toBe(2);

            expect(
              (yield* first.cli([
                "run",
                "intent",
                "verification",
                runId,
                "--name",
                "unit",
                "--",
                "true",
              ])).envelope.ok,
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
            const withdrawn = (yield* readIntent(dir))!;
            yield* owner.changeIntent(replay);
            expect(yield* readIntent(dir)).toEqual(withdrawn);
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
            expect(
              yield* fs.exists(`${second.world.config}/verify/example.test/team/app.json`),
            ).toBe(true);
            expect(
              yield* fs.exists(`${first.world.config}/verify/example.test/team/app.json`),
            ).toBe(false);
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
            expect(Arr.map(yield* readVerifications(evidence), (one) => one.name)).toContain(
              "remote-check",
            );
            expect(yield* readVerifications(evidenceDir(first.world.state, runId))).toEqual([]);
            expect(
              (yield* first.cli(["--machine", "second", "run", "report"])).envelope,
            ).toMatchObject({
              ok: true,
              data: {
                workflows: [
                  { workflow: "plain", verifications: { pass: 1, fail: 0, unstable: 0 } },
                ],
              },
            });
            const audit = yield* readAudit(dir);
            expect(
              Option.getOrUndefined(Arr.findFirst(audit, (one) => one.request === "remote-intent"))
                ?.actor.origin,
            ).toBe("cli");
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
            const built = started(
              (yield* second.cli(["run", "start", "completed-agent", "--input", "goal=override"], {
                FAKE_HERDR_OUTPUTS: outputs,
              })).envelope.data,
            );
            yield* until(
              () => owner.run({ runId: built.runId }),
              (view) => view?.status.status === "complete",
            );
            const agent = Option.getOrUndefined(
              Arr.findFirst(
                yield* everyRegistered(second.world.state),
                (one) => one.runId === built.runId,
              ),
            )!;
            const terminal = agent.incarnation!.terminalId;
            const ledger = yield* ledgerPath(second.world.state, terminal);
            yield* appendLine(ledger, {
              kind: "manual_override",
              at: "2026-10-12T00:00:00Z",
              incarnation: terminal,
              by: "hook:UserPromptSubmit",
            });
            expect(
              (yield* first.cli(["run", "clear-override", built.runId, agent.agent])).envelope.ok,
            ).toBe(true);
            expect((yield* readLedger(ledger)).at(-1)).toMatchObject({ kind: "override_cleared" });
            yield* fs.writeFileString(`${dir}/intent.json`, "broken intent");
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
        ["plain.workflow.ts", "completed-agent.workflow.ts"],
      ),
    ),
  180_000,
);

test(
  "a remote check's CLI follow prints output while the owning host's marker is still present",
  () =>
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
            const dir = runDir(second.world.state, runId);
            const log = `${evidenceDir(second.world.state, runId)}/live.log`;
            yield* fs.writeFileString(log, "");
            yield* fs.writeFileString(
              `${dir}/${VERIFYING_FILE}`,
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
            expect(yield* fs.exists(`${dir}/${VERIFYING_FILE}`)).toBe(true);
            yield* fs.remove(`${dir}/${VERIFYING_FILE}`);
            expect(Number(yield* handle.exitCode)).toBe(0);
            yield* Fiber.join(drain);
            expect(yield* Fiber.join(stdout)).toContain('"ended":null');
          }),
        ["plain.workflow.ts"],
      ),
    ),
  180_000,
);
