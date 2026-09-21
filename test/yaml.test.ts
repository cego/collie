import { expect, test } from "bun:test";
import { parseDocument, parseYaml, setFrontmatterKey, YamlError } from "../src/yaml";

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

test("a sequence in its key's own column is that key's sequence, one item or many", () => {
  expect(parseYaml(`steps:\n- id: a\n`)).toEqual({ steps: [{ id: "a" }] });
  expect(parseYaml(`steps:\n- id: a\n- id: b\n`)).toEqual({ steps: [{ id: "a" }, { id: "b" }] });
  expect(parseYaml(`steps:\n  - id: a\n`)).toEqual({ steps: [{ id: "a" }] });
});

test("a key written quoted may begin with a dash", () => {
  expect(parseYaml(`"- id": allowed\n`)).toEqual({ "- id": "allowed" });
  // Even beside a sequence whose items read the same once the indent is gone.
  expect(parseYaml(`"- id": x\nsteps:\n  - id: a\n`)).toEqual({
    "- id": "x",
    steps: [{ id: "a" }],
  });
});

test("a dash line inside a block scalar is text, not a misplaced sequence", () => {
  expect(parseYaml(`description: |\n  steps:\n  - id: a\nname: p\n`)).toEqual({
    description: "steps:\n- id: a\n",
    name: "p",
  });
});

test("a nested sequence in its key's own column is that key's sequence", () => {
  expect(parseYaml(`outer:\n  steps:\n  - id: a\n`)).toEqual({ outer: { steps: [{ id: "a" }] } });
});

test("a key set twice is an error rather than the last one winning", () => {
  expect(() => parseYaml(`a: 1\na: 2\n`)).toThrow(YamlError);
});

test("anchors and aliases are resolved", () => {
  expect(parseYaml(`base: &b { harness: claude }\nstep: *b\n`)).toEqual({
    base: { harness: "claude" },
    step: { harness: "claude" },
  });
});

test("date-like scalars stay strings", () => {
  expect(parseYaml(`forked_from_hash: 2026-09-02\n`)).toEqual({
    forked_from_hash: "2026-09-02",
  });
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

test("a block scalar keeps its blank lines, inner indent and hashes", () => {
  expect(
    parseYaml(
      `description: |\n  first line\n\n  second line\n    indented # not a comment\nnext: 1\n`,
    ),
  ).toEqual({
    description: "first line\n\nsecond line\n  indented # not a comment\n",
    next: 1,
  });
});

test("a block scalar keeps a leading comment line, a leading blank and its paragraphs", () => {
  expect(parseYaml(`description: |\n\n  # Heading\n  text\n\n  more\nnext: 1\n`)).toEqual({
    description: "\n# Heading\ntext\n\nmore\n",
    next: 1,
  });
});

test("a folded scalar folds each paragraph and keeps the break between them", () => {
  expect(parseYaml(`note: >\n  a\n  b\n\n  c\n`)).toEqual({ note: "a b\nc\n" });
});

test("frontmatter that sets no keys is an empty mapping", () => {
  expect(parseDocument("---\n\n---\n\nbody")).toEqual({ data: {}, body: "body" });
  expect(parseDocument("---\n# only a comment\n---\n\nbody")).toEqual({
    data: {},
    body: "body",
  });
});

test("a `---` inside a block scalar does not end the frontmatter", () => {
  const doc = `---\nname: plan\ndescription: |\n  a heading\n  ---\n  more text\nforked_from_hash: OLD\n---\n\nbody\n`;
  const written = setFrontmatterKey(doc, "forked_from_hash", "NEW");
  expect(written.split("\n").filter((line) => line.startsWith("forked_from_hash"))).toEqual([
    "forked_from_hash: NEW",
  ]);
  expect(parseDocument(written).data.forked_from_hash).toBe("NEW");
});
