import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { runEffect } from "./support/effect";
import { claudeTrust } from "../src/trust";
import { isYamlMap, YamlMapSchema, type YamlMap } from "../src/yaml";

const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");

interface TrustRig {
  root: string;
  stateDir: string;
  projectDir: string;
}

let rig: TrustRig;

type ClaudeProjects = Record<string, YamlMap>;
const ClaudeConfigJson = Schema.fromJsonString(YamlMapSchema);

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory({ prefix: "trust-test-" });
      rig = { root, stateDir: join(root, "state"), projectDir: join(root, "project") };
      yield* fs.makeDirectory(rig.stateDir, { recursive: true });
      yield* fs.makeDirectory(rig.projectDir, { recursive: true });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(rig.root, { recursive: true, force: true });
    }),
  ),
);

/** A ~/.claude.json with the shape claude actually writes. */
const claudeConfig = Effect.fn("test.claudeConfig")(function* (projects: ClaudeProjects) {
  const fs = yield* FileSystem.FileSystem;
  const path = join(rig.root, ".claude.json");
  yield* fs.writeFileString(
    path,
    Schema.encodeSync(ClaudeConfigJson)({ installMethod: "native", numStartups: 12, projects }),
  );
  return path;
});

const readConfig = Effect.fn("test.readConfig")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Schema.decodeUnknownEffect(ClaudeConfigJson)(yield* fs.readFileString(path));
});

function project(config: YamlMap, path: string): YamlMap {
  expect(isYamlMap(config.projects)).toBe(true);
  const projects = isYamlMap(config.projects) ? config.projects : {};
  expect(isYamlMap(projects[path])).toBe(true);
  return isYamlMap(projects[path]) ? projects[path] : {};
}

const trust = () => claudeTrust(rig.root, rig.stateDir);

test("a directory claude has never seen is untrusted; one with the flag is trusted", () =>
  runEffect(
    Effect.gen(function* () {
      yield* claudeConfig({
        [rig.projectDir]: { mcpServers: {}, hasTrustDialogAccepted: true },
        "/somewhere/else": { mcpServers: {} },
      });

      expect(yield* trust().state(rig.projectDir)).toBe("trusted");
      expect(yield* trust().state("/somewhere/else")).toBe("untrusted");
      expect(yield* trust().state("/never/seen")).toBe("untrusted");
    }),
  ));

test("no claude config at all is unknown, not untrusted — there is nothing to write into", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      expect(yield* trust().state(rig.projectDir)).toBe("unknown");
      expect((yield* trust().grant(rig.projectDir)).ok).toBe(false);
      expect((yield* trust().grant(rig.projectDir)).message).toContain(
        "has not run on this machine",
      );
      expect(yield* fs.exists(join(rig.root, ".claude.json"))).toBe(false);
    }),
  ));

test("granting adds the flag and leaves every other project and setting alone", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* claudeConfig({
        "/other/repo": { mcpServers: { local: { command: "x" } }, lastCost: 1.5 },
      });

      const result = yield* trust().grant(rig.projectDir);

      expect(result.ok).toBe(true);
      expect(result.message).toContain(rig.projectDir);
      const after = yield* readConfig(path);
      expect(project(after, rig.projectDir)).toEqual({
        mcpServers: {},
        hasTrustDialogAccepted: true,
      });
      expect(project(after, "/other/repo")).toEqual({
        mcpServers: { local: { command: "x" } },
        lastCost: 1.5,
      });
      expect(after.installMethod).toBe("native");
      expect(after.numStartups).toBe(12);
      expect(yield* trust().state(rig.projectDir)).toBe("trusted");
    }),
  ));

test("granting keeps the rest of an existing entry and is idempotent", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* claudeConfig({
        [rig.projectDir]: { mcpServers: {}, lastCost: 2, allowedTools: ["Bash"] },
      });

      expect((yield* trust().grant(rig.projectDir)).ok).toBe(true);
      const after = yield* readConfig(path);
      expect(project(after, rig.projectDir)).toEqual({
        mcpServers: {},
        lastCost: 2,
        allowedTools: ["Bash"],
        hasTrustDialogAccepted: true,
      });

      const again = yield* trust().grant(rig.projectDir);
      expect(again.ok).toBe(true);
      expect(again.message).toContain("already");
    }),
  ));

test("the file it overwrites is kept, because it is not ours", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* claudeConfig({ "/other/repo": { mcpServers: {} } });
      const before = yield* fs.readFileString(path);

      yield* trust().grant(rig.projectDir);

      expect(yield* fs.readFileString(join(rig.stateDir, "claude.json.bak"))).toBe(before);
    }),
  ));

test("a cwd that reaches the same place through a symlink is trusted both ways", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* claudeConfig({});
      const real = join(rig.root, "real-repo");
      const link = join(rig.root, "linked-repo");
      yield* fs.makeDirectory(real, { recursive: true });
      yield* fs.symlink(real, link);

      expect((yield* trust().grant(link)).ok).toBe(true);

      expect(yield* trust().state(link)).toBe("trusted");
      expect(yield* trust().state(real)).toBe("trusted");
    }),
  ));

test("a config that is not JSON is left exactly as it is", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = join(rig.root, ".claude.json");
      yield* fs.writeFileString(path, "{ not json");

      expect(yield* trust().state(rig.projectDir)).toBe("unknown");
      expect((yield* trust().grant(rig.projectDir)).ok).toBe(false);
      expect(yield* fs.readFileString(path)).toBe("{ not json");
    }),
  ));

test("granting leaves the config's permissions alone — they are not ours either", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* claudeConfig({ "/other/repo": { mcpServers: {} } });
      yield* fs.chmod(path, 0o600);

      expect((yield* trust().grant(rig.projectDir)).ok).toBe(true);

      expect((yield* fs.stat(path)).mode & 0o777).toBe(0o600);
    }),
  ));

test("a grant while another collie holds the config lock writes nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* claudeConfig({});
      yield* fs.writeFileString(
        `${path}.herdr-lock`,
        `{"pid":${globalThis.process.pid},"start":null}\n`,
      );
      const before = yield* fs.readFileString(path);

      const result = yield* trust().grant(rig.projectDir);

      expect(result.ok).toBe(false);
      expect(yield* fs.readFileString(path)).toBe(before);
    }),
  ));
