import { expect, test } from "bun:test";
import {
  DEFAULT_MODEL,
  HARNESSES,
  knownModel,
  modelHint,
  personaPrefix,
  startArgs,
} from "../src/harness";
import { renderTemplate, skillMention, skillsIn } from "../src/template";

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
  expect(knownModel(HARNESSES.claude!, "claude-opus-5")).toBe(true);
  expect(knownModel(HARNESSES.claude!, "gpt-5")).toBe(false);
  expect(knownModel(HARNESSES.opencode!, "sonnet")).toBe(false);
  expect(knownModel(HARNESSES.opencode!, "anthropic/claude-sonnet-4")).toBe(true);
  expect(knownModel(HARNESSES.opencode!, "sonnet", ["sonnet"])).toBe(true);
});

test("effort is a flag only where the harness has one", () => {
  expect(startArgs(HARNESSES.claude!, "opus", "/p/reviewer.md", "xhigh", "harness")).toEqual([
    "--model",
    "opus",
    "--effort",
    "xhigh",
    "--append-system-prompt-file",
    "/p/reviewer.md",
  ]);
  expect(HARNESSES.claude!.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);

  // codex and opencode have none, so asking for one is a validation error, not a flag.
  expect("effortArgs" in HARNESSES.codex!).toBe(false);
  expect(startArgs(HARNESSES.codex!, "gpt-5", "/p/reviewer.md", "xhigh", "harness")).toEqual([
    "-m",
    "gpt-5",
  ]);
});

test("`default` pins Claude to Opus while other harnesses keep their native default", () => {
  for (const harness of Object.values(HARNESSES)) {
    expect(knownModel(harness, DEFAULT_MODEL)).toBe(true);
    expect(modelHint(harness)).toContain(DEFAULT_MODEL);
  }

  expect(HARNESSES.claude!.defaultModel).toBe("opus");
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

test("every harness that prompts is started with its unattended switch, unless `harness`", () => {
  expect(startArgs(HARNESSES.claude!, "opus", "/p/i.md")).toEqual([
    "--model",
    "opus",
    "--append-system-prompt-file",
    "/p/i.md",
    "--permission-mode",
    "bypassPermissions",
  ]);
  expect(startArgs(HARNESSES.codex!, "gpt-5", "/p/i.md")).toEqual([
    "-m",
    "gpt-5",
    "--dangerously-bypass-approvals-and-sandbox",
  ]);
  expect(startArgs(HARNESSES.opencode!, "anthropic/claude-sonnet-4", "/p/i.md")).toEqual([
    "--model",
    "anthropic/claude-sonnet-4",
    "--auto",
  ]);
  // pi has no tool-approval prompt, so bypass is the same start as `harness`.
  expect(startArgs(HARNESSES.pi!, "openai-codex/gpt-5.6-sol", "/p/i.md")).toEqual(
    startArgs(HARNESSES.pi!, "openai-codex/gpt-5.6-sol", "/p/i.md", undefined, "harness"),
  );

  // Whichever harness a step names, `harness` passes none of the switches above.
  for (const adapter of Object.values(HARNESSES)) {
    const asked = startArgs(adapter, DEFAULT_MODEL, "/p/i.md", undefined, "harness");
    for (const flag of [
      "--permission-mode",
      "--dangerously-bypass-approvals-and-sandbox",
      "--auto",
    ])
      expect(asked).not.toContain(flag);
  }
});
