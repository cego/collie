#!/usr/bin/env bun
// Whether the evaluator is actually tool-less, actually isolated, and actually bounded —
// against the installed CLI, not against its help text.
//
//   bun run tools/evaluator-probe.ts [--calls 10] [--transcript <file>]
//
// It costs real money (a handful of small calls) and needs a working `claude`, so it is
// never part of `bun test`. It is the regression test for the one claim the design cannot
// verify any other way: that a model given `--tools ""` has no tools.
//
// Four things, in order:
//   1. one call, whose raw envelope is saved to test/fixtures/claude-print-envelope.json
//   2. N judgement calls, every one of which must decode against the schema it was given
//   3. one call from a scratch directory that declares a hook and an MCP server, with a
//      stream-json transcript asserted to contain no tool_use, hook or MCP event
//   4. p95 latency and what it cost
//
// Threat boundary, stated: these flags defend against model-initiated tool use and
// against inherited user or project configuration reaching the evaluator. They are not
// an OS sandbox against a malicious process running as the same user.

import { BunServices } from "@effect/platform-bun";
import { Clock, Duration, Effect, FileSystem, ManagedRuntime, Option, Path } from "effect";
import {
  JudgementSchema,
  REQUIRED_FLAGS,
  argvFor,
  jsonSchemaFor,
  missingFlags,
  structuredFrom,
} from "../src/evaluator";
import { Schema } from "effect";
import { nowIso } from "../src/time";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

const runtime = ManagedRuntime.make(BunServices.layer);
const repo = new URL("../", import.meta.url).pathname;

const LIMITS = {
  maxSeconds: 120,
  maxOutputBytes: 262_144,
  model: "sonnet",
  effort: "low",
};

const PACK = [
  "## The question",
  "",
  "Which run is on the wrong branch?",
  "",
  "## Runs",
  "",
  "- run implement-picker-1: goal 'add a picker', branch feat/add-a-picker, agent impl-1",
  "- run implement-export-2: goal 'fix the exporter', branch main, agent impl-2",
].join("\n");

/**
 * What a call printed, or what was left of it at the probe's own ceiling. A probe that
 * waits for ever is not a bounded experiment: past the ceiling the process is killed and
 * its output so far is what there is.
 */
const drained = Effect.fn("probe.drained")(function* (
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
) {
  const output = Effect.promise(() =>
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
  );
  const got = yield* Effect.timeoutOption(output, Duration.seconds(LIMITS.maxSeconds));
  if (Option.isNone(got)) {
    proc.kill();
    yield* Effect.promise(() => proc.exited);
    return { stdout: "", stderr: `killed at the probe's ${LIMITS.maxSeconds}s ceiling` };
  }
  yield* Effect.promise(() => proc.exited);
  return { stdout: got.value[0], stderr: got.value[1] };
});

/** One call, returning what it printed and how long it took. */
const one = Effect.fn("probe.one")(function* (schema: string, extra: string[] = []) {
  const started = yield* Clock.currentTimeMillis;
  const argv = [...argvFor(LIMITS, schema, `${repo}prompts/steward.md`), ...extra];
  const proc = Bun.spawn(["claude", ...argv], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  void proc.stdin.write(PACK);
  void proc.stdin.end();
  const { stdout, stderr } = yield* drained(proc);
  return { stdout, stderr, ms: (yield* Clock.currentTimeMillis) - started };
});

const parseLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const Event = Schema.Struct({
  type: Schema.String,
  subtype: Schema.optionalKey(Schema.String),
  tools: Schema.optionalKey(Schema.Array(Schema.String)),
  mcp_servers: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  message: Schema.optionalKey(
    Schema.Struct({
      content: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({ type: Schema.String, name: Schema.optionalKey(Schema.String) }),
        ),
      ),
    }),
  ),
});
const asEvent = Schema.decodeUnknownOption(Event);

/**
 * The one "tool" a `--json-schema` call is given: the CLI's own channel for the
 * structured answer. It reaches nothing outside the model's reply — its input *is* the
 * answer — so a transcript with it and nothing else is a tool-less call. Recorded by
 * name so a release that adds a second one is a failure, not a surprise.
 */
const STRUCTURED_OUTPUT = "StructuredOutput";

/** What in a stream-json transcript says the isolation failed, by event, not by word. */
export function leaks(transcript: string): string[] {
  const found: string[] = [];
  for (const line of transcript.split("\n")) {
    const parsed = parseLine(line);
    if (parsed._tag === "None") continue;
    const event = asEvent(parsed.value);
    if (event._tag === "None") continue;
    const e = event.value;
    if (e.type.startsWith("hook")) found.push(`${e.type} event`);
    if (e.type === "system" && e.subtype === "init") {
      const offered = (e.tools ?? []).filter((tool) => tool !== STRUCTURED_OUTPUT);
      if (offered.length > 0) found.push(`tool(s) offered: ${offered.join(", ")}`);
      if ((e.mcp_servers?.length ?? 0) > 0) found.push(`${e.mcp_servers!.length} MCP server(s)`);
    }
    for (const block of e.message?.content ?? [])
      if (block.type === "tool_use" && block.name !== STRUCTURED_OUTPUT)
        found.push(`a tool_use block: ${block.name ?? "unnamed"}`);
  }
  return found;
}

const probe = Effect.fn("probe.run")(function* (calls: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const help = yield* Effect.promise(() => Bun.$`claude --help`.text().catch(() => ""));
  const missing = missingFlags(help);
  if (missing.length > 0) {
    yield* Effect.logError(`the installed claude does not take ${missing.join(", ")}`);
    return 1;
  }

  const schema = jsonSchemaFor("judgement");

  // (1) The envelope, saved whole so the decoder has something real to be tested against.
  const first = yield* one(schema);
  const fixture = path.join(repo, "test", "fixtures", "claude-print-envelope.json");
  yield* fs.makeDirectory(path.dirname(fixture), { recursive: true });
  yield* fs.writeFileString(fixture, `${first.stdout.trim()}\n`);
  yield* Effect.log(`saved the envelope to ${fixture}`);

  // (2) Every call has to answer in the schema it was given.
  const decoded = (raw: string) => !("error" in structuredFrom(raw, JudgementSchema));
  const latencies: number[] = [first.ms];
  let good = decoded(first.stdout) ? 1 : 0;
  for (let i = 1; i < calls; i++) {
    const next = yield* one(schema);
    latencies.push(next.ms);
    if (decoded(next.stdout)) good += 1;
  }

  // (3) A directory that tries to give the model a hook and an MCP server. Nothing in the
  // transcript may show either, or a tool call of any kind.
  const hostile = yield* fs.makeTempDirectory({ prefix: "collie-probe-hostile-" });
  yield* fs.makeDirectory(path.join(hostile, ".claude"), { recursive: true });
  yield* fs.writeFileString(
    path.join(hostile, ".claude", "settings.json"),
    `${encodeJson({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo probed" }] }] },
      mcpServers: { probe: { command: "echo", args: ["probe"] } },
    })}\n`,
  );
  const isolated = Bun.spawn(
    [
      "claude",
      ...argvFor(LIMITS, schema, `${repo}prompts/steward.md`).map((word) =>
        word === "json" ? "stream-json" : word,
      ),
      "--verbose",
    ],
    { cwd: hostile, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  void isolated.stdin.write(PACK);
  void isolated.stdin.end();
  const transcript = (yield* drained(isolated)).stdout;
  // Read as events, not as text: the CLI's own `system` line says `mcp_servers: []` and
  // names its tool list, so the words appear in a clean transcript too. What must not is
  // a tool call the model made, a hook that ran, or an MCP server that was connected.
  const leaked = leaks(transcript);
  const keepAt = Bun.argv.indexOf("--transcript");
  if (keepAt > 0 && Bun.argv[keepAt + 1]) {
    yield* fs.writeFileString(Bun.argv[keepAt + 1]!, transcript);
    yield* Effect.log(`saved the isolation transcript to ${Bun.argv[keepAt + 1]}`);
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;

  yield* Effect.log(
    [
      "",
      `### evaluator — ${(yield* nowIso()).slice(0, 10)}`,
      "",
      "| check | result | note |",
      "|---|---|---|",
      `| flags | pass | every one of ${REQUIRED_FLAGS.length} is present |`,
      `| schema-valid | ${good === calls ? "pass" : "fail"} | ${good}/${calls} decoded |`,
      `| tool-less | ${leaked.length === 0 ? "pass" : "fail"} | ${
        leaked.length === 0
          ? "no tool_use, hook or MCP event in the transcript"
          : `saw ${leaked.join(", ")}`
      } |`,
      `| latency | — | p95 ${Math.round(p95)} ms over ${calls} calls |`,
      "",
      "Threat boundary: these flags defend against model-initiated tool use and against",
      "inherited user or project configuration reaching the evaluator. They are not an OS",
      "sandbox against a malicious process running as the same user.",
      "",
      "Paste this into the Run's CAPABILITIES.md under Evaluator.",
    ].join("\n"),
  );
  yield* fs.remove(hostile, { recursive: true, force: true });
  return good === calls && leaked.length === 0 ? 0 : 1;
});

// Only as a command. Imported — the transcript reader has a unit test — this makes no call.
if (import.meta.main) {
  const at = Bun.argv.indexOf("--calls");
  const calls = at > 0 ? Number(Bun.argv[at + 1]) : 10;
  process.exitCode = await runtime.runPromise(probe(calls).pipe(Effect.orDie));
}
