// `collie schedule` reaching another Machine over the paired link (ADR-0052 D8, ADR-0057):
// two real hosts, each with its own fake herdr, as `remote-cli.test.ts` drives them.

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { hostname } from "node:os";
import { Effect, FileSystem, Schema, flow, Result } from "effect";
import { runEffect } from "./support/effect";
import { fixtures, stopHost } from "./support/host";
import { twoMachines, type Side } from "./support/peers";

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
const Listed = Schema.Struct({
  schedules: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      paused: Schema.Boolean,
      checkout: Schema.String,
      machine: Schema.Struct({ installation: Schema.String }),
    }),
  ),
  machines: Schema.Array(Schema.Struct({ machine: Schema.String, state: Schema.String })),
});

const save = (side: Side, module: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.copyFile(`${fixtures}/${module}`, `${side.world.user}/${module}`)),
    Effect.orDie,
  );
const installation = (side: Side) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${side.world.state}/installation`)),
    Effect.map((text) => Str.trim(text)),
    Effect.orDie,
  );
const add = (name: string, workflow: string, ...rest: ReadonlyArray<string>) => [
  "schedule",
  "add",
  name,
  workflow,
  "--cron",
  "0 7 * * *",
  ...rest,
];
/** What `side`'s own host keeps. */
const kept = (side: Side) =>
  Effect.gen(function* () {
    const own = yield* installation(side);
    return Arr.filter(
      (yield* listed(side)).schedules,
      ({ machine }) => machine.installation === own,
    );
  });
const listed = (side: Side, prefix: ReadonlyArray<string> = []) =>
  side
    .cli([...prefix, "schedule", "list"])
    .pipe(
      Effect.map(({ envelope }) =>
        flow(Schema.decodeUnknownResult(Listed), Result.getOrThrow)(envelope.data),
      ),
    );

test(
  "a Schedule is added, changed and listed on the Machine --machine names, decided by that Machine",
  () =>
    runEffect(
      twoMachines(
        "collie-schedule-remote-",
        (first, second) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            yield* save(second, "plain.workflow.ts");
            // A project's Layer stays on its Machine; the user Layer is the Flock's.
            const onlyFirst = `${first.world.project}/.collie/workflows`;
            yield* fs.makeDirectory(onlyFirst, { recursive: true });
            yield* fs.copyFile(
              `${fixtures}/attended.workflow.ts`,
              `${onlyFirst}/attended.workflow.ts`,
            );
            yield* first.lists([second]);
            const there = second.world.project;
            const added = yield* first.cli([
              "--machine",
              "second",
              ...add("nightly", "plain", "--input", "note=x", "--workspace", there),
            ]);
            const firstId = yield* installation(first);
            const secondId = yield* installation(second);
            expect(added.envelope).toMatchObject({
              ok: true,
              data: { change: "add", machine: { installation: secondId } },
            });
            expect(yield* fs.exists(`${second.world.state}/schedules/nightly`)).toBe(true);
            expect(yield* fs.exists(`${first.world.state}/schedules/nightly`)).toBe(false);
            const trail = yield* fs.readFileString(
              `${second.world.state}/schedules/nightly/operations.jsonl`,
            );
            expect(trail).toContain('"cli');
            expect(trail).toContain(firstId);

            for (const [refused, code] of [
              [add("none", "missing", "--input", "note=x", "--workspace", there), "invalid_input"],
              [add("bare", "plain", "--workspace", there), "needs_input"],
              [
                add("gone", "plain", "--input", "note=x", "--workspace", "/no/such"),
                "invalid_input",
              ],
              [add("mine", "attended", "--input", "work=x", "--workspace", there), "invalid_input"],
            ] as const) {
              const answer = yield* first.cli(["--machine", "second", ...refused]);
              expect(answer.envelope.error?.code).toBe(code);
            }
            expect((yield* fs.readDirectory(`${second.world.state}/schedules`)).sort()).toEqual([
              "nightly",
            ]);
            expect(yield* fs.exists(`${first.world.state}/schedules`)).toBe(false);
            expect(
              (yield* first.cli(add("local", "missing", "--workspace", first.world.project)))
                .envelope.error?.code,
            ).toBe("workflow_not_found");

            const paused = yield* first.cli([
              "--machine",
              "second",
              "schedule",
              "pause",
              "nightly",
            ]);
            expect(paused.envelope).toMatchObject({ ok: true, data: { change: "pause" } });
            expect(yield* kept(second)).toMatchObject([{ name: "nightly", paused: true }]);
            yield* first.cli(["--machine", "second", "schedule", "resume", "nightly"]);
            expect(yield* kept(second)).toMatchObject([{ paused: false }]);

            expect(
              (yield* first.cli(
                add("here", "attended", "--input", "work=x", "--workspace", first.world.project),
              )).envelope.ok,
            ).toBe(true);
            const flock = yield* listed(first);
            expect(
              Arr.map(flock.schedules, ({ name, machine }) => [name, machine.installation]),
            ).toEqual([
              ["here", firstId],
              ["nightly", secondId],
            ]);
            expect(flock.machines).toEqual([]);
            expect(
              Arr.map(
                (yield* listed(first, ["--machine", "second"])).schedules,
                ({ name }) => name,
              ),
            ).toEqual(["nightly"]);

            const removed = yield* first.cli([
              "--machine",
              "second",
              "schedule",
              "remove",
              "nightly",
            ]);
            expect(removed.envelope).toMatchObject({ ok: true, data: { change: "remove" } });
            expect(yield* kept(second)).toEqual([]);
            expect(Arr.map((yield* listed(first, [])).schedules, ({ name }) => name)).toEqual([
              "here",
            ]);

            const unknown = yield* first.cli(["--machine", "nowhere", "schedule", "list"]);
            expect(unknown.envelope.error?.code).toBe("invalid_input");
            yield* stopHost(second.world.state);
            const away = yield* listed(first);
            expect(Arr.map(away.schedules, ({ name }) => name)).toEqual(["here"]);
            expect(away.machines).toMatchObject([{ machine: "second", state: "away" }]);
            const unreachable = yield* first.cli(["--machine", "second", "schedule", "list"]);
            expect(unreachable.envelope.error?.code).toBe("machine_unreachable");
            expect(unreachable.exit).toBe(1);
          }),
        [],
      ),
    ),
  240_000,
);

test(
  "a Schedule moves to another Machine resumed, in the checkout given, once, and not while one is away",
  () =>
    runEffect(
      twoMachines(
        "collie-schedule-move-",
        (first, second) =>
          Effect.gen(function* () {
            yield* save(first, "plain.workflow.ts");
            yield* save(second, "plain.workflow.ts");
            yield* first.lists([second]);
            const here = first.world.project;
            expect(
              (yield* first.cli(add("daily", "plain", "--input", "note=x", "--workspace", here)))
                .envelope.ok,
            ).toBe(true);

            const move = [
              "schedule",
              "move",
              "daily",
              "--to",
              "second",
              "--workspace",
              second.world.project,
              "--request-id",
              "move-1",
            ];
            const moved = yield* first.cli(move);
            expect(moved.envelope).toMatchObject({
              ok: true,
              data: {
                change: "resume",
                schedule: { paused: false, checkout: second.world.project },
              },
            });
            expect((yield* first.cli(move)).envelope).toEqual(moved.envelope);
            expect(
              Arr.map((yield* listed(first)).schedules, ({ machine }) => machine.installation),
            ).toEqual([yield* installation(second)]);
            expect(yield* kept(second)).toMatchObject([
              { name: "daily", paused: false, checkout: second.world.project },
            ]);

            const back = yield* first.cli([
              "--machine",
              "second",
              "schedule",
              "move",
              "daily",
              "--to",
              hostname(),
              "--workspace",
              here,
            ]);
            expect(back.envelope).toMatchObject({
              ok: true,
              data: { schedule: { checkout: here } },
            });
            expect(yield* kept(second)).toEqual([]);

            yield* stopHost(second.world.state);
            const refused = yield* first.cli(["schedule", "move", "daily", "--to", "second"]);
            expect(refused.envelope.error?.code).toBe("machine_unreachable");
            const still = yield* listed(first);
            expect(encode(still.schedules)).toContain('"paused":false');
            expect(Arr.map(still.schedules, ({ name }) => name)).toEqual(["daily"]);
          }),
        [],
      ),
    ),
  240_000,
);
