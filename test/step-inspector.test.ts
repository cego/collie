import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Option, Schema, Stream, flow, Result } from "effect";
import { frontDoor, socketOf } from "../src/host";
import { readLaunches } from "../src/launches";
import { everyRegistered } from "../src/registry";
import { until } from "./support/host";
import { collie, proves } from "./support/world";
const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

test(
  "a Step's marker, verification and failing output stay with that Step",
  () =>
    proves(
      "collie-step-proof-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputs = `${world.home}/outputs.json`;
          yield* fs.writeFileString(outputs, encode([{ verdict: "done" }, null]));
          const started = yield* collie(
            world,
            ["run", "start", "step-proof", "--input", "goal=verify"],
            { FAKE_HERDR_OUTPUTS: outputs },
          );
          expect(started.envelope).toMatchObject({ ok: true });
          const { runId } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(started.envelope.data).pipe(Effect.orDie);
          const launch = Option.getOrUndefined(
            Arr.findFirst(
              yield* until(
                () => readLaunches(world.state, runId),
                (rows) => Arr.some(rows, (one) => one.operation === "second"),
              ),
              (one) => one.operation === "second",
            ),
          )!;
          const entry = Option.getOrUndefined(
            Arr.findFirst(
              yield* until(
                () => everyRegistered(world.state),
                (rows) => Arr.some(rows, (one) => one.agent === launch.agent),
              ),
              (one) => one.agent === launch.agent,
            ),
          )!;
          const script =
            'for (let i = 0; i < 25; i++) console.log("failure line", i); console.error("last failure detail"); process.exit(1)';
          const verified = yield* collie(
            world,
            ["verify", "--name", "second-proof", "--", process.execPath, "-e", script],
            { HERDR_PANE_ID: entry.paneId },
          );
          expect(verified.envelope).toMatchObject({ ok: true });
          expect(verified.exit).toBe(1);
          yield* fs.writeFileString(launch.output, encode({ verdict: "failed" }));
          const door = yield* frontDoor(socketOf(world.state));
          const read = () =>
            door
              .runDetail({ runId, tail: true, pages: 1, refreshMr: false })
              .pipe(Stream.runHead, Effect.map(Option.getOrNull));
          const detail = (yield* until(
            read,
            (one) =>
              Option.getOrUndefined(
                Option.flatMap(Option.fromNullishOr(one), (present) =>
                  Option.flatMap(Option.fromNullishOr(present.flow), (present_) =>
                    Option.flatMap(Option.fromNullishOr(present_.lanes[0]), (present__) =>
                      Option.map(
                        Option.fromNullishOr(
                          Option.getOrUndefined(
                            Arr.findFirst(present__.nodes, (node) => node.id === "second"),
                          ),
                        ),
                        (present___) => present___.state,
                      ),
                    ),
                  ),
                ),
              ) === "failed",
          ))!;
          expect(detail.verifications).toMatchObject([
            { name: "second-proof", step: "second", place: null },
          ]);
          const log = Str.split(
            Str.trimEnd(yield* fs.readFileString(`${world.state}/runs/${runId}/log.txt`)),
            "\n",
          );
          const second = Option.getOrUndefined(
            Arr.findFirst(detail.flow!.lanes[0]!.nodes, (node) => node.id === "second"),
          )!;
          expect(second.log).toBeGreaterThan(0);
          expect(log[second.log! - 1]).toBe("── Second ──");
          expect(Arr.filter(log, (line) => line === "── Second ──")).toHaveLength(1);
          expect(
            Option.getOrUndefined(
              Option.map(
                Option.fromNullishOr(second.why),
                (present____) => Str.split(present____, "\n").length,
              ),
            ),
          ).toBeLessThanOrEqual(20);
          expect(second.why).toStartWith(`${process.execPath} -e `);
          expect(second.why).toEndWith("last failure detail");
          expect(second.why).not.toContain("failure line 0\n");
        }),
      ["step-proof.workflow.ts"],
    ),
  120_000,
);
