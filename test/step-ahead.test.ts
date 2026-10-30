import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Option, Schema, Stream, flow, Result } from "effect";
import { frontDoor, socketOf } from "../src/host";
import { readLaunches } from "../src/launches";
import { everyRegistered } from "../src/registry";
import { deliveriesOf } from "../src/steering";
import { collie, proves } from "./support/world";
import { until } from "./support/host";

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
const runIdOf = flow(
  Schema.decodeUnknownResult(Schema.Struct({ runId: Schema.String })),
  Result.getOrThrow,
);
const herdrCall = flow(
  Schema.decodeUnknownResult(
    Schema.fromJsonString(Schema.Struct({ cmd: Schema.String, argv: Schema.Array(Schema.String) })),
  ),
  Result.getOrThrow,
);

// A launch is recorded before its prompt is written, so the prompt is what is waited on.
const promptOf = (state: string, runId: string, operation: string) =>
  until(
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.readFileString(`${state}/agents/${runId}/${operation}.prompt.md`);
      }).pipe(Effect.orElseSucceed(() => null)),
    (prompt) => prompt !== null,
  ).pipe(Effect.map((prompt) => prompt!));

test(
  "a pause before B holds at entry, before its agent, until Continue",
  () =>
    proves(
      "collie-step-pause-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputs = `${world.home}/outputs.json`;
          yield* fs.writeFileString(outputs, encode([null, null]));
          const start = yield* collie(
            world,
            ["run", "start", "step-ahead", "--input", "goal=pause"],
            { FAKE_HERDR_OUTPUTS: outputs },
          );
          expect(start.envelope.ok).toBe(true);
          const { runId } = runIdOf(start.envelope.data);
          const first = (yield* until(
            () => readLaunches(world.state, runId),
            (rows) => rows.length === 1,
          ))[0]!;
          const armed = yield* collie(world, ["run", "hold", runId, "--before", "b"]);
          expect(armed.envelope).toMatchObject({ ok: true });
          const door = yield* frontDoor(socketOf(world.state));
          const detail = () =>
            door
              .runDetail({ runId, tail: false, pages: 1, refreshMr: false })
              .pipe(Stream.runHead, Effect.map(Option.getOrNull));
          expect(
            Option.getOrUndefined(
              Option.flatMap(Option.fromNullishOr(yield* detail()), (present) =>
                Option.flatMap(Option.fromNullishOr(present.flow), (present_) =>
                  Option.map(Option.fromNullishOr(present_.lanes[0]), (present__) =>
                    Option.getOrUndefined(
                      Arr.findFirst(present__.nodes, (node) => node.id === "b"),
                    ),
                  ),
                ),
              ),
            ),
          ).toMatchObject({ pause: { by: expect.any(String) }, said: "Pauses before it" });
          yield* fs.writeFileString(first.output, encode("done"));
          const held = (yield* until(
            detail,
            (value) =>
              Option.getOrUndefined(
                Option.flatMap(Option.fromNullishOr(value), (present___) =>
                  Option.flatMap(Option.fromNullishOr(present___.flow), (present____) =>
                    Option.flatMap(Option.fromNullishOr(present____.lanes[0]), (present_____) =>
                      Option.map(
                        Option.fromNullishOr(
                          Option.getOrUndefined(
                            Arr.findFirst(present_____.nodes, (node) => node.id === "b"),
                          ),
                        ),
                        (present______) => present______.wait,
                      ),
                    ),
                  ),
                ),
              ) === "hold",
          ))!;
          const b = Option.getOrUndefined(
            Arr.findFirst(held.flow!.lanes[0]!.nodes, (node) => node.id === "b"),
          )!;
          expect(b).toMatchObject({ state: "waiting", primary: "continue", pause: null });
          expect(b.said).toMatch(/^Paused here, as .+ asked$/);
          expect(Arr.map(yield* readLaunches(world.state, runId), (one) => one.operation)).toEqual([
            "a",
          ]);
          expect((yield* collie(world, ["run", "release", runId])).envelope.ok).toBe(true);
          yield* until(
            () => readLaunches(world.state, runId),
            (rows) => Arr.some(rows, (one) => one.operation === "b"),
          );
          const late = yield* collie(world, ["run", "hold", runId, "--before", "a"]);
          expect(late.envelope.ok).toBe(false);
          expect(late.envelope.error?.message).toContain("a");
          const entry = Option.getOrUndefined(
            Arr.findFirst(yield* everyRegistered(world.state), (one) => one.agent === first.agent),
          )!;
          expect(
            (yield* collie(world, ["run", "hold", runId, "--before", "c"], {
              HERDR_PANE_ID: entry.paneId,
            })).envelope.ok,
          ).toBe(true);
          expect(
            Option.getOrUndefined(
              Option.flatMap(Option.fromNullishOr(yield* detail()), (present_______) =>
                Option.flatMap(Option.fromNullishOr(present_______.flow), (present________) =>
                  Option.flatMap(
                    Option.fromNullishOr(present________.lanes[0]),
                    (present_________) =>
                      Option.flatMap(
                        Option.fromNullishOr(
                          Option.getOrUndefined(
                            Arr.findFirst(present_________.nodes, (node) => node.id === "c"),
                          ),
                        ),
                        (present__________) =>
                          Option.map(
                            Option.fromNullishOr(present__________.pause),
                            (present___________) => present___________.by,
                          ),
                      ),
                  ),
                ),
              ),
            ),
          ).toBe(first.agent);
          const second = Option.getOrUndefined(
            Arr.findFirst(yield* readLaunches(world.state, runId), (one) => one.operation === "b"),
          )!;
          yield* fs.writeFileString(second.output, encode("done"));
          const check = (yield* until(
            detail,
            (one) =>
              Option.getOrUndefined(
                Option.flatMap(Option.fromNullishOr(one), (present____________) =>
                  Option.flatMap(
                    Option.fromNullishOr(present____________.flow),
                    (present_____________) =>
                      Option.flatMap(
                        Option.fromNullishOr(present_____________.lanes[0]),
                        (present______________) =>
                          Option.map(
                            Option.fromNullishOr(
                              Option.getOrUndefined(
                                Arr.findFirst(
                                  present______________.nodes,
                                  (node) => node.id === "c",
                                ),
                              ),
                            ),
                            (present_______________) => present_______________.wait,
                          ),
                      ),
                  ),
                ),
              ) === "hold",
          ))!;
          expect(
            Option.getOrUndefined(
              Arr.findFirst(check.flow!.lanes[0]!.nodes, (node) => node.id === "c"),
            )?.said,
          ).toBe(`Paused here, as ${first.agent} asked`);
        }),
      ["step-ahead.workflow.ts"],
    ),
  120_000,
);

test(
  "a failed Step's note is read by the prompt made after resume",
  () =>
    proves(
      "collie-step-retry-note-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputs = `${world.home}/outputs.json`;
          yield* fs.writeFileString(outputs, encode([null]));
          const start = yield* collie(
            world,
            ["run", "start", "step-retry-note", "--input", `gates=${world.home}`],
            { FAKE_HERDR_OUTPUTS: outputs },
          );
          const { runId } = runIdOf(start.envelope.data);
          const door = yield* frontDoor(socketOf(world.state));
          const detail = () =>
            door
              .runDetail({ runId, tail: false, pages: 1, refreshMr: false })
              .pipe(Stream.runHead, Effect.map(Option.getOrNull));
          yield* until(detail, (one) => one?.flow?.lanes[0]?.nodes[0]?.state === "failed");
          expect(
            (yield* collie(world, [
              "run",
              "steer",
              runId,
              "--step",
              "b",
              "Check the failed assertion.",
            ])).envelope.ok,
          ).toBe(true);
          yield* fs.writeFileString(`${world.home}/pass`, "");
          expect((yield* collie(world, ["run", "resume", runId])).envelope.ok).toBe(true);
          expect(yield* promptOf(world.state, runId, "b")).toStartWith(
            "Check the failed assertion.\n\n",
          );
        }),
      ["step-retry-note.workflow.ts"],
    ),
  120_000,
);

test(
  "notes wait for B's first prompt, while a withdrawn note and a withdrawn pause do not",
  () =>
    proves(
      "collie-step-notes-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputs = `${world.home}/outputs.json`;
          yield* fs.writeFileString(outputs, encode([null, null]));
          const start = yield* collie(
            world,
            ["run", "start", "step-ahead", "--input", "goal=notes"],
            { FAKE_HERDR_OUTPUTS: outputs },
          );
          const { runId } = runIdOf(start.envelope.data);
          const first = (yield* until(
            () => readLaunches(world.state, runId),
            (rows) => rows.length === 1,
          ))[0]!;
          expect((yield* collie(world, ["run", "hold", runId, "--before", "b"])).envelope.ok).toBe(
            true,
          );
          expect(
            (yield* collie(world, ["run", "release", runId, "--before", "b"])).envelope.ok,
          ).toBe(true);
          const told = yield* collie(world, [
            "run",
            "steer",
            runId,
            "--step",
            "b",
            "Check the race first.",
          ]);
          expect(told.envelope).toMatchObject({ ok: true });
          const removed = yield* collie(world, [
            "run",
            "steer",
            runId,
            "--step",
            "b",
            "Ignore the race.",
          ]);
          expect(removed.envelope.ok).toBe(true);
          const door = yield* frontDoor(socketOf(world.state));
          const detail = () =>
            door
              .runDetail({ runId, tail: false, pages: 1, refreshMr: false })
              .pipe(Stream.runHead, Effect.map(Option.getOrNull));
          const node = Option.getOrUndefined(
            Arr.findFirst((yield* detail())!.flow!.lanes[0]!.nodes, (one) => one.id === "b"),
          )!;
          expect(node.notes).toHaveLength(2);
          expect(node.notes![0]).toMatchObject({
            text: "Check the race first.",
            read: null,
            by: expect.any(String),
            at: expect.any(String),
          });
          expect(
            (yield* collie(world, ["run", "withdraw-note", runId, node.notes![1]!.id])).envelope.ok,
          ).toBe(true);
          const question = yield* collie(world, [
            "run",
            "steer",
            runId,
            "--step",
            "question",
            "No question please",
          ]);
          expect(question.envelope.ok).toBe(false);
          expect(question.envelope.error?.message).toContain("question");
          yield* fs.writeFileString(first.output, encode("done"));
          const prompt = yield* promptOf(world.state, runId, "b");
          expect(prompt).toStartWith("Check the race first.\n\n");
          expect(prompt).not.toContain("Ignore the race.");
          const after = Option.getOrUndefined(
            Arr.findFirst((yield* detail())!.flow!.lanes[0]!.nodes, (one) => one.id === "b"),
          )!;
          expect(after.notes).toHaveLength(1);
          expect(after.notes![0]!.read).toEqual(expect.any(String));
          expect(
            (yield* collie(world, ["run", "withdraw-note", runId, after.notes![0]!.id])).envelope
              .ok,
          ).toBe(false);
        }),
      ["step-ahead.workflow.ts"],
    ),
  120_000,
);

test(
  "a steer sent while a just-launched agent's step is still going out reaches it after the step",
  () =>
    proves(
      "collie-step-steer-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputs = `${world.home}/outputs.json`;
          yield* fs.writeFileString(outputs, encode([null, null]));
          // herdr refuses the step's first prompt as a busy pane, so it is retried later.
          const start = yield* collie(
            world,
            ["run", "start", "step-ahead", "--input", "goal=steer"],
            {
              FAKE_HERDR_OUTPUTS: outputs,
              FAKE_HERDR_PROMPT_ERROR: "agent_blocked",
              FAKE_HERDR_PROMPT_ERROR_TIMES: "1",
            },
          );
          const { runId } = runIdOf(start.envelope.data);
          yield* until(
            () => deliveriesOf(world.state, runId),
            (all) => Arr.some(all, (one) => one.delivery.state === "deferred"),
          );
          const told = yield* collie(world, ["run", "steer", runId, "Check the race first."]);
          expect(told.envelope).toMatchObject({ ok: true });

          const prompts = Arr.map(
            Arr.filter(
              Arr.map(
                Str.split(Str.trim(yield* fs.readFileString(Bun.env.FAKE_HERDR_LOG!)), "\n"),
                (line) => herdrCall(line),
              ),
              (call) => call.cmd === "agent prompt",
            ),
            (call) =>
              Option.getOrUndefined(
                Option.map(Option.fromNullishOr(call.argv[3]), (present________________) =>
                  pipe_(present________________, Str.includes("Check the race first.")),
                ),
              )
                ? "steer"
                : "step",
          );
          // The first step prompt is the one refused.
          expect(prompts).toEqual(["step", "step", "steer"]);
          const first = (yield* readLaunches(world.state, runId))[0]!;
          yield* fs.writeFileString(first.output, encode("done"));
          yield* until(
            () => readLaunches(world.state, runId),
            (rows) => Arr.some(rows, (one) => one.operation === "b"),
          );
        }),
      ["step-ahead.workflow.ts"],
    ),
  120_000,
);
