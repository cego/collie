import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import {
  claudeForbidsBypass,
  foldPreferences,
  resolveChoice,
  DEFAULT_MODEL,
  HARNESSES,
  knownModel,
  modelHint,
  personaPrefix,
  startArgs,
} from "../src/harness";
import { renderTemplate, skillMention, skillsIn } from "../src/template";
import { runEffect } from "./support/effect";

test("the adapter table covers claude, codex and opencode with model flags", () => {
  expect(HARNESSES.claude!.modelArgs("sonnet")).toEqual(["--model", "sonnet"]);
  expect(HARNESSES.codex!.modelArgs("gpt-5-codex")).toEqual(["-m", "gpt-5-codex"]);
  expect(HARNESSES.opencode!.modelArgs("anthropic/claude-sonnet-4")).toEqual([
    "--model",
    "anthropic/claude-sonnet-4",
  ]);
});

test("a persona goes in as a file flag where the harness has one, else as a prompt prefix", () => {
  expect(
    startArgs(HARNESSES.claude!, "sonnet", "/run/personas/reviewer.md", undefined, "harness"),
  ).toEqual(["--model", "sonnet", "--append-system-prompt-file", "/run/personas/reviewer.md"]);
  expect(personaPrefix(HARNESSES.claude!, "You review.")).toBe("");

  expect(
    startArgs(HARNESSES.codex!, "gpt-5", "/run/personas/reviewer.md", undefined, "harness"),
  ).toEqual(["-m", "gpt-5"]);
  expect(personaPrefix(HARNESSES.codex!, "You review.")).toBe("You review.");
});

test("model checks accept the alias list, the harness pattern and user extras", () => {
  expect(knownModel(HARNESSES.claude!, "sonnet")).toBe(true);
  expect(knownModel(HARNESSES.claude!, "fable")).toBe(true);
  expect(knownModel(HARNESSES.claude!, "claude-opus-5")).toBe(true);
  expect(knownModel(HARNESSES.claude!, "gpt-5")).toBe(false);
  expect(knownModel(HARNESSES.opencode!, "sonnet")).toBe(false);
  expect(knownModel(HARNESSES.opencode!, "anthropic/claude-sonnet-4")).toBe(true);
  expect(knownModel(HARNESSES.opencode!, "sonnet", ["sonnet"])).toBe(true);
  for (const model of ["gpt-6.1-sol", "gpt-5.6-sol", "gpt5", "o3"])
    expect(knownModel(HARNESSES.codex!, model)).toBe(true);
  for (const model of ["gpt-sol", "o-3", "gpt-6.1-sol --flag", "anthropic/opus"])
    expect(knownModel(HARNESSES.codex!, model)).toBe(false);
});

test("effort flags follow the harness's launch interface", () => {
  expect(startArgs(HARNESSES.claude!, "opus", "/p/reviewer.md", "xhigh", "harness")).toEqual([
    "--model",
    "opus",
    "--effort",
    "xhigh",
    "--append-system-prompt-file",
    "/p/reviewer.md",
  ]);

  expect("effortArgs" in HARNESSES.codex!).toBe(false);
  expect(startArgs(HARNESSES.codex!, "gpt-5", "/p/reviewer.md", "xhigh", "harness")).toEqual([
    "-m",
    "gpt-5",
  ]);
});

test("Codex's accepted effort reaches both its App Server and TUI configuration", () => {
  const wired = HARNESSES.codex!.mcp({
    command: ["/bin/collie"],
    env: {},
    config: "/mcp.json",
    extension: "/tools.ts",
    effort: "high",
  });
  expect(wired.args).toEqual(expect.arrayContaining(["-c", 'model_reasoning_effort="high"']));
});

test("`default` pins Claude to Opus while other harnesses keep their native default", () => {
  for (const harness of Object.values(HARNESSES)) {
    expect(knownModel(harness, DEFAULT_MODEL)).toBe(true);
    expect(modelHint(harness)).toContain(DEFAULT_MODEL);
  }

  expect(
    startArgs(HARNESSES.claude!, DEFAULT_MODEL, "/p/implementer.md", "medium", "harness"),
  ).toEqual([
    "--model",
    "opus",
    "--effort",
    "medium",
    "--append-system-prompt-file",
    "/p/implementer.md",
  ]);
  expect(
    startArgs(HARNESSES.codex!, DEFAULT_MODEL, "/p/implementer.md", undefined, "harness"),
  ).toEqual([]);
  expect(
    startArgs(HARNESSES.opencode!, DEFAULT_MODEL, "/p/implementer.md", undefined, "harness"),
  ).toEqual([]);
});

test("pi takes a provider-qualified model, a thinking level and the persona file directly", () => {
  expect(knownModel(HARNESSES.pi!, "openai-codex/gpt-5.6-sol")).toBe(true);
  expect(knownModel(HARNESSES.pi!, "gpt-5.6-sol")).toBe(false);
  expect(
    startArgs(HARNESSES.pi!, "openai-codex/gpt-5.6-sol", "/run/personas/reviewer.md", "medium"),
  ).toEqual([
    "--model",
    "openai-codex/gpt-5.6-sol",
    "--thinking",
    "medium",
    "--append-system-prompt",
    "/run/personas/reviewer.md",
  ]);
  expect(personaPrefix(HARNESSES.pi!, "You review.")).toBe("");
});

test("a skill is started in each harness's own syntax", () => {
  // The skills are shared — one ~/.agents/skills for every harness — so only the
  // way the human channel starts one differs.
  expect(HARNESSES.claude!.skillCommand("code-review")).toBe("/code-review");
  expect(HARNESSES.pi!.skillCommand("code-review")).toBe("/skill:code-review");
  // No slash form at all: these surface skills to the model by description, so a
  // slash would be sent as literal text and do nothing.
  expect(HARNESSES.codex!.skillCommand("code-review")).toBe('the "code-review" skill');
  expect(HARNESSES.opencode!.skillCommand("code-review")).toBe('the "code-review" skill');
  // Every harness in the table answers, so a definition can never name one that cannot.
  for (const adapter of Object.values(HARNESSES)) {
    expect(adapter.skillCommand("tdd")).toContain("tdd");
  }
});

test("a body names a skill and every harness is pointed at the same file", () => {
  const body = "Run {{skill:code-review}} then {{skill:tdd}}, and {{skill:code-review}} again.";

  expect(skillsIn(body)).toEqual(["code-review", "tdd"]);
  // A mention is what the agent reads, and a path is not harness-specific: nothing
  // expands a slash command inside a file a model is handed.
  const mention = skillMention(new Map([["code-review", "/skills/code-review/SKILL.md"]]));
  expect(renderTemplate(body, {}, { skill: mention }).text).toBe(
    "Run the `code-review` skill (read `/skills/code-review/SKILL.md` and follow it) then " +
      "the `tdd` skill (not installed here), and the `code-review` skill " +
      "(read `/skills/code-review/SKILL.md` and follow it) again.",
  );

  // A skill reference is not a missing variable, and is left alone with no renderer.
  const plain = renderTemplate("{{skill:tdd}} and {{inputs.goal}}", { inputs: { goal: "g" } });
  expect(plain.missing).toEqual([]);
  expect(plain.text).toBe("{{skill:tdd}} and g");
});

test("every harness starts in its auto mode, and past its prompts only when bypass is asked for", () => {
  // The permission switch comes last, after everything `harness` passes too.
  const permissionsOf = (adapter: string, model: string, mode?: "auto" | "bypass") => {
    const plain = startArgs(HARNESSES[adapter]!, model, "/p/i.md", undefined, "harness");
    return startArgs(HARNESSES[adapter]!, model, "/p/i.md", undefined, mode).slice(plain.length);
  };

  expect(permissionsOf("claude", "opus")).toEqual(["--permission-mode", "auto"]);
  expect(permissionsOf("claude", "opus", "bypass")).toEqual([
    "--permission-mode",
    "bypassPermissions",
  ]);
  expect(permissionsOf("codex", "gpt-5")).toEqual(["--approve-for-me"]);
  expect(permissionsOf("codex", "gpt-5", "bypass")).toEqual([
    "--dangerously-bypass-approvals-and-sandbox",
  ]);
  // opencode's `--auto` approves every call rather than reviewing it, so it has no auto mode.
  expect(permissionsOf("opencode", "anthropic/claude-sonnet-4")).toEqual([]);
  expect(permissionsOf("opencode", "anthropic/claude-sonnet-4", "bypass")).toEqual(["--auto"]);
  // pi has no tool-approval prompt, so every mode is the same start.
  for (const mode of ["auto", "bypass"] as const)
    expect(permissionsOf("pi", "openai-codex/gpt-5.6-sol", mode)).toEqual([]);

  // `harness` passes no switch at all, whichever harness a step names.
  for (const adapter of Object.values(HARNESSES)) {
    const asked = startArgs(adapter, DEFAULT_MODEL, "/p/i.md", undefined, "harness");
    for (const flag of [
      "--permission-mode",
      "--approve-for-me",
      "--dangerously-bypass-approvals-and-sandbox",
      "--auto",
    ])
      expect(asked).not.toContain(flag);
  }
});

test("Claude Code alone is given its auto-compact window, after everything else it is started with", () => {
  expect(startArgs(HARNESSES.claude!, "opus", "/p/i.md", "high", "auto", 400000)).toEqual([
    "--model",
    "opus",
    "--effort",
    "high",
    "--append-system-prompt-file",
    "/p/i.md",
    "--permission-mode",
    "auto",
    "--autocompact",
    "400000",
  ]);
  expect(startArgs(HARNESSES.claude!, "opus", "/p/i.md", undefined, "harness", "auto")).toEqual([
    "--model",
    "opus",
    "--append-system-prompt-file",
    "/p/i.md",
    "--autocompact",
    "auto",
  ]);
  expect(startArgs(HARNESSES.codex!, "gpt-5", "/p/i.md", undefined, "auto", 400000)).toEqual([
    "-m",
    "gpt-5",
    "--approve-for-me",
  ]);
  for (const adapter of ["codex", "opencode", "pi"])
    expect(HARNESSES[adapter]!.autoCompactFlag).toBeUndefined();
});

test("Claude Code's managed settings forbid bypass where the file or a drop-in disables it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const managed = yield* fs.makeTempDirectoryScoped();
      const forbidden = () => claudeForbidsBypass(`${managed}/claude-code`);

      expect(yield* forbidden()).toBe(false);

      yield* fs.makeDirectory(`${managed}/claude-code/managed-settings.d`, {
        recursive: true,
      });
      yield* fs.writeFileString(
        `${managed}/claude-code/managed-settings.json`,
        `{ "permissions": { "deny": ["WebFetch"] }, "env": {} }`,
      );
      yield* fs.writeFileString(`${managed}/claude-code/managed-settings.d/10-broken.json`, "{");
      expect(yield* forbidden()).toBe(false);

      yield* fs.writeFileString(
        `${managed}/claude-code/managed-settings.d/20-org.json`,
        `{ "permissions": { "disableBypassPermissionsMode": "disable" } }`,
      );
      expect(yield* forbidden()).toBe(true);
    }).pipe(Effect.scoped),
  ));

const configured = { harness: "claude", model: "opus", effort: "high" };

test("the agent is decided layer over layer, and the nearest one that names a field wins", () => {
  expect(resolveChoice([configured, { model: "sonnet" }, undefined, { effort: "low" }])).toEqual({
    ok: true,
    choice: { harness: "claude", model: "sonnet", effort: "low" },
  });
  expect(resolveChoice([configured])).toEqual({
    ok: true,
    choice: { harness: "claude", model: "opus", effort: "high" },
  });
});

test("switching harness keeps nothing chosen for the one below, and falls back to its default", () => {
  // Opus and a high effort were Claude's; codex takes neither, so neither comes along.
  expect(resolveChoice([configured, { harness: "codex" }])).toEqual({
    ok: true,
    choice: { harness: "codex", model: "default", effort: null },
  });
  expect(resolveChoice([configured, { harness: "codex", model: "gpt-5" }])).toEqual({
    ok: true,
    choice: { harness: "codex", model: "gpt-5", effort: null },
  });
  // Naming the harness already in force is not a switch.
  expect(resolveChoice([configured, { harness: "claude" }])).toEqual({
    ok: true,
    choice: { harness: "claude", model: "opus", effort: "high" },
  });
});

test("a native default takes an effort reported by any model until the harness identifies its default", () => {
  const catalogue = {
    machine: "vm-gpu",
    harnesses: [
      {
        harness: "codex",
        table: null,
        entries: [
          { model: "new-fast", efforts: ["low"] },
          { model: "new-deep", efforts: ["high"] },
        ],
      },
    ],
  };
  expect(resolveChoice([{ harness: "codex", effort: "high" }], {}, catalogue)).toMatchObject({
    ok: true,
    choice: { model: "default", effort: "high" },
  });
  expect(resolveChoice([{ harness: "codex", effort: "ultra" }], {}, catalogue).ok).toBe(false);
  const identified = {
    ...catalogue,
    harnesses: [
      {
        ...catalogue.harnesses[0]!,
        entries: [
          { model: "new-fast", efforts: ["low"], isDefault: true },
          { model: "new-deep", efforts: ["high"] },
        ],
      },
    ],
  };
  expect(resolveChoice([{ harness: "codex", effort: "high" }], {}, identified).ok).toBe(false);
  expect(resolveChoice([{ harness: "codex", effort: "low" }], {}, identified)).toMatchObject({
    ok: true,
  });
});

test("a combination no harness takes is refused with what would be taken instead", () => {
  const model = resolveChoice([configured, { model: "gpt-5" }]);
  expect(model.ok).toBe(false);
  expect(!model.ok && model.problem).toContain('"gpt-5" is not a model claude takes');
  expect(!model.ok && model.problem).toContain("sonnet");

  const effort = resolveChoice([configured, { harness: "codex", effort: "high" }]);
  expect(!effort.ok && effort.problem).toContain("codex takes no effort");

  const harness = resolveChoice([configured, { harness: "gemini" }]);
  expect(!harness.ok && harness.problem).toContain('no harness called "gemini"');

  // A model the operator added for a harness is one it takes.
  expect(
    resolveChoice([configured, { model: "claude-next" }], { claude: ["claude-next"] }).ok,
  ).toBe(true);
});

test("preferences fold the same way without a harness to check them against", () => {
  expect(foldPreferences([{ harness: "claude", model: "opus" }, { harness: "codex" }])).toEqual({
    harness: "codex",
  });
  expect(foldPreferences([{ model: "opus" }, undefined, { effort: "low" }])).toEqual({
    model: "opus",
    effort: "low",
  });
});

test("each harness wires the whole Collie Toolkit with its Run and agent environment", () => {
  const launch = {
    command: ["/bin/collie"],
    env: { COLLIE_RUN: "run-source", COLLIE_AGENT: "source-agent" },
    config: "/run/mcp.json",
    extension: "/run/collie-tools.ts",
  };
  for (const id of ["claude", "codex", "pi", "opencode"]) {
    const wired = HARNESSES[id]!.mcp(launch);
    expect(wired.args.length + Object.keys(wired.env).length).toBeGreaterThan(0);
    if (id === "claude") expect(wired.args).toEqual(["--mcp-config", launch.config]);
    if (id === "pi") expect(wired.args).toEqual(["-e", launch.extension]);
    if (id === "codex") {
      expect(wired.args).toContain('mcp_servers.collie.command="/bin/collie"');
      expect(wired.args).toContain('mcp_servers.collie.env.COLLIE_RUN="run-source"');
      expect(wired.args).toContain('mcp_servers.collie.env.COLLIE_AGENT="source-agent"');
    }
    if (id === "opencode")
      expect(JSON.parse(wired.env.OPENCODE_CONFIG_CONTENT!).mcp.collie).toEqual({
        type: "local",
        command: ["/bin/collie", "mcp"],
        environment: launch.env,
        enabled: true,
      });
  }
});

test("OpenCode keeps the launch's existing settings and other MCP servers", () => {
  const wired = HARNESSES.opencode!.mcp({
    command: ["collie"],
    env: { COLLIE_RUN: "run-source", COLLIE_AGENT: "source-agent" },
    config: "",
    extension: "",
    settings: {
      theme: "dark",
      mcp: {
        other: { type: "remote", url: "https://example.test/mcp" },
        collie: { enabled: false },
      },
    },
  });
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))(
      wired.env.OPENCODE_CONFIG_CONTENT!,
    ),
  ).toMatchObject({
    theme: "dark",
    mcp: { other: { url: "https://example.test/mcp" }, collie: { enabled: true } },
  });
});
