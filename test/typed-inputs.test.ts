// What a caller types, and what the workflow is handed.
//
// A module declares its inputs as schemas, so `--input count=3` is a number by the time
// the workflow reads it and `--input count=many` is a refusal before anything exists. The
// rules are the spec's: text is tried as text first and as JSON only where the schema
// will not take the text, `--inputs-json` is typed and settles a tie, missing is absent
// rather than empty, and false, zero, an empty list and null all survive.
//
// Driven through the host, because the schema that settles a value is the author's and
// lives where their module was loaded.

import { expect, test } from "bun:test";
import { Config, ConfigProvider, Effect, FileSystem, Option, Schema, Scope } from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { currentEnv } from "../src/env";
import { pickFlow, type FlowPrompts } from "../src/flows";
import { Herdr } from "../src/herdr";
import { connect } from "../src/host";
import { nativeRuns } from "../src/lifecycle";
import { runEffect } from "./support/effect";
import { fixtures, root, stopHost, until } from "./support/native";

const Envelope = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Boolean,
    error: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String })),
  }),
);
const asEnvelope = Schema.decodeUnknownEffect(Envelope);

/** `--input k=v` for each, which is the only shape a command line has for a value. */
const asInputs = (given: Readonly<Record<string, string>>) =>
  Object.entries(given).flatMap(([name, value]) => ["--input", `${name}=${value}`]);

/** The command itself, run as an operator runs it: another process, one JSON envelope. */
const collie = Effect.fn("TypedTest.collie")(function* (world: World, args: ReadonlyArray<string>) {
  const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
  const command = Option.isSome(binary) ? [binary.value] : [process.execPath, `${root}src/main.ts`];
  const child = Bun.spawn([...command, "--json", ...args], {
    cwd: world.project,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: world.project,
      HERDR_PLUGIN_ROOT: world.install,
      HERDR_PLUGIN_STATE_DIR: world.state,
      HERDR_PLUGIN_CONFIG_DIR: `${world.state}/config`,
      COLLIE_CWD: world.project,
      COLLIE_HOST: asCommand(command),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exit] = yield* Effect.promise(() =>
    Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]),
  );
  return { exit, envelope: yield* asEnvelope(stdout).pipe(Effect.orDie) };
});

const MODULE = ["typed.workflow.ts"] as const;

const asCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

interface World {
  readonly install: string;
  readonly user: string;
  readonly state: string;
  readonly project: string;
}

/** An installation with the typed module saved in it, and a host for the project. */
const proves = <A, E>(
  prefix: string,
  body: (world: World) => Effect.Effect<A, E, BunServices | Scope.Scope>,
) =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix });
      const world: World = {
        install: `${dir}/install`,
        user: `${dir}/install/user/workflows`,
        state: `${dir}/state`,
        project: `${dir}/project`,
      };
      for (const made of [world.user, `${world.install}/workflows`, world.state, world.project]) {
        yield* fs.makeDirectory(made, { recursive: true }).pipe(Effect.orDie);
      }
      for (const name of MODULE) {
        yield* fs.copyFile(`${fixtures}/${name}`, `${world.user}/${name}`).pipe(Effect.orDie);
      }
      const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
      const command = Option.isSome(binary)
        ? [binary.value]
        : [process.execPath, `${root}src/main.ts`];
      return yield* body(world).pipe(
        Effect.scoped,
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              COLLIE_HOST: asCommand(command),
              HERDR_PLUGIN_ROOT: world.install,
              HERDR_PLUGIN_STATE_DIR: world.state,
              COLLIE_CWD: world.project,
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

/** Everything a caller may say, with the halves a front door keeps apart. */
const said = (
  given: {
    readonly text?: Readonly<Record<string, string>>;
    readonly json?: Readonly<Record<string, Schema.Json>>;
  },
  request = "req-1",
) => ({ id: "typed", request, input: given.json ?? {}, text: given.text ?? {} });

test(
  "text is settled by the field's own schema, so code is handed native values",
  () =>
    proves("collie-typed-text-", (world) =>
      Effect.gen(function* () {
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const started = yield* client
          .start({
            project: world.project,
            // Every one of these is text a human typed; none of them is a string.
            ...said({
              text: {
                note: "hello",
                count: "3",
                draft: "false",
                labels: '["one","two"]',
                ticket: "null",
                mode: "thorough",
                ref: "12",
              },
            }),
          })
          .pipe(Effect.orDie);

        const done = yield* until(
          () => client.status({ runId: started.runId }),
          (status) => status.status === "complete" || status.status === "failed",
        );
        expect(done).toEqual({
          status: "complete",
          // `count` and `draft` are what the text spells, because a number and a boolean
          // will not take text. `labels` is the JSON the text spells, for the same reason.
          // `ref` is a string-or-number union and `ticket` a nullable string, and both are
          // text, because text is tried first — `--inputs-json` is how a caller says
          // otherwise, which the next case does.
          value:
            "count=number:3 draft=boolean:false labels=2:[one|two] ticket=string:null " +
            "mode=thorough ref=string:12 spec=absent",
        });
        yield* stopHost(world.state);
      }),
    ),
  120_000,
);

test(
  "typed JSON keeps false, zero, an empty list and null, and settles what text cannot",
  () =>
    proves("collie-typed-json-", (world) =>
      Effect.gen(function* () {
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const started = yield* client
          .start({
            project: world.project,
            ...said({
              json: {
                note: "",
                count: 0,
                draft: false,
                labels: [],
                ticket: null,
                mode: "fast",
                // The same text as the other case, typed: a number, not the string.
                ref: 12,
              },
            }),
          })
          .pipe(Effect.orDie);

        const done = yield* until(
          () => client.status({ runId: started.runId }),
          (status) => status.status === "complete" || status.status === "failed",
        );
        expect(done).toEqual({
          status: "complete",
          value:
            "count=number:0 draft=boolean:false labels=0:[] ticket=null mode=fast " +
            "ref=number:12 spec=absent",
        });
        yield* stopHost(world.state);
      }),
    ),
  120_000,
);

test(
  "a value the field's schema will not take names the field, and starts nothing",
  () =>
    proves("collie-typed-refused-", (world) =>
      Effect.gen(function* () {
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const refused = yield* client
          .start({
            project: world.project,
            ...said({ text: { note: "x", count: "many", draft: "false", mode: "fast" } }),
          })
          .pipe(Effect.flip, Effect.orDie);

        expect(refused._tag).toBe("HostRefused");
        expect(refused.reason).toStartWith("invalid_input:");
        expect(refused.reason).toContain("count");
        // Nothing was admitted, so there is no run to clean up.
        expect(yield* client.runs({ task: null }).pipe(Effect.orDie)).toEqual([]);
        yield* stopHost(world.state);
      }),
    ),
  120_000,
);

test(
  "an input the module does not declare is refused rather than passed through",
  () =>
    proves("collie-typed-undeclared-", (world) =>
      Effect.gen(function* () {
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const refused = yield* client
          .start({
            project: world.project,
            ...said({
              text: { note: "x", count: "1", draft: "true", mode: "fast", ref: "a", nope: "1" },
            }),
          })
          .pipe(Effect.flip, Effect.orDie);

        expect(refused.reason).toContain("nope");
        expect(yield* client.runs({ task: null }).pipe(Effect.orDie)).toEqual([]);
        yield* stopHost(world.state);
      }),
    ),
  120_000,
);

test(
  "a required input nobody gave names itself, and a missing optional one stays missing",
  () =>
    proves("collie-typed-missing-", (world) =>
      Effect.gen(function* () {
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const refused = yield* client
          .start({ project: world.project, ...said({ text: { note: "x" } }) })
          .pipe(Effect.flip, Effect.orDie);

        expect(refused.reason).toContain("count");
        yield* stopHost(world.state);
      }),
    ),
  120_000,
);

test(
  "the row keeps what the schema settled and where each value came from",
  () =>
    proves("collie-typed-stored-", (world) =>
      Effect.gen(function* () {
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const started = yield* client
          .start({
            project: world.project,
            ...said({
              text: { note: "kept", count: "7", draft: "true", mode: "fast", ref: "r" },
              json: { labels: ["one"], ticket: null },
            }),
          })
          .pipe(Effect.orDie);

        const view = yield* client.run({ runId: started.runId }).pipe(Effect.orDie);
        // Encoded, not the text: `7` is a number in the row as it is in the workflow.
        expect(view?.input).toEqual({
          note: "kept",
          count: 7,
          draft: true,
          mode: "fast",
          ref: "r",
          labels: ["one"],
          ticket: null,
        });
        expect(view?.provenance).toEqual({
          note: "typed",
          count: "typed",
          draft: "typed",
          mode: "typed",
          ref: "typed",
          labels: "given",
          ticket: "given",
        });
        yield* stopHost(world.state);
      }),
    ),
  120_000,
);

test(
  "an outcome the module fixes cannot be asked for as something else",
  () =>
    proves("collie-typed-outcome-", (world) =>
      Effect.gen(function* () {
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const refused = yield* client
          .start({
            project: world.project,
            ...said({ text: { note: "x", count: "1", draft: "true", mode: "fast", ref: "a" } }),
            options: { outcome: "bug" },
          })
          .pipe(Effect.flip, Effect.orDie);

        expect(refused.reason).toContain("feature");
        expect(yield* client.runs({ task: null }).pipe(Effect.orDie)).toEqual([]);
        yield* stopHost(world.state);
      }),
    ),
  120_000,
);

test(
  "what a module declares reaches a front door: its fields, their schemas and its hints",
  () =>
    proves("collie-typed-declared-", (world) =>
      Effect.gen(function* () {
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const found = yield* client.discover({ project: world.project }).pipe(Effect.orDie);
        const typed = found.entries.find((entry) => entry.id === "typed");

        expect(typed?.inputs.map((field) => field.name).sort()).toEqual([
          "count",
          "draft",
          "labels",
          "mode",
          "note",
          "ref",
          "spec",
          "ticket",
        ]);
        const mode = typed?.inputs.find((field) => field.name === "mode");
        // A closed set draws as one, which is what lets a picker offer a menu for it.
        expect(mode?.schema).toMatchObject({ enum: ["fast", "thorough"] });
        expect(mode?.required).toBe(true);
        expect(typed?.inputs.find((field) => field.name === "spec")).toMatchObject({
          required: false,
          strategy: "work-source",
        });
        yield* stopHost(world.state);
      }),
    ),
  120_000,
);

/** The human at the picker, as a script: each question answered in the order it is asked. */
const answering = (script: ReadonlyArray<string>) => {
  const answers = [...script];
  const asked: Array<string> = [];
  const prompts: FlowPrompts = {
    menu: (items, options) => {
      asked.push(options.header);
      const wanted = answers.shift();
      return Effect.succeed(items.find((item) => item.id === wanted) ?? null);
    },
    ask: (question) => {
      asked.push(question);
      return Effect.succeed(answers.shift() ?? null);
    },
  };
  return { prompts, asked };
};

test(
  "the command line and the picker settle the same values and refuse the same way",
  () =>
    proves("collie-typed-doors-", (world) =>
      Effect.gen(function* () {
        const env = yield* currentEnv;
        // The command line, with a value the schema will not take: exit 2, the field
        // named, and no Run behind it.
        const bad = yield* collie(world, [
          "run",
          "start",
          "typed",
          ...asInputs({
            note: "x",
            count: "many",
            draft: "true",
            labels: "[]",
            ticket: "ENG-1",
            mode: "fast",
            ref: "a",
          }),
        ]);
        expect(bad.exit).toBe(2);
        expect(bad.envelope.error?.code).toBe("invalid_input");
        expect(bad.envelope.error?.message).toContain("count");
        expect((yield* nativeRuns(env, null)).runs).toEqual([]);

        // The same launch, corrected. Every value is text on the command line, and the
        // module is handed the types it declared.
        const started = yield* collie(world, [
          "run",
          "start",
          "typed",
          ...asInputs({
            note: "x",
            count: "2",
            draft: "true",
            labels: "[]",
            ticket: "ENG-1",
            mode: "fast",
            ref: "7",
          }),
        ]);
        expect(started.exit).toBe(0);

        // The picker, asked for the same module: a closed set is offered as a menu rather
        // than typed, and it lands on the same host as the command line's.
        const { prompts, asked } = answering([
          "typed",
          "y",
          "4",
          "true",
          "[]",
          "ENG-2",
          "thorough",
          "8",
          // `spec` is optional and its work-source strategy found nothing here, so it is
          // asked for and declined — and stays absent rather than becoming empty.
          "",
        ]);
        expect(yield* pickFlow(new Herdr(env), env, prompts, "inline")).toBe(0);
        // `mode` is a closed set, so its question is a menu of the values it takes.
        expect(asked).toContain("A workflow with typed inputs — mode");

        const listed = (yield* nativeRuns(env, null)).runs;
        expect(listed).toHaveLength(2);
        expect(
          listed.map((run) => run.input.count).sort((one, other) => Number(one) - Number(other)),
        ).toEqual([2, 4]);
        expect(listed.every((run) => run.workflow === "typed")).toBe(true);
        yield* stopHost(world.state);
      }),
    ),
  240_000,
);

test(
  "an input the module needs and nobody gave comes back as the question to answer",
  () =>
    proves("collie-typed-needs-", (world) =>
      Effect.gen(function* () {
        const asked = yield* collie(world, ["run", "start", "typed", "--input", "note=x"]);

        expect(asked.exit).toBe(2);
        expect(asked.envelope.error?.code).toBe("needs_input");
        // Every one it is missing, with what each will take, so a caller that has never
        // seen the module can fill them in and retry under the same request id.
        expect(asked.envelope.error?.message).toContain("count");
        expect((yield* nativeRuns(yield* currentEnv, null)).runs).toEqual([]);
        yield* stopHost(world.state);
      }),
    ),
  120_000,
);
