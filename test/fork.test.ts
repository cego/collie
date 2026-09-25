import { Clock, Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { forkDefinition } from "../src/fork";
import { parseDocument } from "../src/yaml";
import { contentHash, isStale, layers, loadDefinitions } from "../src/definitions";
import { Rig } from "./support/recorder";
import { installBaseline } from "./support/engine";

const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");
const readText = Effect.fn("test.readText")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(path);
});
const writeText = Effect.fn("test.writeText")(function* (path: string, text: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(path, text);
});
const mkdirp = Effect.fn("test.mkdirp")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(path, { recursive: true });
});
const tempDir = Effect.fn("test.tempDir")(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectory({ prefix });
});
const removeTree = Effect.fn("test.removeTree")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(path, { recursive: true, force: true });
});
const exists = Effect.fn("test.exists")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.exists(path);
});

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* installBaseline(rig);
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

test("a fork is a stub that extends the original", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const source = (yield* loadDefinitions(yield* layers(env))).personas.get("reviewer")!;
      expect(source.layer).toBe("baseline");

      const result = yield* forkDefinition(source.path, "personas", rig.userDir);

      expect(result.ok).toBe(true);
      expect(result.path).toBe(join(rig.userDir, "personas", "reviewer.md"));
      expect(yield* readText(result.path)).toContain("extends: reviewer");

      // It wins by name, and everything it does not name is still the baseline's.
      const forked = (yield* loadDefinitions(yield* layers(env))).personas.get("reviewer")!;
      expect(forked.layer).toBe("user");
      expect(forked.extends).toBe("reviewer");
      expect(forked.description).toBe(source.description);
    }),
  ));

test("a full copy is the whole file, and records what it copied", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const source = (yield* loadDefinitions(yield* layers(env))).personas.get("reviewer")!;
      const before = yield* readText(source.path);

      const result = yield* forkDefinition(source.path, "personas", rig.userDir, { full: true });

      expect(result.ok).toBe(true);
      expect(result.message).toContain("no longer follows the original");
      const text = yield* readText(result.path);
      const hash = yield* contentHash(before);
      // Quoted where the hash happens to be all digits, which YAML would otherwise
      // decode as a number — and a numeric hash is one `parseWorkflow` drops.
      expect(text).toMatch(new RegExp(`^forked_from_hash: "?${hash}"?$`, "m"));
      // Whichever it is, it survives a round trip as the string it is.
      expect(
        (yield* loadDefinitions(yield* layers(env))).personas.get("reviewer")!.forkedFromHash,
      ).toBe(hash);
      // Everything else is the file, byte for byte, after that one line.
      expect(text.replace(/^forked_from_hash: .*\n/m, "")).toBe(before);

      const forked = (yield* loadDefinitions(yield* layers(env))).personas.get("reviewer")!;
      expect(forked.extends).toBeUndefined();
      expect(isStale(forked)).toBe(false);
    }),
  ));

test("a full copy whose original has changed since is stale", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const source = (yield* loadDefinitions(yield* layers(env))).personas.get("reviewer")!;

      yield* forkDefinition(source.path, "personas", rig.userDir, { full: true });
      expect(isStale((yield* loadDefinitions(yield* layers(env))).personas.get("reviewer")!)).toBe(
        false,
      );

      // The baseline moves on, which is exactly what a full copy cannot follow.
      Bun.spawnSync(["sh", "-c", `printf '\n<!-- a later change -->\n' >> ${source.path}`]);

      expect(isStale((yield* loadDefinitions(yield* layers(env))).personas.get("reviewer")!)).toBe(
        true,
      );
    }),
  ));

test("forking a persona into the project layer is what that project's agents read", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const defs = yield* loadDefinitions(yield* layers(env));
      const reviewer = defs.personas.get("reviewer")!;

      const result = yield* forkDefinition(
        reviewer.path,
        "personas",
        join(rig.projectDir, ".collie"),
        {
          full: true,
        },
      );
      expect(result.ok).toBe(true);
      Bun.spawnSync(["sh", "-c", `printf 'Project reviewer.\\n' >> ${result.path}`]);

      const after = yield* loadDefinitions(yield* layers(env));
      expect(after.personas.get("reviewer")!.layer).toBe("project");
      expect(after.personas.get("reviewer")!.body).toContain("Project reviewer.");
    }),
  ));

test("forking never overwrites an existing fork", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const source = (yield* loadDefinitions(yield* layers(env))).personas.get("planner")!;

      expect((yield* forkDefinition(source.path, "personas", rig.userDir)).ok).toBe(true);
      Bun.spawnSync([
        "sh",
        "-c",
        `printf 'edited\\n' >> ${join(rig.userDir, "personas", "planner.md")}`,
      ]);

      const again = yield* forkDefinition(source.path, "personas", rig.userDir);

      expect(again.ok).toBe(false);
      expect(again.message).toContain("already exists — edit it instead");
      expect(yield* readText(again.path)).toContain("edited");
    }),
  ));

test("a target occupied while a fork is being prepared is never overwritten", () =>
  runEffect(
    Effect.gen(function* () {
      const root = yield* tempDir("collie-fork-race-");
      const source = join(root, "helper.md");
      const targetDir = join(root, "target");
      const target = join(targetDir, "personas", "helper.md");
      Bun.spawnSync(["mkfifo", source]);
      yield* mkdirp(join(targetDir, "personas"));
      const forkModule = new URL("../src/fork.ts", import.meta.url).pathname.replaceAll("'", "\\'");
      const marker = join(root, "child-ready");
      const child = Bun.spawn(
        [
          "bun",
          "-e",
          `import { BunServices } from "@effect/platform-bun"; import { ManagedRuntime } from "effect"; import { forkDefinition } from '${forkModule}'; const runtime = ManagedRuntime.make(BunServices.layer); await Bun.write(process.argv[3], ""); console.log((await runtime.runPromise(forkDefinition(process.argv[1], "personas", process.argv[2], { full: true }))).ok ? "ok=true" : "ok=false")`,
          source,
          targetDir,
          marker,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );

      // The child writes the marker on its way into the fork; from there the fifo is
      // what holds it, so writing the source below is the handover.
      const deadline = (yield* Clock.currentTimeMillis) + 30_000;
      while (!(yield* exists(marker)) && (yield* Clock.currentTimeMillis) < deadline) {
        yield* Effect.promise(() => Bun.sleep(10));
      }
      expect(yield* exists(marker)).toBe(true);

      yield* writeText(target, "winner\n");
      yield* writeText(source, "---\nname: helper\n---\nsource\n");
      const result = yield* Effect.promise(() => new Response(child.stdout).text());
      yield* Effect.promise(() => child.exited);

      expect(result).toContain("ok=false");
      expect(yield* readText(target)).toBe("winner\n");
      yield* removeTree(root);
    }),
  ));

test("forking a definition into the layer it already lives in is refused", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const source = (yield* loadDefinitions(yield* layers(env))).personas.get("planner")!;

      yield* forkDefinition(source.path, "personas", rig.userDir);
      const forked = (yield* loadDefinitions(yield* layers(env))).personas.get("planner")!;

      const result = yield* forkDefinition(forked.path, "personas", rig.userDir);

      expect(result.ok).toBe(false);
      expect(result.message).toBe("planner.md is already in that layer");
    }),
  ));

test("a fork of the baseline leaves the baseline file untouched", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const source = (yield* loadDefinitions(yield* layers(env))).personas.get("implementer")!;
      const before = yield* readText(source.path);

      yield* forkDefinition(source.path, "personas", join(rig.projectDir, ".collie"));
      Bun.spawnSync([
        "sh",
        "-c",
        `printf 'changed\\n' >> ${join(rig.projectDir, ".collie", "personas", "implementer.md")}`,
      ]);

      expect(yield* readText(source.path)).toBe(before);
      expect(yield* exists(join(rig.projectDir, ".collie", "personas", "implementer.md"))).toBe(
        true,
      );
    }),
  ));

test("a fork name that is not a bare scalar is quoted, and a corrupting one is refused", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const source = (yield* loadDefinitions(yield* layers(env))).personas.get("implementer")!;

      const stub = yield* forkDefinition(source.path, "personas", rig.userDir, {
        name: "foo # bar",
      });
      expect(stub.ok).toBe(true);
      expect(parseDocument(yield* readText(stub.path)).data.name).toBe("foo # bar");

      const copy = yield* forkDefinition(source.path, "personas", rig.userDir, {
        name: "foo: bar",
        full: true,
      });
      expect(copy.ok).toBe(true);
      expect(parseDocument(yield* readText(copy.path)).data.name).toBe("foo: bar");

      const refused = yield* forkDefinition(source.path, "personas", rig.userDir, {
        name: "two\nlines",
      });
      expect(refused.ok).toBe(false);
      expect(refused.message).toContain("control character");
    }),
  ));

test("re-forking a full copy records the copy's own hash, not its grandparent's", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const source = (yield* loadDefinitions(yield* layers(env))).personas.get("reviewer")!;

      const first = yield* forkDefinition(source.path, "personas", rig.userDir, { full: true });
      const parentText = yield* readText(first.path);
      const second = yield* forkDefinition(
        first.path,
        "personas",
        join(rig.projectDir, ".collie"),
        {
          full: true,
        },
      );

      const text = yield* readText(second.path);
      expect(text.match(/^forked_from_hash:/gm)).toHaveLength(1);
      expect(parseDocument(text).data.forked_from_hash).toBe(yield* contentHash(parentText));
    }),
  ));

test("a full copy of a definition with a quoted name answers to the fork's name", () =>
  runEffect(
    Effect.gen(function* () {
      const root = yield* tempDir("collie-fork-quoted-");
      const source = join(root, "my-flow.md");
      yield* writeText(source, `---\nname: "my-flow"\n---\n\nbody\n`);

      const result = yield* forkDefinition(source, "personas", join(root, "target"), {
        name: "other-flow",
        full: true,
      });

      expect(result.ok).toBe(true);
      expect(parseDocument(yield* readText(result.path)).data.name).toBe("other-flow");
      yield* removeTree(root);
    }),
  ));
