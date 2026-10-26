import { expect, test } from "bun:test";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { frontDoor, socketOf } from "../src/host";
import { readLaunches } from "../src/launches";
import { everyRegistered } from "../src/registry";
import { until } from "./support/host";
import { collie, proves } from "./support/world";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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
          const { runId } = Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }))(
            started.envelope.data,
          );
          const launch = (yield* until(
            () => readLaunches(world.state, runId),
            (rows) => rows.some((one) => one.operation === "second"),
          )).find((one) => one.operation === "second")!;
          const entry = (yield* until(
            () => everyRegistered(world.state),
            (rows) => rows.some((one) => one.agent === launch.agent),
          )).find((one) => one.agent === launch.agent)!;
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
              one?.flow?.lanes[0]?.nodes.find((node) => node.id === "second")?.state === "failed",
          ))!;
          expect(detail.verifications).toMatchObject([
            { name: "second-proof", step: "second", place: null },
          ]);
          const log = (yield* fs.readFileString(`${world.state}/runs/${runId}/log.txt`))
            .trimEnd()
            .split("\n");
          const second = detail.flow!.lanes[0]!.nodes.find((node) => node.id === "second")!;
          expect(second.log).toBeGreaterThan(0);
          expect(log[second.log! - 1]).toBe("── Second ──");
          expect(log.filter((line) => line === "── Second ──")).toHaveLength(1);
          expect(second.why?.split("\n").length).toBeLessThanOrEqual(20);
          expect(second.why).toStartWith(`${process.execPath} -e `);
          expect(second.why).toEndWith("last failure detail");
          expect(second.why).not.toContain("failure line 0\n");
        }),
      ["step-proof.workflow.ts"],
    ),
  120_000,
);
