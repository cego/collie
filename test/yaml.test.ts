import { expect, test } from "bun:test";
import { parseDocument, parseYaml, YamlError } from "../src/yaml";

test("nested maps, sequences of maps and scalars", () => {
  expect(
    parseYaml(`name: implement
max_iterations: 5
inputs:
  plan: plan-file
  ticket: ticket
steps:
  - id: build
    persona: implementer
    fresh: false
  - id: review
    use: review
    parallel:
      - harness: claude
        model: sonnet
      - harness: codex
        model: gpt-5-codex
`),
  ).toEqual({
    name: "implement",
    max_iterations: 5,
    inputs: { plan: "plan-file", ticket: "ticket" },
    steps: [
      { id: "build", persona: "implementer", fresh: false },
      {
        id: "review",
        use: "review",
        parallel: [
          { harness: "claude", model: "sonnet" },
          { harness: "codex", model: "gpt-5-codex" },
        ],
      },
    ],
  });
});

test("flow maps and sequences", () => {
  expect(
    parseYaml(
      `parallel: [{ harness: claude, model: sonnet }, { harness: codex, model: gpt-5 }]\ntags: [a, b]`,
    ),
  ).toEqual({
    parallel: [
      { harness: "claude", model: "sonnet" },
      { harness: "codex", model: "gpt-5" },
    ],
    tags: ["a", "b"],
  });
});

test("sequences may sit at the key's own indent", () => {
  expect(parseYaml(`steps:\n- id: a\n- id: b\n`)).toEqual({ steps: [{ id: "a" }, { id: "b" }] });
});

test("quoted strings keep colons, hashes and booleans verbatim", () => {
  expect(parseYaml(`a: "x: y # z"\nb: 'true'\nc: plain # trailing comment\n`)).toEqual({
    a: "x: y # z",
    b: "true",
    c: "plain",
  });
});

test("block scalars", () => {
  expect(parseYaml(`note: |-\n  first\n  second\nnext: 1\n`)).toEqual({
    note: "first\nsecond",
    next: 1,
  });
});

test("a bad line names its line number", () => {
  expect(() => parseYaml(`a: 1\nnot a mapping\n`)).toThrow(YamlError);
  expect(() => parseYaml(`a: 1\nnot a mapping\n`)).toThrow("line 2");
});

test("frontmatter is split from the markdown body", () => {
  const doc = parseDocument(`---\nname: review\n---\n\n# body\n\nreview {{inputs.target}}\n`);
  expect(doc.data).toEqual({ name: "review" });
  expect(doc.body).toBe("# body\n\nreview {{inputs.target}}");
});

test("a file with no frontmatter is all body", () => {
  expect(parseDocument("just text")).toEqual({ data: {}, body: "just text" });
});

test("a misaligned line is an error, not a silent truncation", () => {
  expect(() => parseYaml(`name: implement\n max_iterations: 5\ninputs:\n  plan: p\n`)).toThrow(
    "line 2",
  );
  expect(() => parseYaml(`steps:\n  - id: a\n   - id: b\n`)).toThrow(YamlError);
});
