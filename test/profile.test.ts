// What the operator's agent profile may say, and what it becomes at a launch: a pane's
// environment lines and the Claude settings Collie merges into its own.

import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import {
  envFileProblems,
  envLines,
  mergeClaudeSettings,
  parseProfile,
  roleProfile,
} from "../src/profile";
import { parseSetting } from "../src/settings";
import { runEffect } from "./support/effect";

const GITLAB = ["glpat", "synthetic0000000000test"].join("-");

test("an empty profile is no overlay", () => {
  expect(parseProfile("")).toEqual({ profile: {} });
  expect(roleProfile({}, "implementer")).toEqual({});
});

test("a role without its own overlay takes *, and one with its own takes only that", () => {
  const parsed = parseProfile(
    JSON.stringify({ "*": { env: { A: "1" } }, reviewer: { env: { B: "2" } } }),
  );
  if (!("profile" in parsed)) throw new Error(parsed.refused);
  expect(roleProfile(parsed.profile, "implementer")).toEqual({ env: { A: "1" } });
  expect(roleProfile(parsed.profile, "reviewer")).toEqual({ env: { B: "2" } });
});

test("the setting refuses what the profile cannot be, with the reason", () => {
  const refused = (text: string) => {
    const said = parseSetting("agent_profile", text);
    return "refused" in said ? said.refused : "";
  };
  expect(refused("{not json")).toContain("is not JSON");
  expect(refused(JSON.stringify({ "*": { claude: { disableAllHooks: true } } }))).toContain(
    "disableAllHooks would switch off Collie's own hooks",
  );
  expect(refused(JSON.stringify({ "*": { claude: { model: "opus" } } }))).toContain(
    "claude.model is not one Collie merges",
  );
  for (const key of ["autoMode", "permissions"])
    expect(refused(JSON.stringify({ "*": { claude: { [key]: {} } } }))).toContain(
      `claude.${key} is not one Collie merges`,
    );
  expect(refused(JSON.stringify({ "*": { env: { "BAD NAME": "x" } } }))).toContain(
    '"BAD NAME" is not an environment variable name',
  );
  const secret = refused(JSON.stringify({ "*": { env: { DEPLOY: `use ${GITLAB}` } } }));
  expect(secret).toContain("hold it in a 0600 file");
  expect(secret).not.toContain(GITLAB);
  // Stored as the JSON text it was given, so a sync carries it like any other value.
  const text = JSON.stringify({ "*": { env: { PONYTAIL_DEFAULT_MODE: "off" } } });
  expect(parseSetting("agent_profile", text)).toEqual({ value: text });
});

test("a literal is exported and a file is read by the shell, so its value is never typed", () => {
  expect(
    envLines({ PONYTAIL_DEFAULT_MODE: "off", TOKEN: { file: "~/.secrets/token" } }, "/home/me"),
  ).toEqual([
    "export PONYTAIL_DEFAULT_MODE='off'",
    "IFS= read -r TOKEN < '/home/me/.secrets/token'; export TOKEN",
  ]);
});

test("a file-held value is refused by its path and problem: missing, or not 0600", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "profile-" });
      yield* fs.writeFileString(`${home}/ok`, "value\n");
      yield* fs.chmod(`${home}/ok`, 0o600);
      yield* fs.writeFileString(`${home}/open`, "value\n");
      yield* fs.chmod(`${home}/open`, 0o644);
      const problems = yield* envFileProblems(
        { A: { file: "~/ok" }, B: { file: "~/open" }, C: { file: `${home}/gone` }, D: "x" },
        home,
      );
      expect(problems).toEqual([
        `${home}/open is mode 0644, not 0600`,
        `${home}/gone does not exist`,
      ]);
    }).pipe(Effect.scoped),
  ));

test("the overlay merges into Collie's settings, and Collie's own hooks stay", () => {
  const collie = {
    statusLine: { type: "command", command: "collie" },
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "collie" }] }] },
  };
  const guard = { matcher: "Bash", hooks: [{ type: "command", command: "guard" }] };
  expect(
    mergeClaudeSettings(collie, {
      enabledPlugins: { "ponytail@market": false },
      claudeMdExcludes: ["/home/me/.claude/CLAUDE.md"],
      disableClaudeAiConnectors: true,
      hooks: { PreToolUse: [guard], UserPromptSubmit: [guard] },
    }),
  ).toEqual({
    statusLine: collie.statusLine,
    enabledPlugins: { "ponytail@market": false },
    claudeMdExcludes: ["/home/me/.claude/CLAUDE.md"],
    disableClaudeAiConnectors: true,
    hooks: {
      UserPromptSubmit: [...collie.hooks.UserPromptSubmit, guard],
      PreToolUse: [guard],
    },
  });
});
