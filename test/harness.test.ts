import { expect, test } from "bun:test";
import { DEFAULT_MODEL, HARNESSES, knownModel, modelHint, personaPrefix, startArgs } from "../src/harness";

test("the adapter table covers claude, codex and opencode with model flags", () => {
  expect(HARNESSES.claude!.modelArgs("sonnet")).toEqual(["--model", "sonnet"]);
  expect(HARNESSES.codex!.modelArgs("gpt-5-codex")).toEqual(["-m", "gpt-5-codex"]);
  expect(HARNESSES.opencode!.modelArgs("anthropic/claude-sonnet-4")).toEqual([
    "--model",
    "anthropic/claude-sonnet-4",
  ]);
});

test("a persona goes in as a file flag where the harness has one, else as a prompt prefix", () => {
  expect(startArgs(HARNESSES.claude!, "sonnet", "/run/personas/reviewer.md")).toEqual([
    "--model",
    "sonnet",
    "--append-system-prompt-file",
    "/run/personas/reviewer.md",
  ]);
  expect(personaPrefix(HARNESSES.claude!, "You review.")).toBe("");

  expect(startArgs(HARNESSES.codex!, "gpt-5", "/run/personas/reviewer.md")).toEqual(["-m", "gpt-5"]);
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
  expect(startArgs(HARNESSES.claude!, "opus", "/p/reviewer.md", "xhigh")).toEqual([
    "--model",
    "opus",
    "--effort",
    "xhigh",
    "--append-system-prompt-file",
    "/p/reviewer.md",
  ]);
  expect(HARNESSES.claude!.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);

  // codex and opencode have none, so asking for one is a validation error, not a flag.
  expect(HARNESSES.codex!.effortArgs).toBeUndefined();
  expect(startArgs(HARNESSES.codex!, "gpt-5", "/p/reviewer.md", "xhigh")).toEqual(["-m", "gpt-5"]);
});

test("`default` is a model every harness takes, and it means no model flag at all", () => {
  for (const harness of Object.values(HARNESSES)) {
    expect(knownModel(harness, DEFAULT_MODEL)).toBe(true);
    expect(modelHint(harness)).toContain(DEFAULT_MODEL);
  }

  // Everything else about the start still applies: only the model args are gone.
  expect(startArgs(HARNESSES.claude!, DEFAULT_MODEL, "/p/implementer.md", "medium")).toEqual([
    "--effort",
    "medium",
    "--append-system-prompt-file",
    "/p/implementer.md",
  ]);
  expect(startArgs(HARNESSES.codex!, DEFAULT_MODEL, "/p/implementer.md")).toEqual([]);
  expect(startArgs(HARNESSES.opencode!, DEFAULT_MODEL, "/p/implementer.md")).toEqual([]);
});

test("pi takes a provider-qualified model, a thinking level and the persona file directly", () => {
  expect(knownModel(HARNESSES.pi!, "openai-codex/gpt-5.6-sol")).toBe(true);
  expect(knownModel(HARNESSES.pi!, "gpt-5.6-sol")).toBe(false);
  expect(startArgs(HARNESSES.pi!, "openai-codex/gpt-5.6-sol", "/run/personas/reviewer.md", "medium")).toEqual([
    "--model",
    "openai-codex/gpt-5.6-sol",
    "--thinking",
    "medium",
    "--append-system-prompt",
    "/run/personas/reviewer.md",
  ]);
  expect(personaPrefix(HARNESSES.pi!, "You review.")).toBe("");
});
