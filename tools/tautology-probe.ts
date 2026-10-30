#!/usr/bin/env bun
// Whether the shipped reviewer raises a Tautology (ADR-draft-a-tautology-proves-nothing, D6)
// — against a real model, told what a review Run's reviewer is told.
//
//   bun run tools/tautology-probe.ts [--runs 3] [--keep]
//
// It costs real money (each run is one full review at the reviewer's own model and effort)
// and needs a working `claude`, so it is never part of `bun test`.
//
// The fixture in `tools/tautology-fixture/` is a base and a patch, applied in a scratch git
// repository, with the ticket, recorded checks and hand-off a reviewer is shown, and a key
// naming which of its items are Tautologies. It passes only when, in most runs, every
// Tautology is raised and no honest item is.

import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { BunServices } from "@effect/platform-bun";
import { Duration, Effect, FileSystem, ManagedRuntime, Option, Schema, flow, Result } from "effect";
import { decodeOutput, installedSkills, personaText, promptFor } from "../src/agents";
import { readEnv } from "../src/env";
import { HARNESSES, startArgs } from "../src/harness";
import { SynthesisSchema } from "../src/output";
import { renderRecordedChecks } from "../src/outcome";
import { criteriaIn } from "../src/plan";
import { jsonSchemaFor } from "../src/sdk";
import { skillsIn } from "../src/template";
import { nowIso } from "../src/time";
import type { Verification } from "../src/verify";
import { renderAnswered } from "../workflows/implement.workflow";
import { REVIEW, REVIEWER, told } from "../workflows/reviewing";

/** One item of the fixture, at the lines a finding has to name to count against it. */
export interface KeyItem {
  readonly id: string;
  readonly kind: string;
  readonly tautology: boolean;
  /** Relative to the scratch directory: `repo/…`, `plan/…` or `run/…`. */
  readonly file: string;
  readonly lines: readonly [number, number];
}

export interface Raised {
  readonly file?: string;
  readonly line?: number;
}

/** Whether a finding's path and the key's name one file, however much of the path each gives. */
const sameFile = (named: string, keyed: string) => {
  const a = pipe(named, Str.replace(/^\.\//, ""));
  return a === keyed || pipe(a, Str.endsWith(`/${keyed}`)) || pipe(keyed, Str.endsWith(`/${a}`));
};

const hits = (finding: Raised, item: KeyItem) =>
  finding.file !== undefined &&
  finding.line !== undefined &&
  sameFile(finding.file, item.file) &&
  finding.line >= item.lines[0] &&
  finding.line <= item.lines[1];

/** Each Tautology most runs missed, and each honest item most runs raised. */
export function scored(runs: ReadonlyArray<ReadonlyArray<Raised>>, key: ReadonlyArray<KeyItem>) {
  const raised = (item: KeyItem) =>
    Arr.filter(runs, (findings) => Arr.some(findings, (finding) => hits(finding, item))).length *
      2 >
    runs.length;
  return {
    missed: Arr.filter(key, (item) => item.tautology && !raised(item)),
    falselyRaised: Arr.filter(key, (item) => !item.tautology && raised(item)),
  };
}

const runtime = ManagedRuntime.make(BunServices.layer);
const repo = new URL("../", import.meta.url).pathname;
const fixture = `${repo}tools/tautology-fixture`;

/** The longest one review may take before the probe stops waiting for it. */
const REVIEW_CEILING = Duration.minutes(45);

const KeySchema = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    kind: Schema.String,
    tautology: Schema.Boolean,
    file: Schema.String,
    lines: Schema.Tuple([Schema.Finite, Schema.Finite]),
  }),
);
const JournalSchema = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    command: Schema.NonEmptyArray(Schema.String),
    by: Schema.Literals(["agent", "collie"]),
    result: Schema.Literals(["pass", "fail"]),
    tree: Schema.optional(Schema.Literal("earlier")),
  }),
);
const AnswersSchema = Schema.Struct({
  item: Schema.String,
  answers: Schema.Array(Schema.Struct({ criterion: Schema.String, met: Schema.String })),
  assumptions: Schema.Array(Schema.String),
});
export const readKey = flow(
  Schema.decodeUnknownResult(Schema.fromJsonString(KeySchema)),
  Result.getOrThrow,
);
const readJournal = flow(
  Schema.decodeUnknownResult(Schema.fromJsonString(JournalSchema)),
  Result.getOrThrow,
);
const readAnswers = flow(
  Schema.decodeUnknownResult(Schema.fromJsonString(AnswersSchema)),
  Result.getOrThrow,
);

const git = (cwd: string, ...args: string[]) =>
  Effect.promise(() =>
    Bun.$`git -c user.name=probe -c user.email=probe@example.invalid ${args}`.cwd(cwd).quiet(),
  );

/** The fixture as a branch `hours` over `master`, beside its plan and run directories. */
const scratch = Effect.fn("probe.scratch")(function* (keep: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const dir = keep
    ? yield* fs.makeTempDirectory({ prefix: "collie-tautology-" })
    : yield* fs.makeTempDirectoryScoped({ prefix: "collie-tautology-" });
  const work = `${dir}/repo`;
  yield* fs.makeDirectory(work, { recursive: true });
  yield* fs.copy(`${fixture}/plan`, `${dir}/plan`);
  yield* fs.copy(`${fixture}/run`, `${dir}/run`);
  yield* fs.makeDirectory(`${dir}/out`);
  yield* git(work, "init", "-q", "-b", "master");
  yield* git(work, "apply", `${fixture}/base.patch`);
  yield* git(work, "add", "-A");
  yield* git(work, "commit", "-qm", "Read durations");
  yield* git(work, "checkout", "-qb", "hours");
  yield* git(work, "apply", `${fixture}/change.patch`);
  yield* git(work, "add", "-A");
  yield* git(work, "commit", "-qm", "Read hours and compound durations");
  const sha = (ref: string) =>
    Effect.promise(() => Bun.$`git rev-parse ${ref}`.cwd(work).text()).pipe(
      Effect.map((out) => Str.trim(out)),
    );
  return { dir, work, trees: { head: yield* sha("HEAD"), base: yield* sha("master") } };
});

/** The fixture's journal as recorded checks, on the reviewed tree unless one says `earlier`. */
export const journal = (
  raw: string,
  cwd: string,
  trees: { readonly head: string; readonly base: string },
  at: string,
) => {
  const final = { head_sha: trees.head, fingerprint: "fixture" };
  const earlier = { head_sha: trees.base, fingerprint: "fixture-base" };
  const verifications = Arr.map(readJournal(raw), (one, n): Verification => ({
    id: `fixture-${n}`,
    run: "tautology-probe",
    name: one.name,
    executable: one.command[0],
    argv: one.command.slice(1),
    cwd,
    start: one.tree === "earlier" ? earlier : final,
    end: one.tree === "earlier" ? earlier : final,
    exit: one.result === "pass" ? 0 : 1,
    seconds: 1,
    tail: { stdout: "", stderr: "" },
    expect: "pass",
    result: one.result,
    at,
    by: one.by,
  }));
  return renderRecordedChecks({ verifications, final });
};

/**
 * The environment without what names a herdr pane, so a `collie verify` the reviewer runs
 * is refused rather than recorded on, and run in the checkout of, the Run the probe was
 * started from.
 */
export const outsideAnyRun = (env: NodeJS.ProcessEnv) =>
  Rec.fromEntries(
    Arr.filter(
      Rec.toEntries(env),
      ([name]) =>
        ![
          "HERDR_PANE_ID",
          "HERDR_ACTIVE_PANE_ID",
          "HERDR_TAB_ID",
          "HERDR_ACTIVE_TAB_ID",
          "HERDR_WORKSPACE_ID",
          "HERDR_ACTIVE_WORKSPACE_ID",
          "HERDR_PLUGIN_CONTEXT_JSON",
        ].includes(name),
    ),
  );

/** One reviewer, launched as a review Run launches it, and the findings it wrote. */
const review = Effect.fn("probe.review")(function* (
  cwd: string,
  persona: string,
  prompt: string,
  output: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const argv = [
    ...startArgs(HARNESSES.claude!, REVIEWER.model, persona, REVIEWER.effort, "auto"),
    "-p",
  ];
  const proc = Bun.spawn(["claude", ...argv], {
    cwd,
    env: outsideAnyRun(process.env),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  void proc.stdin.write(prompt);
  void proc.stdin.end();
  const ended = yield* Effect.timeoutOption(
    Effect.promise(() => proc.exited),
    REVIEW_CEILING,
  );
  if (Option.isNone(ended)) {
    proc.kill();
    return { findings: [], problem: `stopped at the ${Duration.format(REVIEW_CEILING)} ceiling` };
  }
  const text = yield* fs.readFileString(output).pipe(Effect.orElseSucceed(() => ""));
  const read = decodeOutput(SynthesisSchema, text);
  if (!read.ok) {
    const stderr = yield* Effect.promise(() => new Response(proc.stderr).text());
    return { findings: [], problem: `no usable Output: ${read.problem} ${Str.trim(stderr)}` };
  }
  return { findings: read.value.findings ?? [], problem: null };
});

const probe = Effect.fn("probe.run")(function* (runs: number, keep: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const key = readKey(yield* fs.readFileString(`${fixture}/key.json`));
  const { dir, work, trees } = yield* scratch(keep);
  const runDir = `${dir}/run`;
  const plan = `${dir}/plan`;
  const env = readEnv({ ...process.env, HERDR_PLUGIN_ROOT: repo, COLLIE_CWD: work });

  const ticket = yield* fs.readFileString(`${plan}/issues/01-hours.md`);
  const fixed = readAnswers(
    pipe(yield* fs.readFileString(`${fixture}/answers.json`), Str.replaceAll("{run}", runDir)),
  );
  const criteria = renderAnswered([{ ...fixed, criteria: criteriaIn(ticket) }]);
  const checks = journal(
    yield* fs.readFileString(`${fixture}/journal.json`),
    work,
    trees,
    yield* nowIso,
  );
  const input = {
    ...told(
      {
        target: "",
        plan,
        proves: "feature",
        previous: "",
        answered: "",
        risks: "",
        at: 1,
        of: 1,
        disputed: [],
        base: "master",
      },
      { dir: runDir, id: "tautology-probe" },
    ),
    checks,
    criteria,
  };

  const persona = `${dir}/reviewer.persona.md`;
  yield* fs.writeFileString(persona, `${yield* personaText(env, "reviewer")}\n`);
  const skills = yield* installedSkills(env, skillsIn(REVIEW.text));

  const all: Array<ReadonlyArray<Raised>> = [];
  for (let n = 1; n <= runs; n++) {
    const output = `${dir}/out/review-${n}.json`;
    const prompt = promptFor({
      role: "reviewer",
      instructions: REVIEW.text,
      input,
      skills,
      cwd: work,
      output,
      contract: jsonSchemaFor(SynthesisSchema),
    });
    yield* fs.writeFileString(`${dir}/out/review-${n}.prompt.md`, prompt);
    const got = yield* review(work, persona, prompt, output);
    if (got.problem !== null) yield* Effect.logWarning(`run ${n}: ${got.problem}`);
    yield* Effect.log(`run ${n}: ${got.findings.length} finding(s)`);
    all.push(got.findings);
  }

  const { missed, falselyRaised } = scored(all, key);
  const count = (item: KeyItem) =>
    Arr.filter(all, (findings) => Arr.some(findings, (one) => hits(one, item))).length;
  yield* Effect.log(
    Arr.join(
      Arr.map(
        [
          "",
          `| item | kind | Tautology | raised in |`,
          "|---|---|---|---|",
          ...Arr.map(
            key,
            (item) =>
              `| ${item.id} | ${item.kind} | ${item.tautology ? "yes" : "no"} | ${count(item)}/${runs} |`,
          ),
          "",
          ...Arr.map(
            missed,
            (item) =>
              `missed: ${item.id} (${item.kind}) at ${item.file}:${Arr.join(
                Arr.map(item.lines, (part) =>
                  part === null || part === undefined ? "" : globalThis.String(part),
                ),
                "-",
              )}`,
          ),
          ...Arr.map(
            falselyRaised,
            (item) =>
              `raised an honest item: ${item.id} (${item.kind}) at ${item.file}:${Arr.join(
                Arr.map(item.lines, (part) =>
                  part === null || part === undefined ? "" : globalThis.String(part),
                ),
                "-",
              )}`,
          ),
          keep ? `kept the scratch directory at ${dir}` : "",
        ],
        (part) => (part === null || part === undefined ? "" : globalThis.String(part)),
      ),
      "\n",
    ),
  );
  return missed.length === 0 && falselyRaised.length === 0 ? 0 : 1;
});

// Only as a command. Imported — the scorer has a unit test — this makes no call.
if (import.meta.main) {
  const at = Bun.argv.indexOf("--runs");
  const runs = at > 0 ? Number(Bun.argv[at + 1]) : 3;
  const keep = Bun.argv.includes("--keep");
  process.exitCode = await runtime.runPromise(probe(runs, keep).pipe(Effect.scoped, Effect.orDie));
}
