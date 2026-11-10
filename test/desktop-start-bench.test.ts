import { describe, expect, test } from "bun:test";
import * as Str from "effect/String";
import { Effect, Exit, FileSystem, Option, Schedule, Schema } from "effect";
import { treeRssMib, measureStart } from "../bench/desktop-start/start";
import { world } from "../bench/record-open/world";
import { runEffect } from "./support/effect";
import { exec } from "./support/command";

const repo = new URL("../", import.meta.url).pathname;
const Started = Schema.fromJsonString(
  Schema.Struct({ board_usable_ms: Schema.Finite, idle_rss_mib: Schema.Finite }),
);

describe("the Desktop start harness", () => {
  test("sums the RSS of Desktop's process tree, leaving out the Collie processes it started", () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const ps = yield* fs.readFileString(`${repo}test/fixtures/desktop-start/ps.txt`);
        // Recorded on vm-mk under Xvfb: launcher 2032 + main 492772 + zygotes 71072 + 71076
        // + GPU 120268 + network 105860 + storage 47120 + renderers 122384 + 153832 + 282296
        // + 71896 KiB; three bridges and a doctor are Collie's.
        expect(treeRssMib(ps, 2910617)).toBe(1504.5);
      }),
    ));

  test("prints one JSON object of exactly its two metrics, and ends the app's whole tree", () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const app = `${dir}/app.ts`;
        // Like Desktop: a child of its own, and its board drawn where Record timing is on.
        yield* fs.writeFileString(
          app,
          `import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
const own = process.env.XDG_STATE_HOME + "/collie-desktop";
const child = Bun.spawn(["sleep", "30"]);
await Bun.write("${dir}/child.pid", String(child.pid));
if (JSON.parse(readFileSync(own + "/settings.json", "utf8")).recordTiming === true) {
  mkdirSync(own, { recursive: true });
  appendFileSync(own + "/record-timing.log", JSON.stringify({ name: "board-usable", at: performance.timeOrigin + performance.now(), card: "" }) + "\\n");
}
await child.exited;
`,
        );
        const line = yield* measureStart({
          argv: [process.execPath, app],
          env: { PATH: Bun.env.PATH },
          desktopState: `${dir}/state`,
          idle: "0 millis",
        });
        expect(line).not.toContain("\n");
        const printed = yield* Schema.decodeEffect(Started)(line, { onExcessProperty: "error" });
        expect(printed.board_usable_ms).toBeGreaterThanOrEqual(0);
        expect(printed.idle_rss_mib).toBeGreaterThan(0);
        const child = Number(yield* fs.readFileString(`${dir}/child.pid`));
        expect(() => process.kill(child, 0)).toThrow();
      }),
    ));

  test("reads an app that keeps its state elsewhere, as the Rune shell keeps its core's", () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const app = `${dir}/app.ts`;
        yield* fs.writeFileString(
          app,
          `import { appendFileSync, readFileSync } from "node:fs";
const own = process.env.XDG_STATE_HOME + "/collie-desktop-rune-spike/state/collie-desktop";
if (JSON.parse(readFileSync(own + "/settings.json", "utf8")).recordTiming === true)
  appendFileSync(own + "/record-timing.log", JSON.stringify({ name: "board-usable", at: performance.timeOrigin + performance.now(), card: "" }) + "\\n");
await Bun.sleep(30_000);
`,
        );
        const line = yield* measureStart({
          argv: [process.execPath, app],
          env: { PATH: Bun.env.PATH },
          desktopState: `${dir}/state`,
          own: `${dir}/state/collie-desktop-rune-spike/state/collie-desktop`,
          idle: "0 millis",
        });
        const printed = yield* Schema.decodeEffect(Started)(line);
        expect(printed.board_usable_ms).toBeGreaterThanOrEqual(0);
      }),
    ));

  test("kills a process of the app's tree that ignores SIGTERM, though the app itself ended", () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const app = `${dir}/app.ts`;
        yield* fs.writeFileString(
          app,
          `import { appendFileSync, mkdirSync } from "node:fs";
const own = process.env.XDG_STATE_HOME + "/collie-desktop";
const child = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"]);
await Bun.write("${dir}/child.pid", String(child.pid));
mkdirSync(own, { recursive: true });
appendFileSync(own + "/record-timing.log", JSON.stringify({ name: "board-usable", at: performance.timeOrigin + performance.now(), card: "" }) + "\\n");
await child.exited;
`,
        );
        yield* measureStart({
          argv: [process.execPath, app],
          env: { PATH: Bun.env.PATH },
          desktopState: `${dir}/state`,
          idle: "500 millis",
          grace: "1 second",
        });
        const child = Number(yield* fs.readFileString(`${dir}/child.pid`));
        yield* Effect.addFinalizer(() =>
          Effect.try(() => process.kill(child, "SIGKILL")).pipe(Effect.ignore),
        );
        const alive = () => {
          try {
            return process.kill(child, 0);
          } catch {
            return false;
          }
        };
        // A killed process takes a moment to be gone.
        const gone = yield* Effect.sync(alive).pipe(
          Effect.repeat({ until: (running) => !running, schedule: Schedule.spaced("50 millis") }),
          Effect.timeoutOption("2 seconds"),
        );
        expect(Option.isSome(gone)).toBe(true);
      }),
    ));

  test("ends what the app started even when the app ended before its board", () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const app = `${dir}/app.ts`;
        yield* fs.writeFileString(
          app,
          `const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
child.unref();
await Bun.write("${dir}/child.pid", String(child.pid));
process.exit(1);
`,
        );
        const ended = yield* measureStart({
          argv: [process.execPath, app],
          env: { PATH: Bun.env.PATH },
          desktopState: `${dir}/state`,
          idle: "0 millis",
          grace: "1 second",
        }).pipe(Effect.exit);
        expect(Exit.isFailure(ended)).toBe(true);
        const child = Number(yield* fs.readFileString(`${dir}/child.pid`));
        yield* Effect.addFinalizer(() =>
          Effect.try(() => process.kill(child, "SIGKILL")).pipe(Effect.ignore),
        );
        const alive = () => {
          try {
            return process.kill(child, 0);
          } catch {
            return false;
          }
        };
        const gone = yield* Effect.sync(alive).pipe(
          Effect.repeat({ until: (running) => !running, schedule: Schedule.spaced("50 millis") }),
          Effect.timeoutOption("2 seconds"),
        );
        expect(Option.isSome(gone)).toBe(true);
      }),
    ));

  describe.skipIf(process.platform !== "linux")("on Linux, where a build installs itself", () => {
    // Like a build's launcher: it installs Desktop under its data home and starts nothing.
    const build = (dir: string) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${dir}/launcher`,
          `#!/bin/sh
echo "$HOME" > "${dir}/installed-for"
mkdir -p "$XDG_DATA_HOME/dk.cego.collie.desktop/stable/app/bin"
touch "$XDG_DATA_HOME/dk.cego.collie.desktop/stable/app/bin/launcher"
`,
          { mode: 0o755 },
        );
        return `${dir}/launcher`;
      });
    const harness = (args: ReadonlyArray<string>) =>
      exec([process.execPath, `${repo}bench/desktop-start/run.ts`, ...args], {
        cwd: repo,
        env: Bun.env,
      });

    test("installs Desktop, untimed, under the home it keeps between samples", () =>
      runEffect(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped();
          const ran = yield* harness([
            "--install",
            "--app",
            yield* build(dir),
            "--home",
            `${dir}/kept`,
          ]);
          expect(ran.exitCode).toBe(0);
          expect(ran.stdout).toBe("");
          expect(Str.trim(yield* fs.readFileString(`${dir}/installed-for`))).toBe(`${dir}/kept`);
          expect(
            yield* fs.exists(
              `${dir}/kept/.local/share/dk.cego.collie.desktop/stable/app/bin/launcher`,
            ),
          ).toBe(true);
        }),
      ));

    test("a sample never installs: without an install it refuses and says how", () =>
      runEffect(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped();
          const ran = yield* harness(["--app", yield* build(dir), "--home", `${dir}/kept`]);
          expect(ran.exitCode).toBe(2);
          expect(ran.stderr).toContain("--install");
          expect(yield* fs.exists(`${dir}/installed-for`)).toBe(false);
        }),
      ));
  });

  test("refuses to run its host in the user's own state directory", () =>
    runEffect(
      Effect.gen(function* () {
        const ran = yield* exec([process.execPath, `${repo}bench/desktop-start/run.ts`], {
          cwd: repo,
          env: { ...Bun.env, HERDR_PLUGIN_STATE_DIR: world.state },
        });
        expect(ran.exitCode).toBe(2);
        expect(ran.stderr).toContain("is the user's own state directory");
        expect(ran.stdout).toBe("");
      }),
    ));
});
