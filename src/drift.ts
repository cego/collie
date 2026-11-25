// WARNING: the drift journal is append-only; a resolution is a new line, never an edit.
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import type { PlatformServices } from "./platform";
import { Data, Effect, FileSystem, Path, Schema, flow, Result } from "effect";
import type { Constraint, Intent, RuleSpec } from "./intent";
import {
  appendJournal,
  appendRunJournal,
  readJournal,
  readRunJournal,
  runJournal,
} from "./journal";
import { shell } from "./mr";
import { isRecord, isString } from "./schema";
import { nowIso } from "./time";
import { DriftReportSchema, evaluate, flagsPresent } from "./evaluator";
import type { DriftReport, EvaluatorDeps, Ref } from "./evaluator";
import { insideKnown } from "./conversation";
import { reserve, settle as settleBudget } from "./steering";
import type { CallLimits } from "./steering";
import { stringifyJson } from "./json";
import { RunRecords } from "./run-records";
import { ACCEPTED, acceptedText } from "./step-output";
import { runOfDir } from "./run-records";

export const MAX_LINES_PER_FILE = 200;
export const MAX_FILES = 20;

const SECRET_FILES = [/(^|\/)\.env($|\.)/, /\.pem$/, /\.key$/, /token/i, /secret/i, /credential/i];

export function looksSecret(path: string) {
  return Arr.some(SECRET_FILES, (looksLike) => looksLike.test(path));
}

const SkippedSchema = Schema.Struct({
  kind: Schema.Literal("skipped"),
  at: Schema.String,
  run: Schema.String,
  reason: Schema.String,
  check: Schema.optionalKey(Schema.Literal("rule")),
});

export const DriftLineSchema = Schema.Union([SkippedSchema, DriftReportSchema]);
export type DriftLine = Schema.Schema.Type<typeof DriftLineSchema>;
const LineJson = Schema.fromJsonString(DriftLineSchema);

export const driftPath = (runDir: string) => runJournal(runDir, "steering/drift.jsonl");

export const readDrift = Effect.fn("Drift.read")(function* (runDir: string) {
  return yield* readRunJournal(driftPath(runDir), LineJson);
});

export const appendDrift = Effect.fn("Drift.append")(function* (runDir: string, line: DriftLine) {
  yield* appendRunJournal(driftPath(runDir), LineJson, line);
});

export function currentReports(lines: ReadonlyArray<DriftLine>) {
  const newest = new Map<string, DriftReport>();
  for (const line of lines) {
    if (line.kind !== "skipped") {
      newest.set(line.id, line);
    }
  }
  return [...newest.values()];
}

export function openReports(lines: ReadonlyArray<DriftLine>) {
  return Arr.filter(
    currentReports(lines),
    (report) => report.resolution === "open" || report.resolution === "correction_submitted",
  );
}

export function findingKey(constraint: string, evidence: ReadonlyArray<Ref>) {
  return Bun.hash(
    `${constraint}\n${Arr.join(
      Arr.map(evidence, (ref) => `${ref.kind}:${ref.path ?? ""}:${ref.line ?? ""}`),
      "\n",
    )}`,
  ).toString(16);
}

export interface RuleFacts {
  readonly changedFiles: ReadonlyArray<string>;
  readonly branch: string | null;
  readonly mrTarget: { readonly project: string; readonly iid: string | null } | null;
  readonly outputs: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly verifications: Readonly<Record<string, { readonly exit: number; readonly ref: string }>>;
}

export function matchesGlob(glob: string, path: string) {
  const pattern = Arr.join(
    Arr.map(Str.split(glob, "**"), (part) =>
      Arr.join(
        Arr.map(Str.split(part, "*"), (piece) =>
          pipe(piece, Str.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`)),
        ),
        "[^/]*",
      ),
    ),
    ".*",
  );
  return new RegExp(`^${pattern}$`).test(path);
}

export function flattenOutput(json: string) {
  const flat: Record<string, string> = {};
  const decoded = decodeUnknown(json);
  if (decoded._tag === "None") {
    return flat;
  }
  const stack: Array<{ prefix: string; node: unknown }> = [{ prefix: "", node: decoded.value }];
  while (stack.length > 0) {
    const { prefix, node } = stack.pop()!;
    if (isRecord(node)) {
      if (prefix !== "") {
        flat[prefix] = encodeUnknown(node);
      }
      for (const [key, child] of Rec.toEntries(node)) {
        stack.push({ prefix: prefix === "" ? key : `${prefix}.${key}`, node: child });
      }
      continue;
    }
    if (prefix === "") {
      continue;
    }
    flat[prefix] = isString(node) ? node : encodeUnknown(node);
  }
  return flat;
}

const decodeUnknown = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const encodeUnknown = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

function violation(
  constraint: Constraint,
  run: string,
  intentVersion: number,
  at_: string,
  { evidence, truncated }: Breach,
) {
  const returned: DriftReport = {
    id: `d-${findingKey(constraint.id, evidence)}`,
    at: at_,
    run,
    intent_version: intentVersion,
    constraint: constraint.id,
    kind: "rule",
    severity: constraint.severity,
    evidence: [...evidence],
    evidence_truncated: truncated,
    resolution: "open",
  };
  return returned;
}

export function checkRules(intent: Intent, facts: RuleFacts, at_: string) {
  const found: Array<DriftReport> = [];
  for (const constraint of intent.constraints) {
    if (constraint.kind !== "rule" || constraint.rule === undefined) {
      continue;
    }
    const evidence = breachOf(constraint.rule, facts);
    if (evidence !== null) {
      found.push(violation(constraint, intent.run, intent.version, at_, evidence));
    }
  }
  return found;
}

interface Breach {
  readonly evidence: ReadonlyArray<Ref>;
  readonly truncated: boolean;
}

const whole = (evidence: ReadonlyArray<Ref> | null) =>
  evidence === null ? null : { evidence, truncated: false };

function breachOf(rule: RuleSpec, facts: RuleFacts) {
  if (rule.kind !== "protected_paths") {
    return whole(refsOf(rule, facts));
  }
  // WARNING: the globs are where change is allowed; every file outside them is reported.
  const outside = Arr.filter(
    facts.changedFiles,
    (file) => !Arr.some(rule.globs, (glob) => matchesGlob(glob, file)),
  );
  return outside.length === 0
    ? null
    : {
        evidence: Arr.map(outside.slice(0, MAX_FILES), (path) => ({ kind: "diff" as const, path })),
        truncated: outside.length > MAX_FILES,
      };
}

function refsOf(rule: Exclude<RuleSpec, { kind: "protected_paths" }>, facts: RuleFacts) {
  switch (rule.kind) {
    case "branch_is": {
      const returned: Array<Ref> | null =
        facts.branch === rule.name
          ? null
          : [{ kind: "git", excerpt: `on ${facts.branch ?? "no branch"}, not ${rule.name}` }];
      return returned;
    }
    case "mr_target": {
      const target = facts.mrTarget;
      if (target === null) {
        const returned: Array<Ref> | null = [
          { kind: "record", excerpt: "no merge request recorded" },
        ];
        return returned;
      }
      if (target.project !== rule.project) {
        const returned: Array<Ref> | null = [
          { kind: "record", excerpt: `targets ${target.project}, not ${rule.project}` },
        ];
        return returned;
      }
      if (rule.iid !== undefined && target.iid !== rule.iid) {
        const returned: Array<Ref> | null = [
          { kind: "record", excerpt: `is !${target.iid ?? "?"}, not !${rule.iid}` },
        ];
        return returned;
      }
      const returned: Array<Ref> | null = null;
      return returned;
    }
    case "output_field": {
      const output = facts.outputs[rule.step];
      if (output === undefined) {
        const returned: Array<Ref> | null = [
          { kind: "output", path: rule.step, excerpt: "no Output recorded" },
        ];
        return returned;
      }
      const value = output[rule.path] ?? "";
      const holds = rule.op === "eq" ? value === rule.value : value !== rule.value;
      const returned: Array<Ref> | null = holds
        ? null
        : [
            {
              kind: "output",
              path: `${rule.step}.${rule.path}`,
              excerpt: `is ${stringifyJson(value)}`,
            },
          ];
      return returned;
    }
    case "command_exit": {
      const verification = facts.verifications[rule.name];
      // WARNING: nobody ran it is not the same as it passed; a missing verification is a violation.
      if (verification === undefined) {
        const returned: Array<Ref> | null = [
          { kind: "verification", path: rule.name, excerpt: "no verification of that name" },
        ];
        return returned;
      }
      const returned: Array<Ref> | null =
        verification.exit === rule.expect
          ? null
          : [
              {
                kind: "verification",
                path: rule.name,
                sha: verification.ref,
                excerpt: `exited ${verification.exit}, wanted ${rule.expect}`,
              },
            ];
      return returned;
    }
  }
}

export const driftSaid = (report: DriftReport, where: string) =>
  `drift at ${where}: ${report.constraint} (${report.severity}) — ${Arr.join(
    Arr.map(report.evidence, (ref) => ref.path ?? ref.excerpt ?? ref.kind),
    ", ",
  )}${report.evidence_truncated ? " (evidence truncated)" : ""}`;

export interface EvidenceBlock {
  readonly path: string;
  readonly diff: string;
  readonly truncated: boolean;
}

export class TreeUnread extends Data.TaggedError("TreeUnread")<{ reason: string }> {}

// WARNING: a failing git diff is not an unchanged tree; it must never read as empty.
export const gitOutput = Effect.fn("Drift.gitOutput")(function* (args: Array<string>, cwd: string) {
  const ran = yield* shell("git", args, cwd);
  if (ran.code === 0) {
    return ran.stdout;
  }
  return yield* new TreeUnread({
    reason: `git ${Arr.join(args, " ")} exited ${ran.code}: ${Str.split(Str.trim(ran.stderr ?? ""), "\n")[0]}`,
  });
});

// WARNING: in a merge, the working tree against MERGE_HEAD is the Run's side alone.
export const merging = Effect.fn("Drift.merging")(function* (worktree: string) {
  return (yield* shell("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktree)).code === 0;
});

const outsideGit = (dir: string) =>
  shell("git", ["rev-parse", "--git-dir"], dir).pipe(
    Effect.map(
      (ran) => ran.code !== 0 && pipe(ran.stderr ?? "", Str.includes("not a git repository")),
    ),
  );

export const evidenceFor = Effect.fn("Drift.evidenceFor")(function* (
  worktree: string,
  paths: ReadonlyArray<string>,
  base: string,
) {
  const scope = paths.length === 0 ? [] : ["--", ...paths];
  const diff = (yield* merging(worktree))
    ? yield* gitOutput(["diff", "MERGE_HEAD", "--unified=3", ...scope], worktree)
    : Arr.join(
        [
          yield* gitOutput(["diff", `${base}..HEAD`, "--unified=3", ...scope], worktree),
          yield* gitOutput(["diff", "HEAD", "--unified=3", ...scope], worktree),
        ],
        "\n",
      );
  const blocks = splitDiff(diff);
  return {
    blocks: blocks.slice(0, MAX_FILES),
    truncated: blocks.length > MAX_FILES || Arr.some(blocks, (block) => block.truncated),
  };
});

export function splitDiff(diff: string) {
  const blocks: Array<EvidenceBlock> = [];
  let path: string | null = null;
  let lines: Array<string> = [];
  const flush = () => {
    if (path === null) {
      return;
    }
    if (looksSecret(path)) {
      blocks.push({ path, diff: "<redacted>", truncated: false });
    } else {
      blocks.push({
        path,
        diff: Arr.join(lines.slice(0, MAX_LINES_PER_FILE), "\n"),
        truncated: lines.length > MAX_LINES_PER_FILE,
      });
    }
    lines = [];
  };
  for (const line of Str.split(diff, "\n")) {
    const header = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (header) {
      flush();
      path = header[2] ?? header[1] ?? null;
      continue;
    }
    if (path !== null) {
      lines.push(line);
    }
  }
  flush();
  return blocks;
}

export interface ShownOutput {
  readonly operation: string;
  readonly text: string;
}

const NOT_OUTPUTS = [".launch.json", ".mcp.json", ".settings.json"];

const isAnOutput = (name: string) => !Arr.some(NOT_OUTPUTS, (not) => pipe(name, Str.endsWith(not)));

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const printJson = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown, { space: 2 })),
  Result.getOrThrow,
);

export const outputsIn = Effect.fn("Drift.outputsIn")(function* (agentsDir: string, run: string) {
  const fs = yield* FileSystem.FileSystem;
  const records = yield* RunRecords;
  const names = Arr.filter(
    yield* fs.readDirectory(agentsDir).pipe(Effect.orElseSucceed(() => [])),
    (name) => pipe(name, Str.endsWith(".json")) && isAnOutput(name),
  ).sort();
  const shown = new Map<string, string>();
  for (const name of names.slice(0, MAX_FILES)) {
    shown.set(
      name,
      yield* fs.readFileString(`${agentsDir}/${name}`).pipe(Effect.orElseSucceed(() => "")),
    );
  }
  for (const fact of yield* records.factsUnder(run, ACCEPTED)) {
    const name = Str.slice(ACCEPTED.length)(fact.name);
    if (pipe(name, Str.endsWith(".json")) && isAnOutput(name)) {
      shown.set(name, acceptedText(fact.data));
    }
  }
  const outputs: Array<ShownOutput & { readonly truncated: boolean }> = [];
  for (const name of [...shown.keys()].sort()) {
    const operation = pipe(name, Str.slice(0, -".json".length));
    if (looksSecret(name)) {
      outputs.push({ operation, text: "<redacted>", truncated: false });
      continue;
    }
    const raw = shown.get(name) ?? "";
    const lines = Str.split(printedJson(raw), "\n");
    outputs.push({
      operation,
      text: Arr.join(lines.slice(0, MAX_LINES_PER_FILE), "\n"),
      truncated: lines.length > MAX_LINES_PER_FILE,
    });
  }
  return {
    outputs: Arr.map(outputs, ({ operation, text }) => ({ operation, text })),
    truncated:
      names.length > MAX_FILES ||
      shown.size > MAX_FILES ||
      Arr.some(outputs, (one) => one.truncated),
  };
});

const printedJson = (raw: string) => {
  const decoded = decodeJson(raw);
  return decoded._tag === "None" ? raw : printJson(decoded.value);
};

export function newReports(found: ReadonlyArray<DriftReport>, existing: ReadonlyArray<DriftLine>) {
  const known = new Map(
    Arr.map(openReports(existing), (report) => [
      findingKey(report.constraint, report.evidence),
      report,
    ]),
  );
  const fresh: Array<DriftReport> = [];
  for (const report of found) {
    const key = findingKey(report.constraint, report.evidence);
    const open = known.get(key);
    if (open !== undefined && open.intent_version >= report.intent_version) {
      continue;
    }
    const next = open === undefined ? report : movedTo(open, report);
    known.set(key, next);
    fresh.push(next);
  }
  return fresh;
}

function movedTo(open: DriftReport, found: DriftReport) {
  const moved = { ...found, id: open.id, resolution: open.resolution };
  return open.correction === undefined ? moved : { ...moved, correction: open.correction };
}

export const fileReport = Effect.fn("Drift.fileReport")(function* (
  runDir: string,
  report: DriftReport,
) {
  const before = yield* readDrift(runDir).pipe(Effect.orElseSucceed(() => []));
  const [next] = newReports([report], before);
  if (next === undefined) {
    return false;
  }
  yield* appendDrift(runDir, next).pipe(Effect.ignore);
  return true;
});

export const recordSkipped = Effect.fn("Drift.recordSkipped")(function* (
  runDir: string,
  run: string,
  reason: string,
  check?: "rule",
) {
  yield* appendDrift(runDir, {
    kind: "skipped",
    at: yield* nowIso,
    run,
    reason,
    ...(check && { check }),
  });
});

export interface Judged {
  readonly semantic: boolean;
  readonly truncated: boolean;
  readonly at?: string;
}

export const NOT_JUDGED: Judged = { semantic: false, truncated: false };

export interface Judgement {
  readonly judged: Judged;
  readonly reports: ReadonlyArray<DriftReport>;
}

const NOTHING: Judgement = { judged: NOT_JUDGED, reports: [] };

export interface JudgementDeps {
  readonly evaluator: EvaluatorDeps;
  readonly budgetFile: string;
  readonly limits: CallLimits;
  readonly newId: Effect.Effect<string, never, PlatformServices>;
  readonly log: (line: string) => Effect.Effect<void, never, PlatformServices>;
}

export function judgementPaths(intent: Intent) {
  const named = pipe(
    intent.constraints,
    Arr.filter((constraint) => constraint.kind === "semantic"),
    Arr.flatMap((constraint) => [...(constraint.paths ?? [])]),
  );
  return [...new Set(named)];
}

export const PLAN_NARROWS_GOAL = [
  "A constraint read from the plan narrows the goal it was cut from: the goal is what was asked, not work done, and it is never evidence of drift.",
  "A report must cite the work it was shown.",
];

// WARNING: the diff is untrusted data; it goes last and fenced so it cannot read as instructions.
export function judgementPack(
  intent: Intent,
  evidence: {
    readonly blocks: ReadonlyArray<EvidenceBlock>;
    readonly outputs: ReadonlyArray<ShownOutput>;
    readonly truncated: boolean;
  },
) {
  const semantic = Arr.filter(intent.constraints, (constraint) => constraint.kind === "semantic");
  return Arr.join(
    Arr.filter(
      [
        `run: ${intent.run}`,
        `intent_version: ${intent.version}`,
        `goal: ${intent.goal ?? "(none stated)"}`,
        "",
        ...PLAN_NARROWS_GOAL,
        "",
        "constraints to judge:",
        ...Arr.map(
          semantic,
          (constraint) => `- ${constraint.id} (${constraint.severity}): ${constraint.text}`,
        ),
        "",
        evidence.truncated
          ? "evidence (TRUNCATED to the cap; judge only what is here):"
          : "evidence (the whole change):",
        ...Arr.map(evidence.blocks, (block) => `--- ${block.path}\n${block.diff}`),
        ...Arr.map(evidence.outputs, (output) => `--- output ${output.operation}\n${output.text}`),
        evidence.blocks.length === 0 && evidence.outputs.length === 0
          ? "(nothing has changed yet)"
          : "",
      ],
      (line) => line !== "",
    ),
    "\n",
  );
}

export interface ShownWork {
  readonly files: ReadonlyArray<string>;
  readonly outputs: ReadonlyArray<string>;
}

export const citedIn = (shown: ShownWork, worktree: string) => (ref: Ref) => {
  if (ref.path === undefined) {
    return null;
  }
  if (ref.kind === "output") {
    return shown.outputs.includes(ref.path) ? ref : null;
  }
  if (ref.kind !== "diff") {
    return null;
  }
  const file = pipe(ref.path, Str.startsWith(`${worktree}/`))
    ? pipe(ref.path, Str.slice(worktree.length + 1))
    : ref.path;
  return shown.files.includes(file) ? { ...ref, path: file } : null;
};

// WARNING: the model sets only constraint and severity; a ref outside the Run is dropped, never rewritten.
export function judgedReport(
  report: DriftReport,
  intent: Pick<Intent, "run" | "version">,
  at_: string,
  roots: ReadonlyArray<string>,
  truncated: boolean,
  cited: (ref: Ref) => Ref | null = () => null,
) {
  const evidence = Arr.flatMap(report.evidence, (ref) => {
    const work = cited(ref);
    if (work !== null) {
      return [work];
    }
    return ref.path === undefined || insideKnown(ref.path, roots) ? [ref] : [];
  });
  const returned: DriftReport = {
    id: `d-${findingKey(report.constraint, evidence)}`,
    at: at_,
    run: intent.run,
    intent_version: intent.version,
    constraint: report.constraint,
    kind: "semantic",
    severity: report.severity,
    evidence,
    evidence_truncated: truncated,
    resolution: "open",
  };
  return returned;
}

export interface Asked {
  readonly refused: string | null;
  readonly reports: ReadonlyArray<DriftReport>;
}

const notAsked = (refused: string) => ({ refused, reports: [] });

export const askJudgement = Effect.fn("Drift.askJudgement")(function* (
  deps: JudgementDeps,
  run: string,
  pack: string,
) {
  const checked = yield* flagsPresent(deps.evaluator).pipe(Effect.result);
  if (checked._tag === "Failure") {
    return notAsked(`the evaluator is unavailable: ${checked.failure.reason}`);
  }
  const missing = checked.success;
  if (missing.length > 0) {
    return notAsked(`the evaluator is missing ${Arr.join(missing, ", ")}`);
  }

  // WARNING: usage is recorded, never enforced; no call is refused over a count.
  const callId = yield* deps.newId;
  yield* reserve(deps.budgetFile, { id: callId, run }, deps.limits);
  const asked = yield* evaluate(deps.evaluator, "judgement", pack);
  yield* settleBudget(deps.budgetFile, callId, {
    outcome: asked.spent.outcome === "ok" && asked.error !== null ? "failed" : asked.spent.outcome,
    usd: asked.spent.usd,
    seconds: asked.spent.seconds,
    bytes: asked.spent.bytes,
  });
  const answer = asked.value;
  return answer === null || !("reports" in answer)
    ? notAsked(`the judgement did not answer: ${asked.error ?? "no reports"}`)
    : ({ refused: null, reports: answer.reports } satisfies Asked);
});

// WARNING: a skipped judgement is unverified, never aligned: true.
export const judge = Effect.fn("Drift.judge")(function* (
  deps: JudgementDeps,
  intent: Intent,
  what: {
    readonly runDir: string;
    readonly worktree: string;
    readonly agentsDir?: string;
    readonly base: string;
    readonly at: string;
    readonly boundary?: string;
  },
) {
  const semantic = Arr.filter(intent.constraints, (constraint) => constraint.kind === "semantic");
  // WARNING: with no semantic constraint there is nothing to report against, so no call is made.
  if (semantic.length === 0) {
    return NOTHING;
  }

  const read = yield* evidenceFor(what.worktree, judgementPaths(intent), what.base).pipe(
    Effect.result,
  );
  const unread =
    read._tag === "Failure" ? `the diff could not be read: ${read.failure.reason}` : null;
  // WARNING: no checkout is an empty diff; any other git failure is never judged on nothing.
  if (unread !== null && !(yield* outsideGit(what.worktree))) {
    yield* recordSkipped(what.runDir, intent.run, unread);
    return NOTHING;
  }
  const diff = read._tag === "Success" ? read.success : { blocks: [], truncated: false };
  const shown =
    what.agentsDir === undefined
      ? { outputs: [], truncated: false }
      : yield* outputsIn(what.agentsDir, runOfDir(what.runDir));
  const evidence = {
    blocks: diff.blocks,
    outputs: shown.outputs,
    truncated: diff.truncated || shown.truncated,
  };
  // WARNING: a report must cite shown work, so with none the call could find nothing.
  if (evidence.blocks.length === 0 && evidence.outputs.length === 0) {
    yield* recordSkipped(what.runDir, intent.run, unread ?? "no change to judge");
    return NOTHING;
  }
  if (evidence.truncated && what.boundary !== undefined) {
    yield* deps.log(`not judged at ${what.boundary}: evidence past the cap; judged at the finish`);
    return NOTHING;
  }

  const asked = yield* askJudgement(deps, intent.run, judgementPack(intent, evidence));
  if (asked.refused !== null) {
    yield* recordSkipped(what.runDir, intent.run, asked.refused);
    return NOTHING;
  }

  const known = new Set(Arr.map(semantic, (constraint) => constraint.id));
  const cited = citedIn(
    {
      files: Arr.map(evidence.blocks, (block) => block.path),
      outputs: Arr.map(evidence.outputs, (output) => output.operation),
    },
    what.worktree,
  );
  const reports = Arr.map(
    Arr.filter(
      asked.reports,
      (report) =>
        known.has(report.constraint) && Arr.some(report.evidence, (ref) => cited(ref) !== null),
    ),
    (report) =>
      judgedReport(
        report,
        intent,
        what.at,
        [what.runDir, what.worktree],
        evidence.truncated,
        cited,
      ),
  );
  yield* deps.log(
    `judged ${semantic.length} semantic constraint(s) at ${what.at}: ${reports.length} report(s)${
      evidence.truncated ? ", on truncated evidence" : ""
    }`,
  );
  return {
    judged: { semantic: true, truncated: evidence.truncated },
    reports,
  };
});

export interface CorrectionContext {
  readonly overridden: boolean;
  readonly attributable: boolean;
  readonly held: boolean;
  readonly sent: Readonly<Record<string, number>>;
  readonly inFlight: ReadonlySet<string>;
  readonly nowProven: boolean;
}

export interface Correction {
  readonly report: DriftReport;
  readonly mode: "boundary" | "now";
}

export function decideCorrections(
  intent: Intent,
  open: ReadonlyArray<DriftReport>,
  ctx: CorrectionContext,
) {
  const authority = intent.authority;
  if (!authority.auto_correct) {
    return [];
  }
  if (ctx.held) {
    return [];
  }
  // WARNING: a human is typing into that agent; Collie does not take turns with them.
  if (ctx.overridden) {
    return [];
  }
  // WARNING: on a harness that hides external submissions, correcting needs exclusive steering.
  if (!ctx.attributable && !authority.exclusive_steering) {
    return [];
  }

  const corrections: Array<Correction> = [];
  for (const report of open) {
    if (report.intent_version !== intent.version) {
      continue;
    }
    if (ctx.inFlight.has(report.constraint)) {
      continue;
    }
    if ((ctx.sent[report.constraint] ?? 0) >= authority.max_corrections_per_constraint) {
      continue;
    }
    const urgent = report.severity === "block" && authority.now_allowed && ctx.nowProven;
    corrections.push({ report, mode: urgent ? "now" : "boundary" });
  }
  return corrections;
}

// WARNING: sent without a human reading it; it must make the agent report a conflict, not pick one silently.
export function correctionText(deliveryId: string, constraint: Constraint, report: DriftReport) {
  const evidence = Arr.join(
    Arr.map(
      report.evidence,
      (ref) =>
        `${ref.path ?? ref.kind}${ref.line === undefined ? "" : `:${ref.line}`}${ref.excerpt === undefined ? "" : ` (${ref.excerpt})`}`,
    ),
    "; ",
  );
  return Arr.join(
    [
      `Steering correction ${deliveryId} for constraint ${constraint.id}: ${constraint.text}.`,
      `Evidence: ${evidence || "none recorded"}.`,
      "Bring the work back within this constraint; if that conflicts with the goal, say so",
      "in your Output instead of choosing.",
    ],
    " ",
  );
}

export function correctionsSent(
  deliveries: ReadonlyArray<{ readonly cause: { readonly kind: string; readonly ref: string } }>,
) {
  const counted: Record<string, number> = {};
  for (const delivery of deliveries) {
    if (delivery.cause.kind === "correction") {
      counted[delivery.cause.ref] = (counted[delivery.cause.ref] ?? 0) + 1;
    }
  }
  return counted;
}

// WARNING: true needs every rule passing and every semantic constraint judged untruncated; unverified is the honest answer when nobody looked.
export interface Alignment {
  readonly aligned: "true" | "false" | "unverified";
  readonly why: string;
}

export function standingSkips(lines: ReadonlyArray<DriftLine>, judged: Pick<Judged, "at">) {
  const answered = (line: Schema.Schema.Type<typeof SkippedSchema>) =>
    line.check === undefined && judged.at !== undefined && line.at < judged.at;
  const reasons = Arr.flatMap(lines, (line) =>
    line.kind === "skipped" && !answered(line) ? [line.reason] : [],
  );
  return [...new Set(reasons)];
}

export function alignment(intent: Intent | null, lines: ReadonlyArray<DriftLine>, judged: Judged) {
  if (intent === null) {
    const returned: Alignment = {
      aligned: "unverified",
      why: "the Run has no Intent to compare to",
    };
    return returned;
  }
  if (intent.constraints.length === 0) {
    const returned: Alignment = { aligned: "unverified", why: "nothing was judged" };
    return returned;
  }
  const open = openReports(lines);
  if (Arr.some(open, (report) => report.severity === "block")) {
    const returned: Alignment = {
      aligned: "false",
      why: `${open.length} open report(s), at least one blocking`,
    };
    return returned;
  }
  const skippedReasons = standingSkips(lines, judged);
  if (skippedReasons.length > 0) {
    const returned: Alignment = {
      aligned: "unverified",
      why: `a judgement was skipped: ${skippedReasons.at(-1) ?? ""}`,
    };
    return returned;
  }
  const hasSemantic = Arr.some(intent.constraints, (c) => c.kind === "semantic");
  if (hasSemantic && !judged.semantic) {
    const returned: Alignment = {
      aligned: "unverified",
      why: "the semantic constraints were never judged",
    };
    return returned;
  }
  if (judged.truncated) {
    const returned: Alignment = {
      aligned: "unverified",
      why: "the evidence a judgement saw was truncated",
    };
    return returned;
  }
  if (open.length > 0) {
    const returned: Alignment = { aligned: "unverified", why: `${open.length} open warning(s)` };
    return returned;
  }
  const returned: Alignment = {
    aligned: "true",
    why: "every constraint was checked and none is open",
  };
  return returned;
}

// WARNING: a report on an older Intent version or a removed constraint is superseded, not left open.
export function supersededBy(reports: ReadonlyArray<DriftReport>, intent: Intent) {
  const live = new Set(Arr.map(intent.constraints, (constraint) => constraint.id));
  return Arr.filter(
    reports,
    (report) => report.intent_version < intent.version || !live.has(report.constraint),
  );
}

// WARNING: a loser's dirty line is what stops the winner's answer going stale.
const ElectionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["candidate", "dirty"]),
    at: Schema.String,
    by: Schema.String,
    run: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("pending"),
    since: Schema.String,
    runs: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("evaluated"),
    at: Schema.String,
    by: Schema.String,
    runs: Schema.Array(Schema.String),
  }),
]);
export type ElectionLine = Schema.Schema.Type<typeof ElectionSchema>;
export type PendingEvaluation = Extract<ElectionLine, { kind: "pending" }>;
const ElectionJson = Schema.fromJsonString(ElectionSchema);

export const electionsPath = Effect.fn("Drift.electionsPath")(function* (
  stateDir: string,
  herdKey: string,
) {
  const path = yield* Path.Path;
  return path.join(stateDir, "herd", herdKey, "elections.jsonl");
});

export const readElections = (file: string) => readJournal(file, ElectionJson);

export const appendElection = (file: string, line: ElectionLine) =>
  appendJournal(file, ElectionJson, line);

// WARNING: a pending line wakes every Driver in the Herd, not only siblings; a parent may never run again.
export function shouldStand(lines: ReadonlyArray<ElectionLine>, hasSiblings: boolean) {
  if (hasSiblings) {
    return true;
  }
  return pendingEvaluation(lines) !== null;
}

export function alreadyStood(lines: ReadonlyArray<ElectionLine>, run: string) {
  const pending = pendingEvaluation(lines);
  if (pending === null) {
    return false;
  }
  return Arr.some(
    lines,
    (line) => line.kind === "candidate" && line.run === run && line.at >= pending.since,
  );
}

// WARNING: a pending mark stands until an evaluated line covers all its Runs; otherwise every Driver stands forever.
export function pendingEvaluation(lines: ReadonlyArray<ElectionLine>) {
  let latest: PendingEvaluation | null = null;
  for (const line of lines) {
    if (line.kind === "pending") {
      latest = line;
    } else if (
      line.kind === "evaluated" &&
      latest !== null &&
      Arr.every(latest.runs, (run) => line.runs.includes(run))
    ) {
      latest = null;
    }
  }
  return latest;
}

export function staleSince(lines: ReadonlyArray<ElectionLine>, snapshotAt: string) {
  return Arr.some(lines, (line) => line.kind === "dirty" && line.at > snapshotAt);
}

export const EXTRA_PASSES = 2;

export function evaluatedFor(lines: ReadonlyArray<ElectionLine>, run: string) {
  let answered = false;
  for (const line of lines) {
    if (line.kind === "evaluated") {
      answered = line.runs.includes(run);
    } else if (line.kind === "dirty" || line.kind === "pending") {
      answered = false;
    }
  }
  return answered;
}
