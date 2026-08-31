import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { runEffect } from "./support/effect";

const root = new URL("../", import.meta.url).pathname;
const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");

const CliEnvelope = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Boolean,
    data: Schema.optional(Schema.Unknown),
    error: Schema.optional(
      Schema.Struct({
        code: Schema.String,
        message: Schema.optional(Schema.String),
        details: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  }),
);

const cli = Effect.fn("test.cli")(function* (
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectory({ prefix: "collie-cli-" });
  yield* fs.makeDirectory(join(dir, "config"), { recursive: true });
  const proc = Bun.spawn([Bun.argv[0] ?? "bun", join(root, "src/main.ts"), ...args], {
    cwd: root,
    env: {
      HERDR_PLUGIN_ROOT: root,
      HERDR_PLUGIN_CONFIG_DIR: join(dir, "config"),
      HERDR_PLUGIN_STATE_DIR: join(dir, "state"),
      HOME: dir,
      PWD: root,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = yield* Effect.promise(() =>
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
  );
  yield* fs.remove(dir, { recursive: true, force: true });
  return { stdout, stderr, exit };
});

const parseEnvelope = Schema.decodeUnknownEffect(CliEnvelope);

test("public JSON discovery has one typed envelope", () =>
  runEffect(
    Effect.gen(function* () {
      const listed = yield* cli(["--json", "workflow", "list"]);
      expect(listed.exit).toBe(0);
      expect(listed.stderr).toBe("");
      expect(yield* parseEnvelope(listed.stdout)).toMatchObject({
        ok: true,
        data: { workflows: expect.any(Array) },
      });

      const missing = yield* cli(["--json", "workflow", "show", "__missing__"]);
      expect(missing.exit).toBe(1);
      expect(missing.stderr).toBe("");
      expect(yield* parseEnvelope(missing.stdout)).toMatchObject({
        ok: false,
        error: { code: "workflow_not_found", details: {} },
      });
    }),
  ));

test("persona discovery uses the same command boundary", () =>
  runEffect(
    Effect.gen(function* () {
      const result = yield* cli(["--json", "persona", "list"]);
      expect(result.exit).toBe(0);
      expect(yield* parseEnvelope(result.stdout)).toMatchObject({
        ok: true,
        data: { personas: expect.any(Array) },
      });
    }),
  ));

test("invalid input is one envelope on stdout, its reason on stderr, and exit 2", () =>
  runEffect(
    Effect.gen(function* () {
      const missing = yield* cli(["--json", "workflow", "show"]);

      // No usage text: under --json stdout carries the envelope and nothing else.
      expect(yield* parseEnvelope(missing.stdout)).toEqual({
        ok: false,
        error: {
          code: "invalid_input",
          message: "Missing required argument: workflow",
          details: {},
        },
      });
      expect(missing.stdout).not.toContain("USAGE");
      expect(missing.exit).toBe(2);
      // The diagnostic is still there for a human, on the stream that cannot corrupt it.
      expect(missing.stderr).toContain("Missing required argument");

      const unknownFlag = yield* cli(["--json", "workflow", "list", "--nope"]);
      expect(yield* parseEnvelope(unknownFlag.stdout)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
      expect(unknownFlag.exit).toBe(2);

      // Asking for help is nobody's failure, and the release gate runs it.
      const help = yield* cli(["--help"]);
      expect(help.exit).toBe(0);
      expect(help.stdout).toContain("USAGE");
    }),
  ));

test("a command group named with no subcommand is invalid input, not success", () =>
  runEffect(
    Effect.gen(function* () {
      // Effect's CLI raises the same ShowHelp it raises for --help, carrying no parse
      // errors, so what tells them apart is whether help was actually asked for.
      for (const argv of [["--json", "run"], ["--json", "workflow"], ["--json"]]) {
        const stopped = yield* cli(argv);
        expect(yield* parseEnvelope(stopped.stdout)).toMatchObject({
          ok: false,
          error: { code: "invalid_input" },
        });
        expect(stopped.exit).toBe(2);
        // The envelope is the whole of stdout: no help document, and no blank line
        // ahead of it for a consumer reading a line at a time.
        expect(stopped.stdout.startsWith("{")).toBe(true);
        expect(stopped.stdout.trimEnd().split("\n")).toHaveLength(1);
      }
    }),
  ));

test("a Driver that cannot be started fails the Run rather than orphaning it", () =>
  runEffect(
    Effect.gen(function* () {
      const started = yield* cli(["--json", "run", "start", "architecture", "--request-id", "r1"], {
        COLLIE_DRIVER: "/nonexistent/collie-bin",
      });
      expect(yield* parseEnvelope(started.stdout)).toMatchObject({
        ok: false,
        error: { code: "operation_failed" },
      });
      expect(started.exit).toBe(1);
    }),
  ));
