import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Rig } from "./support/recorder";
import { claudeTrust } from "../src/trust";
import { trustFlow } from "../src/flows";

let rig: Rig;

beforeEach(() => {
  rig = new Rig();
});

afterEach(async () => {
  await rig.close();
});

/** A ~/.claude.json with the shape claude actually writes. */
function claudeConfig(projects: Record<string, unknown>): string {
  const path = join(rig.root, ".claude.json");
  writeFileSync(
    path,
    JSON.stringify({ installMethod: "native", numStartups: 12, projects }, null, 2),
  );
  return path;
}

const trust = () => claudeTrust(rig.root, rig.stateDir);

test("a directory claude has never seen is untrusted; one with the flag is trusted", () => {
  claudeConfig({
    [rig.projectDir]: { mcpServers: {}, hasTrustDialogAccepted: true },
    "/somewhere/else": { mcpServers: {} },
  });

  expect(trust().state(rig.projectDir)).toBe("trusted");
  expect(trust().state("/somewhere/else")).toBe("untrusted");
  expect(trust().state("/never/seen")).toBe("untrusted");
});

test("no claude config at all is unknown, not untrusted — there is nothing to write into", () => {
  expect(trust().state(rig.projectDir)).toBe("unknown");
  expect(trust().grant(rig.projectDir).ok).toBe(false);
  expect(trust().grant(rig.projectDir).message).toContain("has not run on this machine");
  expect(existsSync(join(rig.root, ".claude.json"))).toBe(false);
});

test("granting adds the flag and leaves every other project and setting alone", () => {
  const path = claudeConfig({
    "/other/repo": { mcpServers: { local: { command: "x" } }, lastCost: 1.5 },
  });

  const result = trust().grant(rig.projectDir);

  expect(result.ok).toBe(true);
  expect(result.message).toContain(rig.projectDir);
  const after = JSON.parse(readFileSync(path, "utf8"));
  expect(after.projects[rig.projectDir]).toEqual({ mcpServers: {}, hasTrustDialogAccepted: true });
  expect(after.projects["/other/repo"]).toEqual({ mcpServers: { local: { command: "x" } }, lastCost: 1.5 });
  expect(after.installMethod).toBe("native");
  expect(after.numStartups).toBe(12);
  expect(trust().state(rig.projectDir)).toBe("trusted");
});

test("granting keeps the rest of an existing entry and is idempotent", () => {
  const path = claudeConfig({ [rig.projectDir]: { mcpServers: {}, lastCost: 2, allowedTools: ["Bash"] } });

  expect(trust().grant(rig.projectDir).ok).toBe(true);
  const after = JSON.parse(readFileSync(path, "utf8"));
  expect(after.projects[rig.projectDir]).toEqual({
    mcpServers: {},
    lastCost: 2,
    allowedTools: ["Bash"],
    hasTrustDialogAccepted: true,
  });

  const again = trust().grant(rig.projectDir);
  expect(again.ok).toBe(true);
  expect(again.message).toContain("already");
});

test("the file it overwrites is kept, because it is not ours", () => {
  const path = claudeConfig({ "/other/repo": { mcpServers: {} } });
  const before = readFileSync(path, "utf8");

  trust().grant(rig.projectDir);

  expect(readFileSync(join(rig.stateDir, "claude.json.bak"), "utf8")).toBe(before);
});

test("a cwd that reaches the same place through a symlink is trusted both ways", () => {
  claudeConfig({});
  const real = join(rig.root, "real-repo");
  const link = join(rig.root, "linked-repo");
  mkdirSync(real, { recursive: true });
  symlinkSync(real, link);

  expect(trust().grant(link).ok).toBe(true);

  expect(trust().state(link)).toBe("trusted");
  expect(trust().state(real)).toBe("trusted");
});

test("a config that is not JSON is left exactly as it is", () => {
  const path = join(rig.root, ".claude.json");
  writeFileSync(path, "{ not json");

  expect(trust().state(rig.projectDir)).toBe("unknown");
  expect(trust().grant(rig.projectDir).ok).toBe(false);
  expect(readFileSync(path, "utf8")).toBe("{ not json");
});

test("the trust subcommand records a directory before anyone runs in it", () => {
  claudeConfig({});
  const lines: string[] = [];

  const code = trustFlow(rig.pluginEnv(), [rig.projectDir, "/no/such/dir"], (l) => lines.push(l));

  expect(code).toBe(1);
  expect(lines).toEqual([
    `claude: trusted ${rig.projectDir} for claude (previous config saved to ${join(rig.stateDir, "claude.json.bak")})`,
    "/no/such/dir: no such directory",
  ]);
  expect(claudeTrust(rig.root, rig.stateDir).state(rig.projectDir)).toBe("trusted");

  // With no directory given it takes the one the plugin was invoked in.
  lines.length = 0;
  expect(trustFlow(rig.pluginEnv(), [], (l) => lines.push(l))).toBe(0);
  expect(lines).toEqual([`claude: ${rig.projectDir} is already trusted`]);
});
