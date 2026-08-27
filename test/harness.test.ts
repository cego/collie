import { expect, test } from "bun:test";
import { HARNESSES, knownModel, personaPrefix, startArgs } from "../src/harness";

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
