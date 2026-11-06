import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { treeRssMib, measureStart } from "../bench/desktop-start/start";
import { world } from "../bench/record-open/world";
import { runEffect } from "./support/effect";

const repo = new URL("../", import.meta.url).pathname;
const Started = Schema.fromJsonString(
  Schema.Struct({ board_usable_ms: Schema.Finite, idle_rss_mib: Schema.Finite }),
);

describe("the Desktop start harness", () => {
  test("sums the RSS of Desktop's process tree, leaving out Collie's bridge and host and what they started", () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const ps = yield* fs.readFileString(`${repo}test/fixtures/desktop-start/ps.txt`);
        // launcher 2100 + main 98000 + GPU 151000 + renderer 180000 + utility 40000 KiB.
        expect(treeRssMib(ps, 4100)).toBe(460.1);
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

  test("refuses to run its host in the user's own state directory", () => {
    const ran = Bun.spawnSync([process.execPath, `${repo}bench/desktop-start/run.ts`], {
      cwd: repo,
      env: { ...Bun.env, HERDR_PLUGIN_STATE_DIR: world.state },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(ran.exitCode).toBe(2);
    expect(ran.stderr.toString()).toContain("is the user's own state directory");
    expect(ran.stdout.toString()).toBe("");
  });
});
