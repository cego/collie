// Saving a workflow, checking it, and reading back what it takes.
//
// One projection answers every front door, so the questions here are about that reading:
// does it say what a launch will hold the author to, does a drawing that says less than
// the schema read as a limit rather than a fault, and does a module that will not compile
// say so without a Run, an agent or a worktree. Writing is the same file the reading finds.

import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { checkModule, createEntry, describeModule, forkEntry } from "../src/authoring";
import { discover, searchPath, type EntryLayer } from "../src/discovery";
import {
  TOOLCHAIN,
  loadEntry,
  provisionToolchain,
  revisionOf,
  stageGeneration,
  clearGenerations,
  typecheckEntry,
} from "../src/engine";
import { runEffect } from "./support/effect";
import { stopHost } from "./support/host";
import { collie, proves as provesWith } from "./support/world";

const fixtures = new URL("./fixtures/workflows/", import.meta.url).pathname;

/** The three layers, empty, with the fixtures on hand to copy into them. */
const layers = Effect.fn("AuthoringTest.layers")(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix });
  const roots = searchPath({ pluginRoot: `${dir}/install`, project: `${dir}/project` });
  for (const root of roots) yield* fs.makeDirectory(root.dir, { recursive: true });
  const dirOf = (layer: EntryLayer) => roots.find((root) => root.layer === layer)!.dir;
  return {
    roots,
    dirOf,
    copy: (layer: EntryLayer, name: string) =>
      fs
        .copyFile(`${fixtures}${name}`, `${dirOf(layer)}/${name}`)
        .pipe(Effect.as(`${dirOf(layer)}/${name}`)),
  };
});

test("a module is read as its public id, where it came from, and the shapes on both ends", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* layers("collie-authoring-describe-");
      const path = yield* where.copy("user", "echo.workflow.ts");

      const described = describeModule(yield* loadEntry(path), { layer: "user", path });

      expect(described.id).toBe("echo");
      expect(described.layer).toBe("user");
      expect(described.path).toBe(path);
      expect(described.broken).toBeNull();
      // What a caller may put in, drawn from the author's own schemas.
      expect(described.inputs.map((one) => [one.name, one.required, one.strategy])).toEqual([
        ["text", true, "work-source"],
        ["times", true, null],
      ]);
      expect(described.inputs[0]?.schema).toMatchObject({ type: "string" });
      // Both ends of the workflow, not only the way in.
      expect(described.success.schema).toMatchObject({ type: "string" });
      expect(described.error.schema).toMatchObject({ $defs: { WorkflowErrorEncoded: {} } });
      // What the host settles beside the payload, so a caller knows the names it may use.
      expect(described.options.map((one) => one.name)).toContain("branch");
      // The domain metadata, as data rather than as the author's closures.
      expect(described.metadata).toMatchObject({
        hints: { text: "work-source" },
        selectable: ["feature", "docs"],
      });
    }).pipe(Effect.scoped),
  ));

test("a module that will not construct says so rather than reading as a workflow with no result", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const where = yield* layers("collie-authoring-broken-");
      const path = `${where.dirOf("user")}/cross.workflow.ts`;
      yield* fs.writeFileString(
        path,
        [
          `export const id = "cross";`,
          `export const title = "A module whose make throws";`,
          `export const description = "Constructed, not run.";`,
          `export const input = {};`,
          `export const make = () => { throw new Error("no layer here"); };`,
        ].join("\n"),
      );

      const described = describeModule(yield* loadEntry(path), { layer: "user", path });

      expect(described.broken).toContain("no layer here");
      expect(described.success.schema).toBeNull();
    }).pipe(Effect.scoped),
  ));

test("checking reads the module and the compiler, and keeps the three answers apart", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* layers("collie-authoring-check-");
      const good = yield* where.copy("user", "plain.workflow.ts");
      const conflicted = yield* where.copy("user", "conflicted.workflow.ts");

      // Nothing was installed to check with, so nothing is reported as checked — and
      // that is said rather than left to read as a clean module.
      const unchecked = yield* checkModule({ layer: "user", path: good });
      expect(unchecked.problems).toEqual([]);
      expect(unchecked.toolchain).toContain("no typechecker");

      // A module that contradicts itself is refused at load, with no compiler involved.
      const refused = yield* checkModule({ layer: "user", path: conflicted });
      expect(refused.problems.join(" ")).toContain("outcome");
      expect(refused.id).toBe("conflicted");
    }).pipe(Effect.scoped),
  ));

test(
  "the authoring setup is merged into an author's own package and compiler settings",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-authoring-merge-" });
        yield* fs.writeFileString(
          `${dir}/package.json`,
          '{"name":"mine","dependencies":{"zod":"^3.0.0"},"scripts":{"x":"y"}}',
        );
        yield* fs.writeFileString(
          `${dir}/tsconfig.json`,
          '{"compilerOptions":{"strict":false,"paths":{"~/*":["./src/*"]}}}',
        );
        // Installing may need a network this machine lacks; what is merged is written first.
        yield* provisionToolchain(dir).pipe(Effect.result);

        const pkg = yield* fs.readFileString(`${dir}/package.json`);
        expect(pkg).toContain('"zod": "^3.0.0"');
        expect(pkg).toContain('"scripts"');
        expect(pkg).toContain(`"effect": "${TOOLCHAIN.effect}"`);
        expect(pkg).toContain(`"typescript": "${TOOLCHAIN.typescript}"`);
        const tsconfig = yield* fs.readFileString(`${dir}/tsconfig.json`);
        expect(tsconfig).toContain('"strict": false');
        expect(tsconfig).toContain('"~/*"');
        expect(tsconfig).toContain('"collie": [');
        expect(yield* fs.exists(`${dir}/collie.d.ts`)).toBe(true);
      }).pipe(Effect.scoped),
    ),
  60_000,
);

test("a typechecker that falls over is no typechecker, not a clean module", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-authoring-crash-" });
      yield* fs.makeDirectory(`${dir}/node_modules/typescript/lib`, { recursive: true });
      yield* fs.writeFileString(
        `${dir}/node_modules/typescript/lib/tsc.js`,
        'console.error("could not initialise"); process.exit(99);\n',
      );
      yield* fs.writeFileString(`${dir}/tsconfig.json`, "{}");
      yield* fs.writeFileString(`${dir}/plain.workflow.ts`, "export const id = 1;\n");
      const checked = yield* typecheckEntry({ dir, file: `${dir}/plain.workflow.ts` }).pipe(
        Effect.flip,
      );
      expect(checked.code).toBe("toolchain_unavailable");
      expect(checked.message).toContain("could not initialise");
    }).pipe(Effect.scoped),
  ));

test("creating writes a module the search path finds, and never over one already there", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* layers("collie-authoring-create-");

      const made = yield* createEntry({ dir: where.dirOf("user"), id: "tally" });
      expect(made.ok).toBe(true);
      expect(made.path).toBe(`${where.dirOf("user")}/tally.workflow.ts`);

      const found = yield* discover(where.roots);
      expect(found.problems).toEqual([]);
      expect(found.entries.map((one) => [one.id, one.layer])).toEqual([["tally", "user"]]);

      const again = yield* createEntry({ dir: where.dirOf("user"), id: "tally" });
      expect(again.ok).toBe(false);
      expect(again.message).toContain("already exists");
    }).pipe(Effect.scoped),
  ));

test(
  "a fork is a file that imports what it keeps, and claims its own id",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const where = yield* layers("collie-authoring-fork-");
        const parent = yield* where.copy("shipped", "echo.workflow.ts");

        const forked = yield* forkEntry({
          dir: where.dirOf("user"),
          id: "echo-mine",
          from: { path: parent, entry: yield* loadEntry(parent) },
        });
        expect(forked.ok).toBe(true);

        const text = yield* fs.readFileString(forked.path);
        expect(text).toContain(`from "../../workflows/echo.workflow.ts"`);

        // Both are found, each under its own id, and the fork takes the parent's inputs.
        const found = yield* discover(where.roots);
        expect(found.problems).toEqual([]);
        expect(found.entries.map((one) => [one.id, one.layer])).toEqual([
          ["echo", "shipped"],
          ["echo-mine", "user"],
        ]);
        const mine = found.entries.find((one) => one.id === "echo-mine")!;
        expect(mine.inputs.map((one) => one.name)).toEqual(["text", "times"]);

        // A host runs a staged copy, and the parent the fork climbs out to is still found.
        const staged = yield* stageGeneration({
          dir: `${where.dirOf("user")}/../state`,
          name: "echo-mine@1",
          entry: forked.path,
        });
        expect((yield* loadEntry(staged)).id).toBe("echo-mine");
      }).pipe(Effect.scoped),
    ),
  60_000,
);

test("a helper outside a module's directory is part of its revision, and each generation loads it as it is", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-outside-" });
      yield* fs.makeDirectory(`${root}/mod`);
      yield* fs.makeDirectory(`${root}/shared`);
      const entry = `${root}/mod/entry.ts`;
      yield* fs.writeFileString(
        entry,
        [
          `import { n } from "../shared/helper";`,
          `export const value = n;`,
          `export const said = "../shared/helper";`,
        ].join("\n"),
      );
      const helper = (n: number) =>
        fs.writeFileString(`${root}/shared/helper.ts`, `export const n = ${n};\n`);
      const staged = Effect.fn(function* () {
        const revision = yield* revisionOf(`${root}/mod`);
        const file = yield* stageGeneration({
          dir: `${root}/state`,
          name: `mod@${revision}`,
          entry,
        });
        return { revision, module: yield* Effect.promise(() => import(file)) };
      });

      yield* helper(1);
      const first = yield* staged();
      expect(first.module.value).toBe(1);
      // A string that reads like the import is a value, not a path to anchor.
      expect(first.module.said).toBe("../shared/helper");

      yield* helper(2);
      const second = yield* staged();
      expect(second.revision).not.toBe(first.revision);
      expect(second.module.value).toBe(2);
    }).pipe(Effect.scoped),
  ));

test("a staged helper finds the packages installed where its author wrote it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-packages-" });
      const install = Effect.fn(function* (at: string, name: string) {
        yield* fs.makeDirectory(`${at}/node_modules/${name}`, { recursive: true });
        yield* fs.writeFileString(
          `${at}/node_modules/${name}/package.json`,
          `{"name":"${name}","main":"index.js"}`,
        );
        yield* fs.writeFileString(
          `${at}/node_modules/${name}/index.js`,
          `export const from = "${name}";\n`,
        );
      });
      yield* install(`${root}/project`, "collie-probe-above");
      yield* install(`${root}/project/shared`, "collie-probe-beside");
      yield* fs.makeDirectory(`${root}/project/mod`);
      yield* fs.writeFileString(
        `${root}/project/shared/helper.ts`,
        [
          `import { from as above } from "collie-probe-above";`,
          `import { from as beside } from "collie-probe-beside";`,
          `export const both = [above, beside];`,
        ].join("\n"),
      );
      const entry = `${root}/project/mod/entry.ts`;
      yield* fs.writeFileString(entry, `export { both } from "../shared/helper";\n`);

      const file = yield* stageGeneration({ dir: `${root}/state`, name: "mod@1", entry });
      const staged = yield* Effect.promise(() => import(file));
      expect(staged.both).toEqual(["collie-probe-above", "collie-probe-beside"]);
      // A generation links the author's packages, and wiping it leaves them where they are.
      yield* clearGenerations(`${root}/state`);
      expect(yield* fs.exists(`${root}/project/node_modules/collie-probe-above/index.js`)).toBe(
        true,
      );
    }).pipe(Effect.scoped),
  ));

/** What `workflow check` and `workflow list` carry, as far as these read them. */
const Reported = Schema.Struct({
  workflows: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      layer: Schema.String,
      problems: Schema.Array(Schema.String),
      toolchain: Schema.NullOr(Schema.String),
    }),
  ),
});
const reportedIn = (envelope: { readonly data?: unknown }) =>
  Schema.decodeUnknownEffect(Reported)(envelope.data).pipe(Effect.orDie);

/** `workflow show` for a module, as far as the refusal has to agree with it. */
const Shown = Schema.Struct({
  workflow: Schema.Struct({
    title: Schema.String,
    path: Schema.String,
    inputs: Schema.Array(Schema.Struct({ name: Schema.String, schema: Schema.Json })),
  }),
});
const shownIn = (envelope: { readonly data?: unknown }) =>
  Schema.decodeUnknownEffect(Shown)(envelope.data).pipe(Effect.orDie);

const Started = Schema.Struct({
  runId: Schema.optional(Schema.String),
  run: Schema.optional(Schema.Struct({ status: Schema.Unknown })),
});
const startedIn = (envelope: { readonly data?: unknown }) =>
  Schema.decodeUnknownEffect(Started)(envelope.data).pipe(Effect.orDie);

test(
  "an installation with no workflows writes one, checks it, finds it and runs it",
  () =>
    provesWith(
      "collie-authoring-loop-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;

          const made = yield* collie(world, ["workflow", "create", "tally", "--request-id", "r1"]);
          expect(made.envelope).toMatchObject({
            ok: true,
            data: { path: `${world.user}/tally.workflow.ts`, toolchain: null },
          });

          // It compiles against the declarations that were provisioned beside it, with
          // nothing on PATH but the system's own binaries.
          const checked = yield* collie(world, ["workflow", "check", "tally"]);
          expect(checked.exit).toBe(0);
          expect((yield* reportedIn(checked.envelope)).workflows).toEqual([
            { id: "tally", layer: "user", problems: [], toolchain: null },
          ]);

          // An entry beside it that will not load costs that id and no other.
          yield* fs.writeFileString(`${world.user}/half.workflow.ts`, "export const id =\n");
          const both = yield* collie(world, ["workflow", "check"]);
          expect(both.exit).not.toBe(0);
          const report = both.envelope.error?.message ?? "";
          expect(report).toContain("half\tuser\t1 problem(s)");
          expect(report).toContain("tally\tuser\tok");

          // What a launch refuses for is the same reading `show` answers with: same file,
          // same schema, so a caller that has never seen the module can still answer it.
          const shown = yield* collie(world, ["workflow", "show", "tally"]);
          const wanted = (yield* shownIn(shown.envelope)).workflow;
          const short = yield* collie(world, ["run", "start", "tally", "--request-id", "r0"]);
          expect(short.envelope.error?.code).toBe("needs_input");
          expect(short.envelope.error?.details).toEqual({
            workflow: "tally",
            path: wanted.path,
            inputs: [
              {
                name: "note",
                question: `${wanted.title} — note?`,
                schema: wanted.inputs[0]!.schema,
                limits: [],
              },
            ],
            requestId: "r0",
          });

          // Saving the file was the whole of it: nothing was registered, rebuilt or
          // restarted between writing it and running it.
          const started = yield* collie(world, [
            "run",
            "start",
            "tally",
            "--input",
            "note=hello",
            "--request-id",
            "r2",
          ]);
          expect(started.envelope.ok).toBe(true);
          const runId = (yield* startedIn(started.envelope)).runId ?? "";
          const finished = yield* collie(world, ["run", "wait", runId]);
          expect((yield* startedIn(finished.envelope)).run?.status).toEqual({
            status: "complete",
            value: "hello",
          });
          yield* stopHost(world.state);
        }),
      [],
    ),
  300_000,
);
