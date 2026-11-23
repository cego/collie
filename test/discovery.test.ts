import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { discover, searchPath, type EntryLayer } from "../src/discovery";
import { revisionOf } from "../src/engine";
import { runEffect } from "./support/effect";

const repo = new URL("../", import.meta.url).pathname;

const entry = (id: string, title = `The ${id} workflow`, declared = "") => `
import { defineWorkflow } from "collie";
import { Effect, Layer, Schema } from "effect";

export default defineWorkflow({
  id: "${id}",
  title: ${pipe_(title, Str.startsWith("@")) ? pipe_(title, Str.slice(1)) : `"${title}"`},
  description: "An entry written for a test.",${declared}
  run: () => Effect.void,
});
`;

const layers = Effect.fn("DiscoveryTest.layers")(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix });
  const roots = searchPath({
    pluginRoot: `${dir}/install`,
    userDir: `${dir}/install/user`,
    project: `${dir}/project`,
  });
  for (const layer of roots) yield* fs.makeDirectory(layer.dir, { recursive: true });
  const dirOf = (layer: EntryLayer) =>
    Option.getOrUndefined(Arr.findFirst(roots, (root) => root.layer === layer))!.dir;
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
  const roots = searchPath({
    pluginRoot: "/home/someone/.collie",
    userDir: "/home/someone/.collie/user",
    project: "/work/thing",
  });
  expect(roots).toEqual([
    { layer: "project", dir: "/work/thing/.collie/workflows" },
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
      expect(Arr.map(found.entries, (one) => [one.id, one.layer, one.title])).toEqual([
        ["plain", "shipped", "The plain workflow"],
        ["proof", "project", "Ours"],
      ]);
      expect(found.entries[1]?.path).toBe(overriding);

      yield* where.remove("project", "proof.workflow.ts");
      const after = yield* discover(where.roots);
      expect(Arr.map(after.entries, (one) => [one.id, one.layer])).toEqual([
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
      expect(Arr.map(found.entries, (one) => one.id)).toEqual(["plain"]);
      expect(Arr.map(found.problems, (one) => [one.id, one.layer, one.path])).toEqual([
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
      expect(Arr.map(found.entries, (one) => one.id)).toEqual(["plain"]);
      expect(Arr.map(found.problems, (one) => [one.id, one.path])).toEqual([["odd", odd]]);
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
      expect(Arr.map(found.entries, (one) => one.id)).toEqual(["plain"]);
      expect(Arr.map(found.problems, (one) => [one.id, one.path])).toEqual([["odd", odd]]);
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
      // WARNING: An ambiguous claim is refused even when the layer below has a good one: a duplicate is a mistake to fix, not a choice to make.
      yield* where.save("shipped", "proof.workflow.ts", entry("proof"));

      const found = yield* discover(where.roots);
      expect(Arr.map(found.entries, (one) => one.id)).toEqual(["plain"]);
      expect(Arr.map(found.problems, (one) => one.path)).toEqual([first, second]);
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
      // WARNING: Discovery imports a module only to read it; building is what a start does, so an unbuildable entry is still an entry.
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
      expect(Arr.map(found.entries, (one) => one.id)).toEqual(["plain"]);
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
      // WARNING: An edit to a file the entry imports is an edit to the entry; the revision is the directory's.
      expect(after.entries[0]?.id).toBe("proof");
    }).pipe(Effect.scoped),
  ));

test("one revision reads each source once and the next revision reads an edited helper afresh", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "revision-reads-" });
      const dir = `${root}/mod`;
      const file = `${dir}/entry.ts`;
      const helper = `${root}/helper.ts`;
      yield* fs.makeDirectory(dir);
      yield* fs.writeFileString(file, 'export { n } from "../helper";');
      yield* fs.writeFileString(helper, "export const n = 1;");
      const linked = `${root}/linked-notes`;
      yield* fs.makeDirectory(linked);
      yield* fs.writeFileString(`${linked}/note.md`, "Before");
      yield* fs.symlink(linked, `${dir}/linked-notes`);
      const reads: Array<string> = [];
      const counted: FileSystem.FileSystem = {
        ...fs,
        readFileString: (file, encoding) =>
          Effect.sync(() => reads.push(file)).pipe(
            Effect.andThen(fs.readFileString(file, encoding)),
          ),
      };
      const revision = revisionOf(dir).pipe(Effect.provideService(FileSystem.FileSystem, counted));
      const before = yield* revision;
      expect(Arr.filter(reads, (one) => one === file)).toHaveLength(1);
      expect(Arr.filter(reads, (one) => one === helper)).toHaveLength(1);
      yield* fs.writeFileString(`${linked}/note.md`, "After");
      expect(yield* revision).toBe(before);
      reads.length = 0;
      yield* fs.writeFileString(helper, "export const n = 2;");
      expect(yield* revision).not.toBe(before);
      expect(Arr.filter(reads, (one) => one === file)).toHaveLength(1);
      expect(Arr.filter(reads, (one) => one === helper)).toHaveLength(1);
    }),
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
      // WARNING: A dependency's contents are not read: reading all of the toolchain would slow every start.
      yield* fs.writeFileString(`${installed}/index.js`, "module.exports = 2;\n");
      expect((yield* discover(where.roots)).entries[0]?.revision).toBe(before.entries[0]?.revision);

      yield* fs.writeFileString(`${installed}/other.js`, "module.exports = 3;\n");
      expect((yield* discover(where.roots)).entries[0]?.revision).not.toBe(
        before.entries[0]?.revision,
      );
    }).pipe(Effect.scoped),
  ));

test("the user's workflows are not something the installation's own checkout can overwrite", () =>
  runEffect(
    Effect.gen(function* () {
      // WARNING: collie upgrade fast-forwards this checkout; an untracked or unignored user directory is one it could write over.
      const ignored = yield* Effect.promise(() =>
        Bun.$`git check-ignore user/workflows/mine.workflow.ts`.cwd(repo).nothrow().quiet(),
      );
      expect(ignored.exitCode).toBe(0);
      const tracked = yield* Effect.promise(() => Bun.$`git ls-files user`.cwd(repo).text());
      expect(Str.trim(tracked)).toBe("");
    }),
  ));

test("a module still hinting gitlab-repository loads, its Input read as repository", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* layers("collie-discovery-old-strategy-");
      yield* where.save(
        "project",
        "roams-old.workflow.ts",
        entry(
          "roams-old",
          "Roams by the old name",
          `
  input: Schema.Struct({ repository: Schema.String }),
  hints: { repository: "gitlab-repository" },
  checkout: "roaming",`,
        ),
      );
      const found = yield* discover(where.roots);
      expect(found.problems).toEqual([]);
      const [loaded] = found.entries;
      expect(loaded?.id).toBe("roams-old");
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(loaded), (present) =>
            Arr.map(present.inputs, (one) => [one.name, one.strategy]),
          ),
        ),
      ).toEqual([["repository", "repository"]]);
    }).pipe(Effect.scoped),
  ));
