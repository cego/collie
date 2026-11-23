// Where a workflow module lives, and which of them wins.
//
// No host and no engine here: this is the lookup itself, which is what decides whether
// saving a file is enough to run it. The questions are about files — which layer claims
// an id, what an unreadable override does to the one below it, and what counts as an
// edit — so the answers are read off a directory rather than a running process.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import {
  discover,
  searchPath,
  type Catalogued,
  type EntryLayer,
  type Root,
} from "../src/discovery";
import { RevisionRows, onSyncedRevisions, type ModuleRevisionsApi } from "../src/module-revisions";
import { revisionOf } from "../src/engine";
import { runEffect } from "./support/effect";

const repo = new URL("../", import.meta.url).pathname;

/** A whole entry, in as much as discovery reads one: what it is, not what it does. */
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

/** The three layers, empty, in a directory of their own. */
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

      // Deleting an override is not a broken one: the layer below claims the id again.
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
      // The id is refused, and the file that refused it is named.
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
      // The layer below has a perfectly good one, which an ambiguous claim above still
      // refuses: a duplicate is a mistake to fix, not a reason to pick for the author.
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
      // An edit to a file the entry imports is an edit to the entry: it is the directory
      // a generation is staged from, so the revision is the directory's.
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
      const reads: string[] = [];
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

/**
 * `discover` as a host runs it: revisions kept in rows, and every path it touches through
 * the file system noted, which is how staging an entry and hashing a tree both reach a file.
 */
const hosted = Effect.fn("DiscoveryTest.hosted")(function* (roots: ReadonlyArray<Root>) {
  const fs = yield* FileSystem.FileSystem;
  const revisions = new Map<string, string>();
  const rows: ModuleRevisionsApi = {
    all: Effect.succeed(revisions),
    of: (dir) => Effect.sync(() => revisions.get(dir) ?? null),
    put: (dir, revision) => Effect.sync(() => void revisions.set(dir, revision)),
  };
  const touched: Array<string> = [];
  const noted = <A>(path: string, read: A) => {
    touched.push(path);
    return read;
  };
  const counted: FileSystem.FileSystem = {
    ...fs,
    exists: (path) => noted(path, fs.exists(path)),
    readDirectory: (path, options) => noted(path, fs.readDirectory(path, options)),
    readFileString: (path, encoding) => noted(path, fs.readFileString(path, encoding)),
  };
  const asHost = (read: Effect.Effect<Catalogued, never, FileSystem.FileSystem>) =>
    read.pipe(
      Effect.provideService(FileSystem.FileSystem, counted),
      Effect.provideService(RevisionRows, { rows, synced: false }),
    );
  return {
    revisions,
    /** Paths under any layer touched since the last call. */
    layerReads: () => {
      const seen = Arr.filter(touched, (path) =>
        Arr.some(roots, (root) => pipe_(path, Str.includes(root.dir))),
      );
      touched.length = 0;
      return seen;
    },
    /** As a start, an offer taken or `collie workflow check` reads. */
    fresh: asHost(discover(roots)),
    /** As a listing reads. */
    synced: asHost(onSyncedRevisions(discover(roots))),
  };
});

test("a listing of layers whose revisions have not moved reads none of their files, and says what a fresh read says", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* layers("collie-discovery-kept-");
      yield* where.save("user", "plain.workflow.ts", entry("plain"));
      yield* where.save("user", "broken.workflow.ts", "export const id = ;\n");
      const host = yield* hosted(where.roots);

      const read = yield* host.fresh;
      expect(host.layerReads()).not.toEqual([]);
      expect(yield* host.synced).toEqual(read);
      expect(yield* host.synced).toEqual(read);
      expect(host.layerReads()).toEqual([]);
    }).pipe(Effect.scoped),
  ));

test("an entry or helper edit a start reads is what the next listing says", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* layers("collie-discovery-kept-edit-");
      yield* where.save(
        "user",
        "proof.workflow.ts",
        `import { title } from "./named.ts";\n${entry("proof", "@title")}`,
      );
      yield* where.save("user", "named.ts", 'export const title = "Before";\n');
      const host = yield* hosted(where.roots);
      yield* host.fresh;

      yield* where.save("user", "named.ts", 'export const title = "After";\n');
      // A listing reads the kept revision, which nothing has moved yet.
      expect((yield* host.synced).entries[0]?.title).toBe("Before");
      expect((yield* host.fresh).entries[0]?.title).toBe("After");
      host.layerReads();
      expect((yield* host.synced).entries[0]?.title).toBe("After");
      expect(host.layerReads()).toEqual([]);

      yield* where.save(
        "user",
        "proof.workflow.ts",
        `import { title } from "./named.ts";\n${entry("proof", "Retitled")}`,
      );
      yield* host.fresh;
      expect((yield* host.synced).entries[0]?.title).toBe("Retitled");
    }).pipe(Effect.scoped),
  ));

test("a fault is kept while its file is, and a fixed file clears it at the next revision sync", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* layers("collie-discovery-kept-fault-");
      yield* where.save("user", "proof.workflow.ts", "export const id = ;\n");
      const host = yield* hosted(where.roots);
      yield* host.fresh;
      host.layerReads();

      for (const _ of [1, 2]) {
        const listed = yield* host.synced;
        expect(listed.entries).toEqual([]);
        expect(Arr.map(listed.problems, (one) => one.id)).toEqual(["proof"]);
      }
      expect(host.layerReads()).toEqual([]);

      yield* where.save("user", "proof.workflow.ts", entry("proof"));
      // What the backstop does for an edit made outside Collie.
      host.revisions.set(where.dirOf("user"), yield* revisionOf(where.dirOf("user")));
      const fixed = yield* host.synced;
      expect(Arr.map(fixed.entries, (one) => one.id)).toEqual(["proof"]);
      expect(fixed.problems).toEqual([]);
    }).pipe(Effect.scoped),
  ));

test("the nearest claim, a broken override and two claims in one layer decide as before when the claims are kept", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* layers("collie-discovery-kept-order-");
      const broken = yield* where.save("project", "proof.workflow.ts", "export const id = ;\n");
      yield* where.save("user", "proof.workflow.ts", entry("proof", "Mine"));
      yield* where.save("user", "plain.workflow.ts", entry("plain", "Mine"));
      const first = yield* where.save("user", "copy.workflow.ts", entry("twice"));
      const second = yield* where.save("user", "twice.workflow.ts", entry("twice"));
      yield* where.save("shipped", "plain.workflow.ts", entry("plain", "Theirs"));
      yield* where.save("shipped", "twice.workflow.ts", entry("twice"));
      const host = yield* hosted(where.roots);
      yield* host.fresh;
      host.layerReads();

      const listed = yield* host.synced;
      expect(host.layerReads()).toEqual([]);
      expect(Arr.map(listed.entries, (one) => [one.id, one.layer, one.title])).toEqual([
        ["plain", "user", "Mine"],
      ]);
      expect(Arr.map(listed.problems, (one) => [one.id, one.layer, one.path])).toEqual([
        ["proof", "project", broken],
        ["twice", "user", first],
        ["twice", "user", second],
      ]);
    }).pipe(Effect.scoped),
  ));

test("a layer the host has no revision for is read once, then kept", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* layers("collie-discovery-kept-new-");
      yield* where.save("project", "plain.workflow.ts", entry("plain"));
      const host = yield* hosted(where.roots);

      const read = yield* host.synced;
      expect(Arr.map(read.entries, (one) => one.id)).toEqual(["plain"]);
      expect(host.layerReads()).not.toEqual([]);
      expect(yield* host.synced).toEqual(read);
      expect(host.layerReads()).toEqual([]);
    }).pipe(Effect.scoped),
  ));

test("a read that is not a listing, as `collie workflow check` takes, imports every entry again", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* layers("collie-discovery-kept-check-");
      const plain = yield* where.save("user", "plain.workflow.ts", entry("plain"));
      const host = yield* hosted(where.roots);
      yield* host.fresh;
      host.layerReads();

      yield* host.fresh;
      expect(Arr.some(host.layerReads(), (path) => pipe_(path, Str.endsWith(plain)))).toBe(true);
    }).pipe(Effect.scoped),
  ));
