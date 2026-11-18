import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import {
  Config,
  ConfigProvider,
  Effect,
  FileSystem,
  Option,
  Schema,
  Scope,
  flow,
  Result,
} from "effect";
import type { PlatformServices } from "../src/platform";
import { currentEnv } from "../src/env";
import { pickFlow, type FlowPrompts } from "../src/flows";
import { Herdr } from "../src/herdr";
import { connect } from "../src/host";
import { runViews } from "../src/lifecycle";
import { exec } from "./support/command";
import { runEffect, suiteEnv } from "./support/effect";
import { fixtures, root, stopHost, until } from "./support/host";

const Envelope = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Boolean,
    error: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String })),
  }),
);
const asEnvelope = Schema.decodeUnknownEffect(Envelope);

const asInputs = (given: Readonly<Record<string, string>>) =>
  Arr.flatMap(Rec.toEntries(given), ([name, value]) => ["--input", `${name}=${value}`]);

const collie = Effect.fn("TypedTest.collie")(function* (world: World, args: ReadonlyArray<string>) {
  const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
  const command = Option.isSome(binary) ? [binary.value] : [process.execPath, `${root}src/main.ts`];
  const child = Bun.spawn([...command, "--json", ...args], {
    cwd: world.project,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: world.project,
      COLLIE_ROOT: world.install,
      COLLIE_STATE_DIR: world.state,
      COLLIE_USER_DIR: `${world.install}/user`,
      COLLIE_CWD: world.project,
      COLLIE_HOST: asCommand(command),
      ...(yield* suiteEnv),
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

const MODULE = ["typed.workflow.ts", "targeted.workflow.ts"] as const;

const asCommand = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Array(Schema.String))),
  Result.getOrThrow,
);

interface World {
  readonly install: string;
  readonly user: string;
  readonly state: string;
  readonly project: string;
}

const proves = <A, E>(
  prefix: string,
  body: (world: World) => Effect.Effect<A, E, PlatformServices | Scope.Scope>,
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
      yield* exec(["git", "init", "-q"], { cwd: world.project });
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
              COLLIE_ROOT: world.install,
              COLLIE_STATE_DIR: world.state,
              COLLIE_USER_DIR: `${world.install}/user`,
              COLLIE_CWD: world.project,
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

const said = (
  given: {
    readonly text?: Readonly<Record<string, string>>;
    readonly json?: Readonly<Record<string, Schema.Json>>;
  },
  request = "req-1",
) => ({ id: "typed", request, input: given.json ?? {}, text: given.text ?? {} });

test(
  "text is settled by the field's own schema, so code is handed typed values",
  () =>
    proves("collie-typed-text-", (world) =>
      Effect.gen(function* () {
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const started = yield* client
          .start({
            project: world.project,
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
        expect(yield* client.runs({ task: null }).pipe(Effect.orDie)).toEqual([]);
        yield* stopHost(world.state);
      }),
    ),
  120_000,
);

test(
  "a pasted merge request URL is handed over as mr:, and a target of no known shape starts nothing",
  () =>
    proves("collie-typed-target-", (world) =>
      Effect.gen(function* () {
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const url = "https://gitlab.example.com/acme/app/-/merge_requests/42";
        const started = yield* client
          .start({
            project: world.project,
            id: "targeted",
            request: "req-url",
            input: {},
            text: { target: url },
          })
          .pipe(Effect.orDie);
        const done = yield* until(
          () => client.status({ runId: started.runId }),
          (status) => status.status === "complete" || status.status === "failed",
        );
        expect(done).toEqual({ status: "complete", value: "mr:gitlab.example.com/acme/app!42" });

        const refused = yield* client
          .start({
            project: world.project,
            id: "targeted",
            request: "req-word",
            input: {},
            text: { target: "fix-the-parser" },
          })
          .pipe(Effect.flip, Effect.orDie);
        expect(refused.reason).toStartWith("invalid_input:");
        expect(refused.reason).toContain("target");
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
        const typed = Option.getOrUndefined(
          Arr.findFirst(found.entries, (entry) => entry.id === "typed"),
        );

        expect(
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(typed), (present) =>
              Arr.map(present.inputs, (field) => field.name).sort(),
            ),
          ),
        ).toEqual(["count", "draft", "labels", "mode", "note", "ref", "spec", "ticket"]);
        const mode = Option.getOrUndefined(
          Option.map(Option.fromNullishOr(typed), (present_) =>
            Option.getOrUndefined(Arr.findFirst(present_.inputs, (field) => field.name === "mode")),
          ),
        );
        expect(mode?.schema).toMatchObject({ enum: ["fast", "thorough"] });
        expect(mode?.required).toBe(true);
        expect(
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(typed), (present__) =>
              Option.getOrUndefined(
                Arr.findFirst(present__.inputs, (field) => field.name === "spec"),
              ),
            ),
          ),
        ).toMatchObject({
          required: false,
          strategy: "work-source",
        });
        yield* stopHost(world.state);
      }),
    ),
  120_000,
);

const answering = (script: ReadonlyArray<string>) => {
  const answers = [...script];
  const asked: Array<string> = [];
  const prompts: FlowPrompts = {
    menu: (items, options) => {
      asked.push(options.header);
      const wanted = answers.shift();
      return Effect.succeed(
        Option.getOrUndefined(Arr.findFirst(items, (item) => item.id === wanted)) ?? null,
      );
    },
    ask: (question) => {
      asked.push(question);
      return Effect.succeed(answers.shift() ?? null);
    },
  };
  return { prompts, asked };
};

test(
  "the command line settles typed values, and the picker refuses what it cannot infer",
  () =>
    proves("collie-typed-doors-", (world) =>
      Effect.gen(function* () {
        const env = yield* currentEnv;
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
            spec: "",
          }),
        ]);
        expect(bad.exit).toBe(2);
        expect(bad.envelope.error?.code).toBe("invalid_input");
        expect(bad.envelope.error?.message).toContain("count");
        expect((yield* runViews(env, null)).runs).toEqual([]);

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
            spec: "",
          }),
        ]);
        expect(started.exit).toBe(0);

        const { prompts, asked } = answering(["typed", "the spec"]);
        expect(yield* pickFlow(new Herdr(env), env, prompts)).toBe(0);
        expect(asked.slice(1, 2)).toEqual(["What do you want?"]);
        expect(asked.at(-1)).toContain('typed needs "note"');

        const listed = (yield* runViews(env, null)).runs;
        expect(Arr.map(listed, (run) => run.input.count)).toEqual([2]);
        expect(Arr.every(listed, (run) => run.workflow === "typed")).toBe(true);
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
        expect(asked.envelope.error?.message).toContain("count");
        expect((yield* runViews(yield* currentEnv, null)).runs).toEqual([]);
        yield* stopHost(world.state);
      }),
    ),
  120_000,
);
