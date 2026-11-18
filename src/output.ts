import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Effect, FileSystem, Schema, SchemaGetter, flow, Result } from "effect";
import { isBoolean, isNumber, isString } from "./schema";
import { checkProof, owesNothingHere, unstableWhy, type CheckProof } from "./check-proof";
import type { Measurement } from "./measurement-model";
import type { CheckCommand, Snapshot, Verification } from "./verify";
import { isYamlMap, YamlValueJsonSchema, type YamlValue } from "./yaml";

const said = (field: string) =>
  Schema.refine<Schema.String, string>((value): value is string => Str.trim(value) !== "", {
    title: `${field} is required`,
    message: `${field} is required, and must not be blank`,
  });

const optionalList = <S extends Schema.Top>(item: S) =>
  Schema.NullOr(Schema.Array(item)).pipe(
    Schema.decodeTo(Schema.Array(item), {
      decode: SchemaGetter.transform((value) => value ?? []),
      encode: SchemaGetter.passthrough(),
    }),
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  );

const listed = <
  S extends Schema.Top & {
    readonly Type: { readonly verdict: string; readonly findings: ReadonlyArray<unknown> };
  },
>() =>
  Schema.refine<S, S["Type"]>(
    (value): value is S["Type"] => value.verdict !== "findings" || value.findings.length > 0,
    {
      title: 'verdict "findings" with an empty findings list',
      message:
        'verdict "findings" needs at least one entry in findings; with nothing to report, write verdict "clean"',
    },
  );

export const FindingSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String.pipe(said("id"))),
  status: Schema.optionalKey(Schema.Literals(["open", "fixed", "disputed", "obsolete"])),
  head: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
  file: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Finite),
  severity: Schema.String.annotate({
    description: "blocker, major or minor; any other word is treated as blocking",
  }).pipe(said("severity")),
  title: Schema.String.pipe(said("title")),
  detail: Schema.optionalKey(Schema.String),
  internal: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "true only for a finding about Collie's own process" }),
  ),
  rebuttal: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
});

export interface Finding {
  id?: string;
  status?: "open" | "fixed" | "disputed" | "obsolete";
  head?: string;
  note?: string;
  file?: string;
  line?: number;
  severity: string;
  title: string;
  detail?: string;
  internal?: boolean;
  rebuttal?: string;
  reason?: string;
}

export interface ReviewOutput {
  verdict: "clean" | "findings";
  findings: Finding[];
  disputed: Finding[];
  scope_met?: boolean;
  behavior_preserved?: boolean;
  supported?: boolean;
  accurate?: boolean;
  compatible?: boolean;
  measurement_valid?: boolean;
}

export interface Synthesis extends ReviewOutput {
  summary: string;
  public_summary?: string;
  dropped: Finding[];
  fixed: Fixed[];
}

export interface Fixed {
  file?: string;
  title: string;
  note?: string;
}

const VerdictSchema = Schema.Literals(["clean", "findings"]);

const JUDGEMENTS = {
  scope_met: Schema.optionalKey(Schema.Boolean),
  behavior_preserved: Schema.optionalKey(Schema.Boolean),
  supported: Schema.optionalKey(Schema.Boolean),
  accurate: Schema.optionalKey(Schema.Boolean),
  compatible: Schema.optionalKey(Schema.Boolean),
  measurement_valid: Schema.optionalKey(Schema.Boolean),
};

export const ReviewOutputSchema = Schema.Struct({
  verdict: VerdictSchema,
  findings: optionalList(FindingSchema),
  disputed: optionalList(FindingSchema),
  ...JUDGEMENTS,
}).pipe(listed());

export const ReassessmentSchema = (ids: ReadonlyArray<string>) => {
  const status = Schema.StructWithRest(
    Schema.Struct({
      id: Schema.String,
      status: Schema.Literals(["open", "fixed", "disputed", "obsolete"]),
      reason: Schema.String.pipe(said("reason")),
    }),
    [
      Schema.Record(
        Schema.String.check(Schema.isPattern(/^(?!(?:id|status|reason)$)/u)),
        Schema.Never,
      ),
    ],
  );
  const output = Schema.StructWithRest(Schema.Struct({ findings: Schema.Array(status) }), [
    Schema.Record(Schema.String.check(Schema.isPattern(/^(?!findings$)/u)), Schema.Never),
  ]);
  return output.pipe(
    Schema.refine<typeof output, typeof output.Type>(
      (value): value is typeof output.Type =>
        value.findings.length === ids.length &&
        new Set(Arr.map(value.findings, (one) => one.id)).size === ids.length &&
        Arr.every(value.findings, (one) => ids.includes(one.id)),
      { message: "return exactly one status for each supplied finding id" },
    ),
  );
};

export const FixedSchema = Schema.Struct({
  file: Schema.optionalKey(Schema.String),
  title: Schema.String.pipe(said("title")),
  note: Schema.optionalKey(Schema.String),
});

const DroppedSchema = FindingSchema.pipe(
  Schema.refine<typeof FindingSchema, typeof FindingSchema.Type>(
    (value): value is typeof FindingSchema.Type => Str.trim(value.reason ?? "") !== "",
    {
      title: "reason is required",
      message: "a dropped finding needs a reason saying why it was dropped",
    },
  ),
);

export const SynthesisSchema = Schema.Struct({
  verdict: VerdictSchema,
  summary: Schema.String.pipe(said("summary")),
  public_summary: Schema.optionalKey(Schema.String.pipe(said("public_summary"))),
  findings: optionalList(FindingSchema),
  disputed: optionalList(FindingSchema),
  dropped: optionalList(DroppedSchema),
  fixed: optionalList(FixedSchema),
  ...JUDGEMENTS,
}).pipe(listed());

export const CheckSchema = Schema.Struct({
  name: Schema.String.pipe(said("name")),
  note: Schema.optionalKey(Schema.String),
});

export const CriterionSchema = Schema.Struct({
  criterion: Schema.String.annotate({
    description: "the criterion, copied from the ticket",
  }).pipe(said("criterion")),
  met: Schema.String.annotate({
    description:
      'how it is met — the test or the file that shows it — "not met: <reason>", or "after merge: <reason>" where only CI, a merge or a deploy can show it',
  }).pipe(said("met")),
});
export type Criterion = typeof CriterionSchema.Type;

const criterionKey = (text: string) =>
  Str.trim(
    pipe(
      Str.toLowerCase(text),
      Str.replace(/[*_`]/g, ""),
      Str.replace(/\s+/g, " "),
      Str.replace(/[.:;\s]+$/, ""),
    ),
  );

export const answerFor = (criterion: string, answers: ReadonlyArray<Criterion>) =>
  Option.getOrUndefined(
    Arr.findLast(answers, (one) => criterionKey(one.criterion) === criterionKey(criterion)),
  );

export function unmetCriteria(
  ticket: string,
  criteria: ReadonlyArray<string>,
  answers: ReadonlyArray<Criterion>,
) {
  return Arr.flatMap(criteria, (criterion) => {
    const met = answerFor(criterion, answers)?.met;
    if (met === undefined)
      return [
        {
          file: ticket,
          severity: "blocker",
          title: `acceptance criterion not answered: ${criterion}`,
          detail: "The builder's Output says nothing of how this criterion is met.",
        },
      ];
    if (/^not met\b/i.test(Str.trim(met)))
      return [
        {
          file: ticket,
          severity: "blocker",
          title: `acceptance criterion not met: ${criterion}`,
          detail: met,
        },
      ];
    return [];
  });
}

export const afterMergeAnswers = (
  criteria: ReadonlyArray<string>,
  answers: ReadonlyArray<Criterion>,
) =>
  Arr.flatMap(criteria, (criterion) => {
    const met = answerFor(criterion, answers)?.met;
    return met !== undefined && /^after merge\b/i.test(Str.trim(met)) ? [{ criterion, met }] : [];
  });

export const FixOutputSchema = Schema.Struct({
  verdict: VerdictSchema.annotate({
    description:
      '"findings" only where findings are left unresolved, each listed in "findings"; what you fixed goes in "fixed" and what you dispute in "disputed", and with nothing left unresolved the verdict is "clean"',
  }),
  findings: optionalList(FindingSchema),
  fixed: optionalList(FixedSchema),
  disputed: optionalList(FindingSchema),
  checks: optionalList(CheckSchema),
}).pipe(listed());

export const MrOutputSchema = Schema.Struct({
  pushed: Schema.Boolean,
  mr_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  note: Schema.optionalKey(Schema.String),
});

export const PlanOutputSchema = Schema.Struct({
  issues_dir: Schema.String.pipe(said("issues_dir")),
  spec: Schema.optionalKey(Schema.String),
});

export const REVIEW_FILE = "review.md";

export const FINDINGS_FILE = "findings.json";

const FindingsJson = Schema.fromJsonString(Schema.Array(FindingSchema));
const decodeFindings = Schema.decodeUnknownEffect(FindingsJson);
const encodeFindings = flow(Schema.encodeResult(FindingsJson), Result.getOrThrow);

export const leaveReview = (dir: string, synthesis: typeof SynthesisSchema.Type) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      Effect.all([
        fs.writeFileString(`${dir}/${REVIEW_FILE}`, renderReview(synthesis)),
        fs.writeFileString(`${dir}/${FINDINGS_FILE}`, encodeFindings(synthesis.findings)),
      ]),
    ),
    Effect.asVoid,
    Effect.orDie,
  );

export const leaveOutstanding = (dir: string, outstanding: ReadonlyArray<Finding>) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.writeFileString(`${dir}/${FINDINGS_FILE}`, encodeFindings(outstanding)),
    ),
    Effect.orDie,
  );

export function riskLine(risks: string) {
  const asked = Str.trim(risks);
  if (asked === "") return "";
  return (
    `Additional axes requested for this change: ${asked}. Apply the matching skill where ` +
    `one is installed (\`security-and-hardening\`, \`performance-optimization\`) and say in ` +
    `your review which of them you applied. These are on top of the complete review, not ` +
    `instead of it.`
  );
}

export const findingsIn = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(`${dir}/${REVIEW_FILE}`))) return [];
    return yield* decodeFindings(yield* fs.readFileString(`${dir}/${FINDINGS_FILE}`));
  }).pipe(Effect.orElseSucceed(() => []));

export const openFindingsIn = (dir: string) =>
  findingsIn(dir).pipe(
    Effect.map(
      (found) => Arr.filter(found, (f) => f.status !== "fixed" && f.status !== "obsolete").length,
    ),
  );

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseJson(text: string, where: string) {
  try {
    const returned: Parsed<YamlValue> = {
      ok: true,
      value: flow(Schema.decodeResult(YamlValueJsonSchema), Result.getOrThrow)(text),
    };
    return returned;
  } catch (cause) {
    const returned: Parsed<YamlValue> = {
      ok: false,
      error: `${where}: not valid JSON (${String(cause)})`,
    };
    return returned;
  }
}

function display(value: YamlValue | undefined) {
  return value === undefined
    ? "undefined"
    : flow(Schema.encodeResult(YamlValueJsonSchema), Result.getOrThrow)(value);
}

export function parseReviewOutput(text: string, where: string) {
  const parsed = parseJson(text, where);
  if (!parsed.ok) {
    const returned: Parsed<ReviewOutput> = parsed;
    return returned;
  }
  if (!isYamlMap(parsed.value)) {
    const returned: Parsed<ReviewOutput> = { ok: false, error: `${where}: expected a JSON object` };
    return returned;
  }
  const obj = parsed.value;
  if (obj.verdict !== "clean" && obj.verdict !== "findings") {
    const returned: Parsed<ReviewOutput> = {
      ok: false,
      error: `${where}: verdict must be "clean" or "findings", got ${display(obj.verdict)}`,
    };
    return returned;
  }
  const findings = parseFindings(obj.findings, `${where}: findings`);
  if (!findings.ok) {
    const returned: Parsed<ReviewOutput> = findings;
    return returned;
  }
  const disputed = parseFindings(obj.disputed, `${where}: disputed`);
  if (!disputed.ok) {
    const returned: Parsed<ReviewOutput> = disputed;
    return returned;
  }
  if (obj.verdict === "findings" && findings.value.length === 0) {
    const returned: Parsed<ReviewOutput> = {
      ok: false,
      error: `${where}: verdict "findings" with an empty findings list`,
    };
    return returned;
  }
  const returned: Parsed<ReviewOutput> = {
    ok: true,
    value: { verdict: obj.verdict, findings: findings.value, disputed: disputed.value },
  };
  return returned;
}

export function parseFindings(raw: YamlValue | undefined, where: string) {
  if (raw === undefined || raw === null) {
    const returned: Parsed<Finding[]> = { ok: true, value: [] };
    return returned;
  }
  if (!Arr.isArray<typeof raw>(raw)) {
    const returned: Parsed<Finding[]> = { ok: false, error: `${where}: expected an array` };
    return returned;
  }
  const out: Finding[] = [];
  for (const [index, item] of raw.entries()) {
    if (!isYamlMap(item)) {
      const returned: Parsed<Finding[]> = {
        ok: false,
        error: `${where}[${index}]: expected an object`,
      };
      return returned;
    }
    if (!isString(item.title) || Str.trim(item.title) === "") {
      const returned: Parsed<Finding[]> = {
        ok: false,
        error: `${where}[${index}]: title is required`,
      };
      return returned;
    }
    if (!isString(item.severity) || Str.trim(item.severity) === "") {
      const returned: Parsed<Finding[]> = {
        ok: false,
        error: `${where}[${index}]: severity is required`,
      };
      return returned;
    }
    const finding: Finding = { severity: item.severity, title: item.title };
    if (item.id !== undefined) {
      if (!isString(item.id) || Str.trim(item.id) === "") {
        const returned: Parsed<Finding[]> = {
          ok: false,
          error: `${where}[${index}].id is required and must not be blank`,
        };
        return returned;
      }
      finding.id = item.id;
    }
    if (item.status !== undefined) {
      if (
        item.status !== "open" &&
        item.status !== "fixed" &&
        item.status !== "disputed" &&
        item.status !== "obsolete"
      ) {
        const returned: Parsed<Finding[]> = {
          ok: false,
          error: `${where}[${index}].status must be open, fixed, disputed or obsolete`,
        };
        return returned;
      }
      finding.status = item.status;
    }
    if (isString(item.head)) finding.head = item.head;
    if (isString(item.note)) finding.note = item.note;
    if (isString(item.file)) finding.file = item.file;
    if (isNumber(item.line)) finding.line = item.line;
    if (isString(item.detail)) finding.detail = item.detail;
    if (item.internal !== undefined) {
      if (!isBoolean(item.internal)) {
        const returned: Parsed<Finding[]> = {
          ok: false,
          error: `${where}[${index}]: internal must be a boolean`,
        };
        return returned;
      }
      finding.internal = item.internal;
    }
    if (isString(item.rebuttal)) finding.rebuttal = item.rebuttal;
    if (isString(item.reason)) finding.reason = item.reason;
    out.push(finding);
  }
  const returned: Parsed<Finding[]> = { ok: true, value: out };
  return returned;
}

export function findingKey(f: Pick<Finding, "file" | "title">) {
  return `${f.file ?? ""}::${Str.toLowerCase(Str.trim(f.title))}`;
}

export function sameFinding(left: Finding, right: Finding) {
  return left.id !== undefined && right.id !== undefined
    ? left.id === right.id
    : findingKey(left) === findingKey(right);
}

export function parseSynthesis(text: string, where: string) {
  const base = parseReviewOutput(text, where);
  if (!base.ok) {
    const returned: Parsed<Synthesis> = base;
    return returned;
  }
  const parsed = parseJson(text, where);
  if (!parsed.ok || !isYamlMap(parsed.value)) {
    const returned: Parsed<Synthesis> = { ok: false, error: `${where}: expected a JSON object` };
    return returned;
  }
  const obj = parsed.value;
  if (!isString(obj.summary) || Str.trim(obj.summary) === "") {
    const returned: Parsed<Synthesis> = { ok: false, error: `${where}: summary is required` };
    return returned;
  }
  if (
    obj.public_summary !== undefined &&
    (!isString(obj.public_summary) || Str.trim(obj.public_summary) === "")
  ) {
    const returned: Parsed<Synthesis> = {
      ok: false,
      error: `${where}: public_summary must be a non-blank string`,
    };
    return returned;
  }
  const dropped = parseFindings(obj.dropped, `${where}: dropped`);
  if (!dropped.ok) {
    const returned: Parsed<Synthesis> = dropped;
    return returned;
  }
  for (const [i, finding] of dropped.value.entries()) {
    if (!finding.reason || Str.trim(finding.reason) === "") {
      const returned: Parsed<Synthesis> = {
        ok: false,
        error: `${where}: dropped[${i}]: reason is required`,
      };
      return returned;
    }
  }
  const fixed = parseFixed(obj.fixed, `${where}: fixed`);
  if (!fixed.ok) {
    const returned: Parsed<Synthesis> = fixed;
    return returned;
  }
  const value: Synthesis = {
    ...base.value,
    summary: Str.trim(obj.summary),
    dropped: dropped.value,
    fixed: fixed.value,
  };
  if (isString(obj.public_summary)) value.public_summary = Str.trim(obj.public_summary);
  const returned: Parsed<Synthesis> = { ok: true, value };
  return returned;
}

export function parseFixed(value: YamlValue | undefined, where: string) {
  if (value === undefined || value === null) {
    const returned: Parsed<Fixed[]> = { ok: true, value: [] };
    return returned;
  }
  if (!Arr.isArray<typeof value>(value)) {
    const returned: Parsed<Fixed[]> = { ok: false, error: `${where}: expected a list` };
    return returned;
  }
  const out: Fixed[] = [];
  for (const [i, item] of value.entries()) {
    if (!isYamlMap(item)) {
      const returned: Parsed<Fixed[]> = { ok: false, error: `${where}[${i}]: expected an object` };
      return returned;
    }
    if (!isString(item.title) || Str.trim(item.title) === "") {
      const returned: Parsed<Fixed[]> = { ok: false, error: `${where}[${i}]: title is required` };
      return returned;
    }
    const entry: Fixed = { title: Str.trim(item.title) };
    if (isString(item.file)) entry.file = item.file;
    if (isString(item.note)) entry.note = item.note;
    out.push(entry);
  }
  const returned: Parsed<Fixed[]> = { ok: true, value: out };
  return returned;
}

export interface Check {
  name: string;
  note?: string;
}

export interface FixOutput {
  verdict: "clean" | "findings";
  findings: Finding[];
  fixed: Fixed[];
  disputed: Finding[];
  checks: Check[];
}

export function parseFixOutput(raw: YamlValue, where: string) {
  if (!isYamlMap(raw)) {
    const returned: Parsed<FixOutput> = { ok: false, error: `${where}: expected a JSON object` };
    return returned;
  }
  if (raw.verdict !== "clean" && raw.verdict !== "findings") {
    const returned: Parsed<FixOutput> = {
      ok: false,
      error: `${where}: verdict must be "clean" or "findings"`,
    };
    return returned;
  }
  const findings = parseFindings(raw.findings, `${where}: findings`);
  if (!findings.ok) {
    const returned: Parsed<FixOutput> = findings;
    return returned;
  }
  if (raw.verdict === "findings" && findings.value.length === 0) {
    const returned: Parsed<FixOutput> = {
      ok: false,
      error: `${where}: verdict "findings" with an empty findings list`,
    };
    return returned;
  }
  const fixed = parseFixed(raw.fixed, `${where}: fixed`);
  if (!fixed.ok) {
    const returned: Parsed<FixOutput> = fixed;
    return returned;
  }
  const disputed = parseFindings(raw.disputed, `${where}: disputed`);
  if (!disputed.ok) {
    const returned: Parsed<FixOutput> = disputed;
    return returned;
  }
  const checks = parseChecks(raw.checks, `${where}: checks`);
  if (!checks.ok) {
    const returned: Parsed<FixOutput> = checks;
    return returned;
  }
  const returned: Parsed<FixOutput> = {
    ok: true,
    value: {
      verdict: raw.verdict,
      findings: findings.value,
      fixed: fixed.value,
      disputed: disputed.value,
      checks: checks.value,
    },
  };
  return returned;
}

function parseChecks(value: YamlValue | undefined, where: string) {
  if (value === undefined || value === null) {
    const returned: Parsed<Check[]> = { ok: true, value: [] };
    return returned;
  }
  if (!Arr.isArray<typeof value>(value)) {
    const returned: Parsed<Check[]> = { ok: false, error: `${where}: expected a list` };
    return returned;
  }
  const out: Check[] = [];
  for (const [i, item] of value.entries()) {
    if (!isYamlMap(item)) {
      const returned: Parsed<Check[]> = { ok: false, error: `${where}[${i}]: expected an object` };
      return returned;
    }
    if (!isString(item.name) || Str.trim(item.name) === "") {
      const returned: Parsed<Check[]> = { ok: false, error: `${where}[${i}]: name is required` };
      return returned;
    }
    const check: Check = { name: Str.trim(item.name) };
    if (isString(item.note)) check.note = item.note;
    out.push(check);
  }
  const returned: Parsed<Check[]> = { ok: true, value: out };
  return returned;
}

export function substantiated(finding: Finding) {
  if (!isBlocking(finding)) return true;
  return Str.trim(finding.file ?? "") !== "" && Str.trim(finding.detail ?? "") !== "";
}

export function unsubstantiated(findings: ReadonlyArray<Finding>) {
  const bad = Arr.filter(findings, (f) => !substantiated(f));
  if (bad.length === 0) return null;
  const named = Arr.join(
    Arr.map(bad, (f) => `"${f.title}"`),
    ", ",
  );
  return (
    `${bad.length} blocking finding(s) say neither where nor why: ${named}. ` +
    `Every blocker and major needs a "file" it is about and a "detail" of one or two ` +
    `sentences. The file need not be one the change touched.`
  );
}

export function isBlocking(finding: Finding) {
  return (
    finding.status !== "fixed" && finding.status !== "obsolete" && finding.severity !== "minor"
  );
}

export type Halt =
  | "no_progress"
  | "dispute_unresolved"
  | "fix_unverified"
  | "definition_changed"
  | "evidence_missing";

export function blockingKeys(findings: ReadonlyArray<Finding>) {
  return [
    ...new Set(
      Arr.map(
        Arr.filter(findings, (f) => isBlocking(f) && !f.rebuttal),
        findingKey,
      ),
    ),
  ].sort();
}

export type Rally =
  | { readonly go: "clean"; readonly remaining: Finding[] }
  | {
      readonly go: "fix";
      readonly live: Finding[];
      readonly blocking: Finding[];
      readonly keys: ReadonlyArray<string>;
    }
  | {
      readonly go: "halt";
      readonly halt: Halt;
      readonly reason: string;
      readonly outstanding: Finding[];
    };

export function settleRound(round: {
  readonly live: ReadonlyArray<Finding>;
  readonly disputed: ReadonlyArray<Finding>;
  readonly reopened?: ReadonlyArray<Finding>;
  readonly at: number;
  readonly seen?: { readonly at: number; readonly keys: ReadonlyArray<string> } | null;
}) {
  const live = Arr.filter(round.live, (f) => f.status !== "fixed" && f.status !== "obsolete");
  const reopened = [...(round.reopened ?? [])];
  const blocking = [...Arr.filter(live, isBlocking), ...reopened];
  if (blocking.length === 0) {
    const standing = Arr.dedupeWith(
      Arr.filter(round.disputed, isBlocking),
      (left: Finding, right: Finding) => sameFinding(left, right),
    );
    if (standing.length > 0) {
      const returned: Rally = {
        go: "halt",
        halt: "dispute_unresolved",
        reason: `${standing.length} disputed blocking finding(s) stand unanswered — your call, not the loop's`,
        outstanding: [...standing, ...live],
      };
      return returned;
    }
    const returned: Rally = { go: "clean", remaining: live };
    return returned;
  }
  const keys = blockingKeys(live);
  const seen = round.seen;
  if (
    seen &&
    seen.at < round.at &&
    keys.length > 0 &&
    keys.length === seen.keys.length &&
    Arr.every(keys, (key, at) => key === seen.keys[at])
  ) {
    const returned: Rally = {
      go: "halt",
      halt: "no_progress",
      reason: `no progress: review ${round.at} raised the same ${keys.length} blocking finding(s) as review ${seen.at}`,
      outstanding: live,
    };
    return returned;
  }
  const returned: Rally = { go: "fix", live: [...live, ...reopened], blocking, keys };
  return returned;
}

export type FinalFix =
  | { ok: true; attestation: string; outstanding: Finding[] }
  | {
      ok: false;
      halt: "dispute_unresolved";
      attestation: string;
      reasons: string[];
      outstanding: Finding[];
    }
  | { ok: false; halt: "fix_unverified"; reasons: string[]; outstanding: Finding[] };

export interface FixReport {
  readonly verdict: "clean" | "findings";
  readonly findings: ReadonlyArray<Finding>;
  readonly fixed: ReadonlyArray<Fixed>;
  readonly disputed: ReadonlyArray<Finding>;
  readonly checks: ReadonlyArray<Check>;
}

export interface CheckEvidence {
  readonly verifications: ReadonlyArray<Verification>;
  readonly final: Snapshot;
  readonly commands?: ReadonlyArray<CheckCommand>;
  readonly measurements?: ReadonlyArray<Measurement>;
  readonly mergeBase?: string | null;
  readonly content?: string;
}

function checkGap(name: string, proof: CheckProof, evidence: CheckEvidence) {
  switch (proof.state) {
    case "passed":
    case "waiting":
    case "proved":
    case "earlier":
      return null;
    case "never":
      return Option.getOrUndefined(
        Option.map(Option.fromNullishOr(evidence.commands), (present_) =>
          Arr.some(present_, (command) => command.name === name),
        ),
      )
        ? null
        : `check "${name}" has no verification record — run it through collie verify`;
    case "failed":
      return `check failed: ${name}`;
    case "unstable":
      return `check "${name}" ${unstableWhy(proof.runs)}`;
  }
}

export function settleFinalFix(
  live: ReadonlyArray<Finding>,
  fix: FixReport,
  evidence: CheckEvidence,
) {
  const fixed = new Set(Arr.map(fix.fixed, findingKey));
  const disputed = new Map(Arr.map(fix.disputed, (d) => [findingKey(d), d]));
  const disputeLine = (f: Finding) => {
    const reason = disputed.get(findingKey(f))?.reason;
    return `disputed blocking finding: ${oneLine(f)}${reason ? `: ${reason}` : ""}`;
  };
  const disputes: string[] = [];
  const unverified: string[] = [];
  const ownBlocking = Arr.filter(fix.findings, isBlocking);
  const ownMinor = Arr.filter(fix.findings, (f) => !isBlocking(f));
  if (fix.verdict !== "clean" && fix.findings.length === 0)
    unverified.push(`the fix reports verdict "findings"`);
  if (ownBlocking.length > 0) {
    unverified.push(
      `the fix reports ${ownBlocking.length} blocking finding(s) of its own: ${Arr.join(Arr.map(ownBlocking, oneLine), ", ")}`,
    );
  }
  const seen = new Set<string>();
  for (const entry of [...fix.fixed, ...fix.disputed]) {
    const key = findingKey(entry);
    if (seen.has(key) && !(fixed.has(key) && disputed.has(key))) {
      unverified.push(`duplicate disposition: ${key}`);
    }
    seen.add(key);
  }
  for (const finding of Arr.filter(live, isBlocking)) {
    const key = findingKey(finding);
    if (fixed.has(key) && disputed.has(key)) {
      unverified.push(`both fixed and disputed: ${oneLine(finding)}`);
    } else if (fixed.has(key)) {
      continue;
    } else if (disputed.has(key)) {
      disputes.push(disputeLine(finding));
    } else {
      unverified.push(`no disposition for ${oneLine(finding)}`);
    }
  }
  const raised = new Set(Arr.map(live, findingKey));
  const standing = Arr.filter(fix.disputed, (d) => isBlocking(d) && !raised.has(findingKey(d)));
  for (const d of standing) disputes.push(disputeLine(d));
  if (fix.checks.length === 0) unverified.push("no checks reported");
  const verifiedHere: string[] = [];
  const leftToGate: string[] = [];
  for (const check of fix.checks) {
    const proof = checkProof(evidence, check.name);
    const gap = checkGap(check.name, proof, evidence);
    if (gap !== null) unverified.push(`${gap}${check.note ? ` (${check.note})` : ""}`);
    else if (owesNothingHere(proof)) verifiedHere.push(check.name);
    else leftToGate.push(check.name);
  }
  const unresolved = [...live, ...fix.findings, ...standing];
  if (unverified.length > 0) {
    const returned: FinalFix = {
      ok: false,
      halt: "fix_unverified",
      reasons: [...unverified, ...disputes],
      outstanding: unresolved,
    };
    return returned;
  }
  const reportedFixed = Arr.filter(live, (f) => isBlocking(f) && fixed.has(findingKey(f))).length;
  const disputedToo = disputes.length > 0 ? `, ${disputes.length} disputed` : "";
  const gateToo =
    leftToGate.length > 0
      ? `, ${leftToGate.length} left to the gate on the final tree (${Arr.join(leftToGate, ", ")})`
      : "";
  const leftOpen =
    ownMinor.length > 0
      ? `, ${ownMinor.length} non-blocking finding(s) of its own left open (${Arr.join(Arr.map(ownMinor, oneLine), ", ")})`
      : "";
  const attestation = `last fix: ${reportedFixed} blocking finding(s) reported fixed${disputedToo}, ${verifiedHere.length} check(s) verified on this tree${gateToo}${leftOpen} — implementer-reported, not re-reviewed`;
  if (disputes.length > 0) {
    const returned: FinalFix = {
      ok: false,
      halt: "dispute_unresolved",
      attestation,
      reasons: disputes,
      outstanding: unresolved,
    };
    return returned;
  }
  const returned: FinalFix = {
    ok: true,
    attestation,
    outstanding: [...Arr.filter(live, (f) => !fixed.has(findingKey(f))), ...ownMinor],
  };
  return returned;
}

const oneLine = (f: Finding) => `[${f.severity}] ${f.title}${f.file ? ` (${f.file})` : ""}`;

const SEVERITIES = ["blocker", "major", "minor"];

function severityOrder(findings: ReadonlyArray<Finding>) {
  const present = [...new Set(Arr.map(findings, (f) => f.severity))];
  const known = Arr.filter(SEVERITIES, (s) => present.includes(s));
  return [...known, ...Arr.filter(present, (s) => !SEVERITIES.includes(s)).sort()];
}

export function renderReview(synthesis: typeof SynthesisSchema.Type) {
  const blocks = [Str.trim(synthesis.summary)];
  if (synthesis.fixed.length > 0) {
    blocks.push("**Fixed since last review**");
    blocks.push(
      Arr.join(
        Arr.map(synthesis.fixed, (f) => {
          const at = f.file ? `\`${f.file}\` — ` : "";
          const text = Option.getOrElse(
            Option.map(Option.fromNullishOr(f.note), Str.trim),
            () => "",
          );
          const note = text ? `\n  ${pipe(text, Str.replace(/\s*\n\s*/g, " "))}` : "";
          return `- ${at}${Str.trim(f.title)}${note}`;
        }),
        "\n",
      ),
    );
  }
  if (synthesis.findings.length === 0) {
    blocks.push("Nothing to fix.");
  } else {
    for (const severity of severityOrder(synthesis.findings)) {
      const group = Arr.filter(synthesis.findings, (f) => f.severity === severity);
      blocks.push(
        `**${Str.toUpperCase(Option.getOrElse(Str.charAt(severity, 0), () => ""))}${pipe(severity, Str.slice(1))}**`,
      );
      blocks.push(Arr.join(Arr.map(group, reviewBullet), "\n"));
    }
  }
  return `${Arr.join(blocks, "\n\n")}\n`;
}

export function renderPublicReview(synthesis: typeof SynthesisSchema.Type) {
  return renderReview({
    ...synthesis,
    summary: synthesis.public_summary ?? synthesis.summary,
    findings: Arr.filter(synthesis.findings, (finding) => finding.internal !== true),
    fixed: [],
  });
}

function reviewBullet(finding: Finding) {
  const at = finding.file ? `\`${finding.file}${finding.line ? `:${finding.line}` : ""}\` — ` : "";
  const text = Option.getOrElse(
    Option.map(Option.fromNullishOr(finding.detail), Str.trim),
    () => "",
  );
  const detail = text ? `\n  ${pipe(text, Str.replace(/\s*\n\s*/g, " "))}` : "";
  const identity = finding.id ? `${finding.id}: ${finding.status ?? "open"} — ` : "";
  return `- ${identity}${at}${Str.trim(finding.title)}${detail}`;
}

export interface Split {
  live: Finding[];
  settled: Finding[];
  rebutted: Finding[];
}

type Disposed = {
  readonly findings: ReadonlyArray<Finding>;
  readonly disputed: ReadonlyArray<Finding>;
  readonly dropped: ReadonlyArray<Finding>;
  readonly fixed: ReadonlyArray<Fixed>;
};

const isOpen = (finding: Finding) =>
  finding.status === undefined || finding.status === "open" || finding.status === "disputed";

function standingIn(review: Disposed) {
  return [...Arr.filter(review.findings, isOpen), ...review.disputed];
}

const withdrawnIn = (review: Disposed) =>
  Arr.filter(review.dropped, (one) => Str.trim(one.reason ?? "") !== "");

function sameEvidence(left: Finding, right: Finding) {
  return (
    findingKey(left) === findingKey(right) &&
    left.line === right.line &&
    Str.trim(left.detail ?? "") === Str.trim(right.detail ?? "")
  );
}

export function remainingDisputes(disputed: ReadonlyArray<Finding>, review: Disposed) {
  const standing = standingIn(review);
  const resolved = new Set(Arr.map([...review.fixed, ...withdrawnIn(review)], findingKey));
  return Arr.filter(
    disputed,
    (one) =>
      !resolved.has(findingKey(one)) || Arr.some(standing, (echo) => sameEvidence(echo, one)),
  );
}

export function conflictingDispositions(review: Disposed) {
  const withdrawn = withdrawnIn(review);
  const lines = Arr.flatMap(standingIn(review), (one) => {
    const resolutions = [
      ...(Arr.some(withdrawn, (drop) => sameEvidence(drop, one)) ? ["withdrawn"] : []),
      ...(Arr.some(review.fixed, (fix) => findingKey(fix) === findingKey(one)) ? ["fixed"] : []),
    ];
    if (resolutions.length === 0) return [];
    const raised = one.status === "disputed" || review.disputed.includes(one) ? "disputed" : "open";
    const at = one.file ? ` (${one.file})` : "";
    return [
      `conflicting dispositions of [${one.severity}] ${one.title}${at}: ${Arr.join([raised, ...resolutions], " and ")}`,
    ];
  });
  return [...new Set(lines)];
}

export function splitDisputed(findings: ReadonlyArray<Finding>, disputed: ReadonlyArray<Finding>) {
  const split: Split = { live: [], settled: [], rebutted: [] };
  for (const finding of findings) {
    if (finding.status === "fixed" || finding.status === "obsolete") continue;
    if (finding.status === "disputed" && !finding.rebuttal) {
      split.settled.push(finding);
    } else if (!Arr.some(disputed, (one) => sameFinding(one, finding))) {
      split.live.push(finding);
    } else if (finding.rebuttal) {
      split.live.push(finding);
      split.rebutted.push(finding);
    } else {
      split.settled.push(finding);
    }
  }
  return split;
}

export function formatFindings(findings: ReadonlyArray<Finding>) {
  if (findings.length === 0) return "(none)";
  return Arr.join(
    Arr.map(findings, (f) => {
      const at = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
      const detail = f.detail ? `\n  ${pipe(f.detail, Str.replace(/\n/g, "\n  "))}` : "";
      const rebuttal = f.rebuttal
        ? `\n  answers your dispute: ${pipe(f.rebuttal, Str.replace(/\n/g, "\n  "))}`
        : "";
      const identity = f.id ? `${f.id}: ${f.status ?? "open"} — ` : "";
      return `- ${identity}[${f.severity}] ${f.title}${at}${detail}${rebuttal}`;
    }),
    "\n",
  );
}
