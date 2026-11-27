import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Config, Effect, Option, Schema } from "effect";
import { expect, test } from "bun:test";
import { FileSystem, Stream } from "effect";
import { connect } from "../src/host";
import { sectionOf } from "../src/board-model";
import { RunRecords } from "../src/run-records";
import { OPEN_FINDINGS, readFindingStatuses } from "../src/finding-status";
import { hosted, settledRun } from "./support/hosted";
import { stopHost } from "./support/host";
import { hostRecords, recordsAt } from "./support/records";
import { suiteEnv } from "./support/effect";
import { epochMs } from "../src/time";

const root = new URL("../", import.meta.url).pathname;
const join = (...parts: Array<string>) => pipe(Arr.join(parts, "/"), Str.replaceAll(/\/+/g, "/"));

const Envelope = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Boolean,
    data: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String })),
  }),
);
const parseEnvelope = Schema.decodeUnknownEffect(Envelope);

const FindingsData = Schema.Struct({
  findings: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      run: Schema.NullOr(Schema.String),
    }),
  ),
});
const parseFindings = Schema.decodeUnknownEffect(FindingsData);

const cli = Effect.fn("test.cli")(function* (args: Array<string>, env: Record<string, string>) {
  const suite = yield* suiteEnv;
  const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
  const command = Option.isSome(binary)
    ? [binary.value]
    : [Bun.argv[0] ?? "bun", join(root, "src/main.ts")];
  const proc = Bun.spawn([...command, ...args], {
    cwd: root,
    env: { COLLIE_ROOT: root, PWD: root, ...suite, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = yield* Effect.promise(() =>
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
  );
  return { stdout, stderr, exit };
});

const envOf = (world: {
  readonly install: string;
  readonly state: string;
  readonly config: string;
  readonly home: string;
}) => ({
  COLLIE_ROOT: world.install,
  COLLIE_STATE_DIR: world.state,
  COLLIE_USER_DIR: world.config,
  HOME: world.home,
});

const clearCount = (state: string, runId: string) =>
  RunRecords.use((records) => records.put(runId, OPEN_FINDINGS, null)).pipe(
    Effect.provide(recordsAt(state)),
  );

const countOf = (state: string, runId: string) =>
  hostRecords(
    state,
    RunRecords.use((records) => records.fact(runId, OPEN_FINDINGS)),
  );

test("a settled Run's findings read open, a dismissal lowers the open count and a reopen raises it", () =>
  hosted("hw-findings-", ({ world }) =>
    Effect.gen(function* () {
      const run = yield* settledRun(world, "leaves");
      const client = yield* connect(world.state).pipe(Effect.orDie);
      yield* client.declare({ frontDoor: "board" });

      const both = yield* client.runFindings({ runId: run.id });
      expect(Arr.map(both, (one) => [one.id, one.status])).toEqual([
        [`${run.id}-F1`, "open"],
        [`${run.id}-F2`, "open"],
      ]);
      expect(yield* countOf(world.state, run.id)).toBe("2");

      const dismissed = yield* client.setFinding({
        runId: run.id,
        id: `${run.id}-F1`,
        status: "dismissed",
        reason: "by design",
        request: "f-1",
      });
      expect(dismissed).toMatchObject({
        id: `${run.id}-F1`,
        status: "dismissed",
        reason: "by design",
        by: "human:f-1",
      });
      expect(epochMs(dismissed.at)).toBeGreaterThan(0);
      expect(
        Arr.map(yield* client.runFindings({ runId: run.id }), (one) => [one.id, one.status]),
      ).toEqual([
        [`${run.id}-F1`, "dismissed"],
        [`${run.id}-F2`, "open"],
      ]);
      expect(
        Arr.findFirst(
          yield* client.runFindings({ runId: run.id }),
          (one) => one.id === `${run.id}-F1`,
        ).pipe(Option.map((one) => one.reason)),
      ).toEqual(Option.some("by design"));
      expect(yield* countOf(world.state, run.id)).toBe("1");

      yield* client.setFinding({
        runId: run.id,
        id: `${run.id}-F1`,
        status: "open",
        reason: null,
        request: "f-2",
      });

      expect(
        Arr.findFirst(
          yield* client.runFindings({ runId: run.id }),
          (one) => one.id === `${run.id}-F1`,
        ).pipe(Option.map((one) => one.status)),
      ).toEqual(Option.some("open"));
      expect(yield* countOf(world.state, run.id)).toBe("2");
      expect((yield* hostRecords(world.state, readFindingStatuses(run.dir))).length).toBe(2);
    }),
  ));

test("a dismissal with no reason, or of a finding the Run does not have, is refused and writes nothing", () =>
  hosted("hw-findings-refused-", ({ world }) =>
    Effect.gen(function* () {
      const run = yield* settledRun(world, "leaves");
      const client = yield* connect(world.state).pipe(Effect.orDie);
      yield* client.declare({ frontDoor: "board" });

      const blank = yield* client
        .setFinding({
          runId: run.id,
          id: `${run.id}-F1`,
          status: "dismissed",
          reason: "   ",
          request: "f-1",
        })
        .pipe(Effect.flip);
      expect(blank._tag).toBe("HostRefused");
      expect(blank._tag === "HostRefused" ? blank.reason : "").toContain("needs a reason");

      const unknown = yield* client
        .setFinding({
          runId: run.id,
          id: `${run.id}-F9`,
          status: "dismissed",
          reason: "gone",
          request: "f-2",
        })
        .pipe(Effect.flip);
      expect(unknown._tag).toBe("HostRefused");
      expect(unknown._tag === "HostRefused" ? unknown.reason : "").toContain(`${run.id}-F9`);

      expect(yield* hostRecords(world.state, readFindingStatuses(run.dir))).toEqual([]);
      expect(yield* hostRecords(world.state, readFindingStatuses(run.dir))).toEqual([]);
    }),
  ));

const cardOf = (world: { readonly state: string }, runId: string) =>
  Effect.gen(function* () {
    const client = yield* connect(world.state).pipe(Effect.orDie);
    const sent = yield* client.board().pipe(Stream.runHead, Effect.orDie);
    const board = yield* Option.match(sent, {
      onNone: () => Effect.die("the board sent nothing"),
      onSome: (one) => Effect.succeed(one),
    });
    const tasks = board._tag === "Snapshot" ? board.tasks : [];
    return yield* Option.match(
      Arr.findFirst(tasks, (one) => one.run === runId),
      {
        onNone: () => Effect.die(`no card for ${runId}`),
        onSome: (one) => Effect.succeed(`${one.landed}/${sectionOf(one)}`),
      },
    );
  });

test("a Run settled before the open count was a fact reports it, and the fact is there afterwards", () =>
  hosted("hw-findings-upgrade-", ({ world }) =>
    Effect.gen(function* () {
      const run = yield* settledRun(world, "leaves");
      yield* stopHost(world.state);
      yield* clearCount(world.state, run.id);
      expect(yield* countOf(world.state, run.id)).toBeNull();

      const client = yield* connect(world.state).pipe(Effect.orDie);
      yield* client.declare({ frontDoor: "board" });

      expect((yield* client.runFindings({ runId: run.id })).length).toBe(2);
      expect(yield* countOf(world.state, run.id)).toBe("2");
    }),
  ));

test("the CLI takes an offer over two findings, lists both taken, and a dismissal takes the card out of Waiting on you", () =>
  hosted(
    "hw-findings-select-",
    ({ world }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.copyFile(`${root}workflows/selected.ts`, `${world.user}/selected.ts`);
        const run = yield* settledRun(world, "submits");
        const env = envOf(world);
        const [first, second, third] = [`${run.id}-F1`, `${run.id}-F2`, `${run.id}-F3`];

        const listed = yield* cli(["--json", "run", "findings", run.id], env);
        expect(listed.exit).toBe(0);
        const listedData = yield* parseFindings((yield* parseEnvelope(listed.stdout)).data);
        const ids = Arr.map(listedData.findings, (one) => one.id);
        expect(ids).toEqual([first, second, third]);

        const card = cardOf(world, run.id);
        expect(yield* card).toBe("false/waiting");

        const chosen = yield* cli(
          [
            "--json",
            "run",
            "action",
            run.id,
            "implement-selected",
            "--input",
            `findings=${first}, ${second}`,
            "--request-id",
            "choose-two",
          ],
          env,
        );
        expect(chosen.exit).toBe(0);
        const taken = yield* cli(["--json", "run", "findings", run.id], env);
        const takenData = yield* parseFindings((yield* parseEnvelope(taken.stdout)).data);
        const rows = Arr.map(takenData.findings, (one) => [one.id, one.status, one.run] as const);
        expect(Arr.map(rows, ([id, status]) => [id, status])).toEqual([
          [first, "taken"],
          [second, "taken"],
          [third, "open"],
        ]);
        const child = rows[0]?.[2] ?? "";
        expect(child).not.toBe("");
        expect(rows[1]?.[2]).toBe(child);
        const shown = yield* cli(["--json", "run", "show", child], env);
        expect(shown.exit).toBe(0);
        expect(shown.stdout).toContain("implement");
        expect(yield* card).toBe("false/waiting");

        const dismissed = yield* cli(
          [
            "--json",
            "run",
            "finding",
            run.id,
            third,
            "--dismiss",
            "not worth it",
            "--request-id",
            "dismiss-third",
          ],
          env,
        );
        expect(dismissed.exit).toBe(0);
        expect(yield* card).toBe("true/finished");
      }),
    ["leaves.workflow.ts", "submits.workflow.ts", "implement.workflow.ts"],
  ));

test("the CLI's last dismissal is what takes the card out of Waiting on you", () =>
  hosted(
    "hw-findings-card-",
    ({ world }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.copyFile(`${root}workflows/selected.ts`, `${world.user}/selected.ts`);
        const run = yield* settledRun(world, "submits");
        const env = envOf(world);
        const ids = Arr.map([1, 2, 3], (one) => `${run.id}-F${one}`);

        expect(yield* cardOf(world, run.id)).toBe("false/waiting");
        const dismiss = (id: string, request: string) =>
          cli(
            [
              "--json",
              "run",
              "finding",
              run.id,
              id,
              "--dismiss",
              "by design",
              "--request-id",
              request,
            ],
            env,
          );
        expect((yield* dismiss(ids[0]!, "dismiss-1")).exit).toBe(0);
        expect(yield* cardOf(world, run.id)).toBe("false/waiting");
        expect((yield* dismiss(ids[1]!, "dismiss-2")).exit).toBe(0);
        expect(yield* cardOf(world, run.id)).toBe("false/waiting");
        expect((yield* dismiss(ids[2]!, "dismiss-3")).exit).toBe(0);
        expect(yield* cardOf(world, run.id)).toBe("true/finished");
      }),
    ["leaves.workflow.ts", "submits.workflow.ts", "implement.workflow.ts"],
  ));

test("the CLI lists a Run's findings and dismisses one, and run show says what it reads", () =>
  hosted("hw-findings-cli-", ({ world }) =>
    Effect.gen(function* () {
      const run = yield* settledRun(world, "leaves");
      const env = envOf(world);

      const listed = yield* cli(["--json", "run", "findings", run.id], env);
      expect(listed.exit).toBe(0);
      expect(yield* parseEnvelope(listed.stdout)).toMatchObject({
        ok: true,
        data: {
          findings: [
            { id: `${run.id}-F1`, status: "open" },
            { id: `${run.id}-F2`, status: "open" },
          ],
        },
      });

      const dismissed = yield* cli(
        [
          "--json",
          "run",
          "finding",
          run.id,
          `${run.id}-F1`,
          "--dismiss",
          "by design",
          "--request-id",
          "req-1",
        ],
        env,
      );
      expect(dismissed.exit).toBe(0);
      expect(yield* parseEnvelope(dismissed.stdout)).toMatchObject({
        ok: true,
        data: { finding: { id: `${run.id}-F1`, status: "dismissed", reason: "by design" } },
      });

      const shown = yield* cli(["run", "show", run.id], env);
      expect(shown.exit).toBe(0);
      expect(shown.stdout).toContain(`${run.id}-F1 dismissed`);
      expect(shown.stdout).toContain(`${run.id}-F2 open`);

      const blank = yield* cli(
        ["--json", "run", "finding", run.id, `${run.id}-F2`, "--dismiss", " "],
        env,
      );
      expect(blank.exit).toBe(2);
      expect(yield* parseEnvelope(blank.stdout)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });

      const reopened = yield* cli(
        ["--json", "run", "finding", run.id, `${run.id}-F1`, "--reopen"],
        env,
      );
      expect(reopened.exit).toBe(0);
      expect(yield* parseEnvelope(reopened.stdout)).toMatchObject({
        ok: true,
        data: { finding: { id: `${run.id}-F1`, status: "open" } },
      });
    }),
  ));
