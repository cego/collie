// A Run's log, diff or report read by line range or searched, a page at a time that says
// whether it is the whole and where the next one starts.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Result, Schema, flow } from "effect";
import { foundationLayer, runDir } from "../src/engine";
import { forgeHttpLayer } from "../src/forge/http";
import { fetchRef } from "../src/run-detail";
import { Store } from "../src/store";
import { linesOf, wholeText } from "../src/text-lines";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { madeRun } from "./support/records";
import { collie, proves } from "./support/world";

const Lines = Schema.Struct({
  ref: Schema.String,
  total: Schema.Int,
  from: Schema.Int,
  to: Schema.Int,
  lines: Schema.Array(
    Schema.Struct({
      line: Schema.Int,
      text: Schema.String,
      before: Schema.optional(Schema.NullOr(Schema.String)),
      after: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  complete: Schema.Boolean,
  next: Schema.NullOr(Schema.Int),
});
const ToolText = Schema.Struct({ text: Schema.String });
const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
const fromTool = (envelope: { readonly data?: unknown }) =>
  Schema.decodeUnknownEffect(ToolText)(envelope.data).pipe(
    Effect.flatMap(({ text }) => Schema.decodeEffect(Schema.fromJsonString(Lines))(text)),
    Effect.orDie,
  );

test(
  "a ranged read of a Run's log answers exactly those lines, its total and where the next range starts",
  () =>
    proves(
      "collie-run-read-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* Effect.gen(function* () {
            yield* (yield* Store).admit({
              request: "logged",
              run: "logged",
              workflow: "proof",
              project: world.project,
              input: {},
              provenance: {},
              options: {},
              generation: "proof-1",
              execution: "logged",
              task: null,
              parent: null,
            });
          }).pipe(
            Effect.provide(foundationLayer({ dir: world.state })),
            Effect.scoped,
            Effect.orDie,
          );
          yield* fs.makeDirectory(runDir(world.state, "logged"), { recursive: true });
          yield* fs.writeFileString(
            `${runDir(world.state, "logged")}/log.txt`,
            Arr.join(
              Arr.makeBy(2000, (i) => `line ${i + 1}`),
              "\n",
            ) + "\n",
          );
          const wanted = Arr.makeBy(100, (i) => ({ line: 100 + i, text: `line ${100 + i}` }));
          const range = { run: "logged", ref: "log", start: 100, count: 100 };

          for (const tool of ["collie_run", "collie_artefacts"]) {
            const input = encode(range);
            const said = yield* collie(world, ["tools", "call", tool, "--input", input]);
            const page = yield* fromTool(said.envelope);
            expect({ tool, page }).toEqual({
              tool,
              page: {
                ref: "log",
                total: 2000,
                from: 100,
                to: 199,
                lines: wanted,
                complete: false,
                next: 200,
              },
            });
          }

          const cli = yield* collie(world, [
            "run",
            "read",
            "logged",
            "log",
            "--start",
            "1901",
            "--count",
            "200",
          ]);
          const last = yield* Schema.decodeUnknownEffect(Lines)(cli.envelope.data);
          expect([last.from, last.to, last.lines.length, last.complete, last.next]).toEqual([
            1901,
            2000,
            100,
            true,
            null,
          ]);
        }),
      [],
    ),
  120_000,
);

test("a search of a Run's diff answers each matching line with its neighbours, and whether every match was", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const repo = yield* fs.makeTempDirectoryScoped({ prefix: "collie-read-diff-" });
        const git = (...args: string[]) =>
          exec(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo });
        yield* git("init", "-q", "-b", "main");
        yield* fs.writeFileString(`${repo}/base.txt`, "base\n");
        yield* git("add", ".");
        yield* git("commit", "-qm", "base");
        yield* git("checkout", "-qb", "feature");
        yield* fs.writeFileString(
          `${repo}/listing.txt`,
          Arr.join(
            Arr.makeBy(30, (i) => (i % 5 === 4 ? `TODO ${i + 1}` : `item ${i + 1}`)),
            "\n",
          ) + "\n",
        );
        yield* git("add", "-A");
        yield* git("commit", "-qm", "work");
        const state = yield* fs.makeTempDirectoryScoped({ prefix: "collie-read-state-" });
        const run = yield* madeRun(state, { cwd: repo, branch: "feature", state: "succeeded" });
        // Read in parts smaller than the patch, as a long diff is.
        const patch = yield* wholeText((offset) =>
          fetchRef(run, "diff:listing.txt", { offset, length: 64 }),
        );
        expect(patch).not.toBeNull();

        const some = linesOf("diff:listing.txt", patch!, { start: 1, count: 4, search: "TODO" });
        expect(Arr.map(some.lines, (one) => one.text)).toEqual([
          "+TODO 5",
          "+TODO 10",
          "+TODO 15",
          "+TODO 20",
        ]);
        expect(some.complete).toBe(false);
        expect(some.lines[0]).toMatchObject({ before: "+item 4", after: "+item 6" });
        const rest = linesOf("diff:listing.txt", patch!, {
          start: some.next!,
          count: 4,
          search: "TODO",
        });
        expect(Arr.map(rest.lines, (one) => one.text)).toEqual(["+TODO 25", "+TODO 30"]);
        expect(rest.complete).toBe(true);
        expect(rest.lines[1]).toMatchObject({ before: "+item 29", after: null });
        const every = linesOf("diff:listing.txt", patch!, { start: 1, count: 50, search: "TODO" });
        expect(every.complete).toBe(true);
        expect(Arr.map(every.lines, (one) => one.line)).toEqual(
          Arr.map([...some.lines, ...rest.lines], (one) => one.line),
        );
        expect(Arr.map(every.lines, (one) => Str.split(patch!, "\n")[one.line - 1])).toEqual(
          Arr.map(every.lines, (one) => one.text),
        );
      }),
    ).pipe(Effect.provide(forgeHttpLayer)),
  ));
