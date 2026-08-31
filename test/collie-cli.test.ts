import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;

async function cli(args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "collie-cli-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  const proc = Bun.spawn(["bun", join(root, "src/main.ts"), ...args], {
    cwd: root,
    env: {
      ...process.env,
      HERDR_PLUGIN_ROOT: root,
      HERDR_PLUGIN_CONFIG_DIR: join(dir, "config"),
      HERDR_PLUGIN_STATE_DIR: join(dir, "state"),
      HOME: dir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  rmSync(dir, { recursive: true, force: true });
  return { stdout, stderr, exit };
}

test("public JSON discovery has one typed envelope", async () => {
  const listed = await cli(["--json", "workflow", "list"]);
  expect(listed.exit).toBe(0);
  expect(listed.stderr).toBe("");
  expect(JSON.parse(listed.stdout)).toMatchObject({ ok: true, data: { workflows: expect.any(Array) } });

  const missing = await cli(["--json", "workflow", "show", "__missing__"]);
  expect(missing.exit).toBe(1);
  expect(missing.stderr).toBe("");
  expect(JSON.parse(missing.stdout)).toMatchObject({
    ok: false,
    error: { code: "workflow_not_found", details: {} },
  });
});

test("persona discovery uses the same command boundary", async () => {
  const result = await cli(["--json", "persona", "list"]);
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: { personas: expect.any(Array) } });
});
