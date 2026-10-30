// Each harness's catalogue decoded from what it answered on vm-mk on 29 Oct 2026.

import * as Arr from "effect/Array";
import { describe, expect, test } from "bun:test";
import { Option, Schema, flow, Result } from "effect";
import {
  ClaudeModels,
  claudeEntries,
  CodexModelList,
  codexEntries,
  opencodeEntries,
  piEntries,
  withAdded,
} from "../src/catalogue-model";
import claudeModels from "./fixtures/catalogue/claude-supported-models.json";
import codexModelList from "./fixtures/catalogue/codex-model-list.json";

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/catalogue/${name}`).text();
const piList = await fixture("pi-list-models.txt");
const opencodeList = await fixture("opencode-models.txt");

test("explicitly adding a hidden model exposes it without losing its reported capabilities", () => {
  const catalogue = {
    harness: "codex",
    at: "2026-10-29T12:00:00Z",
    table: null,
    entries: codexEntries(
      flow(Schema.decodeResult(CodexModelList), Result.getOrThrow)(codexModelList),
    ),
  };
  const hidden = Option.getOrUndefined(
    Arr.findFirst(catalogue.entries, ({ model }) => model === "gpt-reserve"),
  )!;
  const added = withAdded(catalogue, ["gpt-reserve"]);
  expect(
    Option.getOrUndefined(Arr.findFirst(added.entries, ({ model }) => model === "gpt-reserve")),
  ).toEqual({
    ...hidden,
    hidden: false,
    from: "added",
  });
  expect(added.entries).toHaveLength(catalogue.entries.length);
  expect(
    Option.getOrUndefined(Arr.findFirst(catalogue.entries, ({ model }) => model === "gpt-reserve"))
      ?.hidden,
  ).toBe(true);
});

describe("decoding each harness's own list", () => {
  test("Claude Code's supportedModels(), without its `default`", () => {
    const entries = claudeEntries(
      flow(Schema.decodeResult(ClaudeModels), Result.getOrThrow)(claudeModels),
    );
    expect(Arr.map(entries, (entry) => entry.model)).toEqual([
      "opus",
      "fable",
      "sonnet",
      "haiku",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-mythos-5-1",
    ]);
    expect(entries[0]).toEqual({
      model: "opus",
      label: "Opus 5.5",
      description: "For complex work and everyday tasks",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: null,
      hidden: false,
      from: "harness",
    });
    expect(
      Option.getOrUndefined(Arr.findFirst(entries, (entry) => entry.model === "claude-opus-4-6"))
        ?.efforts,
    ).toEqual(["low", "medium", "high", "max"]);
    expect(
      Option.getOrUndefined(
        Arr.findFirst(entries, (entry) => entry.model === "claude-haiku-4-5-20251001"),
      ),
    ).toMatchObject({
      label: "Haiku 4.5",
      efforts: [],
    });
    expect(
      Option.getOrUndefined(Arr.findFirst(entries, (entry) => entry.model === "claude-mythos-5-1"))
        ?.description,
    ).toBeNull();
  });

  test("Codex's model/list, hidden models marked hidden", () => {
    const entries = codexEntries(
      flow(Schema.decodeResult(CodexModelList), Result.getOrThrow)(codexModelList),
    );
    expect(Arr.map(entries, ({ model, hidden }) => [model, hidden])).toEqual([
      ["gpt-6.1-sol", false],
      ["gpt-6.1-terra", false],
      ["gpt-6-astra", false],
      ["gpt-6-sol", false],
      ["gpt-reserve", true],
      ["gpt-6-luna", false],
      ["gpt-5.6-sol", false],
      ["gpt-5.6-terra", false],
      ["gpt-5.6-luna", false],
      ["codex-auto-review", true],
    ]);
    expect(entries[0]).toEqual({
      model: "gpt-6.1-sol",
      isDefault: true,
      label: "GPT-6.1-Sol",
      description: "Latest workhorse model for coding and everyday work.",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultEffort: "medium",
      hidden: false,
      from: "harness",
    });
    expect(
      Option.getOrUndefined(Arr.findFirst(entries, (entry) => entry.model === "gpt-6.1-terra"))
        ?.defaultEffort,
    ).toBe("low");
    expect(
      Option.getOrUndefined(Arr.findFirst(entries, (entry) => entry.model === "gpt-6-luna"))
        ?.efforts,
    ).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("Pi's --list-models, a model that does not think offering no effort", () => {
    const entries = piEntries(piList) ?? [];
    expect(Arr.map(entries, (entry) => entry.model)).toEqual([
      "ollama/gpt-oss:20b",
      "ollama/qwen3-coder:30b",
      "openai-codex/gpt-5.6-luna",
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-5.6-terra",
      "openai-codex/gpt-6-astra",
      "openai-codex/gpt-6-luna",
      "openai-codex/gpt-6-sol",
      "openai-codex/gpt-6.1-sol",
    ]);
    expect(
      Option.getOrUndefined(
        Arr.findFirst(entries, (entry) => entry.model === "ollama/qwen3-coder:30b"),
      ),
    ).toEqual({
      model: "ollama/qwen3-coder:30b",
      label: "qwen3-coder:30b",
      description: null,
      efforts: [],
      defaultEffort: null,
      hidden: false,
      from: "harness",
    });
    expect(
      Option.getOrUndefined(
        Arr.findFirst(entries, (entry) => entry.model === "openai-codex/gpt-6.1-sol"),
      )?.efforts,
    ).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  test("OpenCode's models, every one with no effort", () => {
    const entries = opencodeEntries(opencodeList) ?? [];
    expect(entries).toHaveLength(106);
    expect(
      Option.getOrUndefined(
        Arr.findFirst(entries, (entry) => entry.model === "opencode/claude-fable-5"),
      ),
    ).toEqual({
      model: "opencode/claude-fable-5",
      label: "claude-fable-5",
      description: null,
      efforts: [],
      defaultEffort: null,
      hidden: false,
      from: "harness",
    });
    expect(Arr.some(entries, (entry) => entry.model === "openai/gpt-5.4-mini-flex")).toBe(true);
    expect(Arr.filter(entries, (entry) => entry.efforts.length > 0)).toEqual([]);
  });

  test("an answer in a shape Collie does not read decodes to nothing", () => {
    expect(Option.isNone(Schema.decodeUnknownOption(ClaudeModels)({ models: "opus" }))).toBe(true);
    expect(Option.isNone(Schema.decodeUnknownOption(CodexModelList)([{ id: "gpt-6" }]))).toBe(true);
    expect(piEntries("Error: no providers configured\n")).toBeNull();
    expect(opencodeEntries("Error: not logged in\n")).toBeNull();
  });
});
