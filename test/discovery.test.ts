// Where a workflow module lives, and which of them wins.
//
// No host and no engine here: this is the lookup itself, which is what decides whether
// saving a file is enough to run it. The questions are about files — which layer claims
// an id, what an unreadable override does to the one below it, and what counts as an
// edit — so the answers are read off a directory rather than a running process.

import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { discover, searchPath, type EntryLayer } from "../src/discovery";
import { revisionOf } from "../src/engine";
import { runEffect } from "./support/effect";

const repo = new URL("../", import.meta.url).pathname;

/** A whole entry, in as much as discovery reads one: what it is, not what it does. */
const entry = (id: string, title = `The ${id} workflow`, declared = "") => `
import { defineWorkflow } from "collie";
import { Effect, Layer, Schema } from "effect";

export default defineWorkflow({
  id: "${id}",
  title: ${title.startsWith("@") ? title.slice(1) : `"${title}"`},
  description: "An entry written for a test.",${declared}
  run: () => Effect.void,
});
`;

/** The three layers, empty, in a directory of their own. */
const layers = Effect.fn("DiscoveryTest.layers")(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix });
  const roots = searchPath({ pluginRoot: `${dir}/install`, project: `${dir}/project` });
  for (const layer of roots) yield* fs.makeDirectory(layer.dir, { recursive: true });
  const dirOf = (layer: EntryLayer) => roots.find((root) => root.layer === layer)!.dir;
  return {
    roots,
    dirOf,
    save: (layer: EntryLayer, name: string, text: string) =>
      fs
        .writeFileString(`${dirOf(layer)}/${name}`, text)
        .pipe(Effect.map(() => `${dirOf(layer)}/${name}`)),
    remove: (layer: EntryLayer, name: string) => fs.remove(`${dirOf(layer)}/${name}`),
  };
});

test("a workflow is looked for in the project, then the user's, then the shipped", () => {
  const roots = searchPath({ pluginRoot: "/home/someone/.collie", project: "/work/thing" });
  expect(roots).toEqual([
    { layer: "project", dir: "/work/thing/.herdr/workflows" },
    { layer: "user", dir: "/home/someone/.collie/user/workflows" },
    { layer: "shipped", dir: "/home/someone/.collie/workflows" },
  ]);
});

test("the nearest layer that claims an id is the one a run would get", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* layers("collie-discovery-order-");
      const overriding = yield* where.save("project", "proof.workflow.ts", entry("proof", "Ours"));
      yield* where.save("user", "proof.workflow.ts", entry("proof", "Mine"));
      yield* where.save("shipped", "proof.workflow.ts", entry("proof", "Theirs"));
      yield* where.save("shipped", "plain.workflow.ts", entry("plain"));

      const found = yield* discover(where.roots);
      expect(found.problems).toEqual([]);
      expect(found.entries.map((one) => [one.id, one.layer, one.title])).toEqual([
        ["plain", "shipped", "The plain workflow"],
        ["proof", "project", "Ours"],
      ]);
      expect(found.entries[1]?.path).toBe(overriding);

      // Deleting an override is not a broken one: the layer below claims the id again.
      yield* where.remove("project", "proof.workflow.ts");
      const after = yield* discover(where.roots);
      expect(after.entries.map((one) => [one.id, one.layer])).toEqual([
        ["plain", "shipped"],
        ["proof", "user"],
      ]);
    }).pipe(Effect.scoped),
  ));

test("an override that cannot be read refuses its own id rather than running the one below", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* layers("collie-discovery-broken-");
      const broken = yield* where.save("project", "proof.workflow.ts", "export const id = ;\n");
      yield* where.save("user", "proof.workflow.ts", entry("proof", "The one not to fall back to"));
      yield* where.save("user", "plain.workflow.ts", entry("plain"));

      const found = yield* discover(where.roots);
      // The id is refused, and the file that refused it is named.
      expect(found.entries.map((one) => one.id)).toEqual(["plain"]);
      expect(found.problems.map((one) => [one.id, one.layer, one.path])).toEqual([
        ["proof", "project", broken],
      ]);
      expect(found.problems[0]?.message).not.toBe("");
    }).pipe(Effect.scoped),
  ));

test("an input that is not a struct is that entry's problem, and the rest are still found", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* layers("collie-discovery-schema-");
      const odd = yield* where.save(
        "user",
        "odd.workflow.ts",
        entry("odd", undefined, "\n  input: Schema.String,"),
      );
      yield* where.save("user", "plain.workflow.ts", entry("plain"));

      const found = yield* discover(where.roots);
      expect(found.entries.map((one) => one.id)).toEqual(["plain"]);
      expect(found.problems.map((one) => [one.id, one.path])).toEqual([["odd", odd]]);
      expect(found.problems[0]?.message).toContain("input");
    }).pipe(Effect.scoped),
  ));

test("metadata that is not what a workflow declares is that entry's problem, and the rest are still found", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* layers("collie-discovery-metadata-");
      const odd = yield* where.save(
        "user",
        "odd.workflow.ts",
        entry("odd", undefined, "\n  actions: 5 as never,"),
      );
      yield* where.save("user", "plain.workflow.ts", entry("plain"));

      const found = yield* discover(where.roots);
      expect(found.entries.map((one) => one.id)).toEqual(["plain"]);
      expect(found.problems.map((one) => [one.id, one.path])).toEqual([["odd", odd]]);
      expect(found.problems[0]?.message).toContain("metadata");
    }).pipe(Effect.scoped),
  ));

test("two entries in one layer claiming one id are an error that names the other file", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* layers("collie-discovery-duplicate-");
      const first = yield* where.save("user", "copy.workflow.ts", entry("proof"));
      const second = yield* where.save("user", "proof.workflow.ts", entry("proof"));
      yield* where.save("user", "plain.workflow.ts", entry("plain"));
      // The layer below has a perfectly good one, which an ambiguous claim above still
      // refuses: a duplicate is a mistake to fix, not a reason to pick for the author.
      yield* where.save("shipped", "proof.workflow.ts", entry("proof"));

      const found = yield* discover(where.roots);
      expect(found.entries.map((one) => one.id)).toEqual(["plain"]);
      expect(found.problems.map((one) => one.path)).toEqual([first, second]);
      expect(found.problems[0]?.message).toContain(second);
      expect(found.problems[1]?.message).toContain(first);
    }).pipe(Effect.scoped),
  ));

test("only entry files are looked at, and an entry is read without being built", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* layers("collie-discovery-entries-");
      yield* where.save("user", "helper.ts", "export const label = (note: string) => note;\n");
      yield* where.save("user", "notes.md", "A prompt beside the code.\n");
      yield* where.save("user", "proof.workflow.ts.bak", entry("stale"));
      // Discovery imports a module to read what it says it is; building it is what a
      // start does, so an entry nobody could build is still an entry.
      yield* where.save(
        "user",
        "plain.workflow.ts",
        entry(
          "plain",
          undefined,
          '\n  layer: Layer.effectDiscard(Effect.die("its layer was built")),',
        ),
      );

      const found = yield* discover(where.roots);
      expect(found.problems).toEqual([]);
      expect(found.entries.map((one) => one.id)).toEqual(["plain"]);
    }).pipe(Effect.scoped),
  ));

test("an edited helper is a new revision of the entry beside it", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* layers("collie-discovery-revision-");
      yield* where.save("user", "proof.workflow.ts", entry("proof"));
      yield* where.save("user", "helper.ts", "export const label = (note: string) => note;\n");

      const before = yield* discover(where.roots);
      expect(yield* revisionOf(where.dirOf("user"))).toBe(before.entries[0]!.revision);

      yield* where.save(
        "user",
        "helper.ts",
        "export const label = (note: string) => `x${note}`;\n",
      );
      const after = yield* discover(where.roots);
      expect(after.entries[0]?.revision).not.toBe(before.entries[0]?.revision);
      // An edit to a file the entry imports is an edit to the entry: it is the directory
      // a generation is staged from, so the revision is the directory's.
      expect(after.entries[0]?.id).toBe("proof");
    }).pipe(Effect.scoped),
  ));

test("what an edited helper exports is what the entry beside it says next", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* layers("collie-discovery-helper-");
      yield* where.save(
        "user",
        "proof.workflow.ts",
        `import { title } from "./named.ts";\n${entry("proof", "@title")}`,
      );
      yield* where.save("user", "named.ts", 'export const title = "Before";\n');
      expect((yield* discover(where.roots)).entries[0]?.title).toBe("Before");

      yield* where.save("user", "named.ts", 'export const title = "After";\n');
      expect((yield* discover(where.roots)).entries[0]?.title).toBe("After");
    }).pipe(Effect.scoped),
  ));

test("an installed dependency counts by its name, not by everything inside it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const where = yield* layers("collie-discovery-toolchain-");
      yield* where.save("user", "proof.workflow.ts", entry("proof"));
      const installed = `${where.dirOf("user")}/node_modules/left-pad`;
      yield* fs.makeDirectory(installed, { recursive: true });
      yield* fs.writeFileString(`${installed}/index.js`, "module.exports = 1;\n");

      const before = yield* discover(where.roots);
      // A dependency's own contents are not read: the toolchain a module is typechecked
      // against is installed here, and reading all of it would be on the way of a start.
      yield* fs.writeFileString(`${installed}/index.js`, "module.exports = 2;\n");
      expect((yield* discover(where.roots)).entries[0]?.revision).toBe(before.entries[0]?.revision);

      // Installing something is still a change, because its name is new.
      yield* fs.writeFileString(`${installed}/other.js`, "module.exports = 3;\n");
      expect((yield* discover(where.roots)).entries[0]?.revision).not.toBe(
        before.entries[0]?.revision,
      );
    }).pipe(Effect.scoped),
  ));

test("the user's workflows are not something the installation's own checkout can overwrite", () =>
  runEffect(
    Effect.gen(function* () {
      // `collie upgrade` fast-forwards this checkout. A user directory git tracked or did
      // not ignore is one an upgrade could write over, which is the whole risk here.
      const ignored = yield* Effect.promise(() =>
        Bun.$`git check-ignore user/workflows/mine.workflow.ts`.cwd(repo).nothrow().quiet(),
      );
      expect(ignored.exitCode).toBe(0);
      const tracked = yield* Effect.promise(() => Bun.$`git ls-files user`.cwd(repo).text());
      expect(tracked.trim()).toBe("");
    }),
  ));
