import { Option, Schema, Result, flow, type Types } from "effect";
import * as Arr from "effect/Array";
import * as Str from "effect/String";

export const ReportAddress = Schema.Struct({
  installation: Schema.String,
  run: Schema.String,
  id: Schema.String,
  revision: Schema.Int,
  step: Schema.String,
  digest: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.Int),
});
export type ReportAddress = typeof ReportAddress.Type;

export const NarrativeReport = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  blocker: Schema.NullOr(Schema.String),
  nextAction: Schema.NullOr(Schema.String),
  state: Schema.Literals(["preparing", "ready", "failed", "unavailable"]),
  reason: Schema.NullOr(Schema.String),
  address: Schema.optionalKey(ReportAddress),
  origin: Schema.optionalKey(
    Schema.Struct({ installation: Schema.String, run: Schema.String, step: Schema.String }),
  ),
  at: Schema.NullOr(Schema.String),
  observedAt: Schema.String,
});
export type NarrativeReport = typeof NarrativeReport.Type;

export const concise = (text: string): string => {
  const words = Str.trim(Str.replace(/\s+/gu, " ")(text));
  const sentences = Str.trim(
    Arr.join(
      Option.getOrElse(Str.match(/[^.!?。！？]+(?:[.!?。！？]+(?:\s|$)|$)/gu)(words), () => [
        words,
      ]).slice(0, 2),
      "",
    ),
  );
  const chars = Array.from(sentences);
  return chars.length <= 360 ? sentences : `${Arr.join(chars.slice(0, 359), "")}…`;
};

export const ProducerReport = Schema.Struct({
  summary: Schema.optionalKey(Schema.String),
  blocker: Schema.optionalKey(Schema.String),
  next_action: Schema.optionalKey(Schema.String),
  report: Schema.optionalKey(ReportAddress),
});
type ReportFields = Types.Mutable<typeof ProducerReport.Type>;
export const reportFields = (source: ReportFields) => {
  const fields: ReportFields = {};
  if (source.summary !== undefined) fields.summary = concise(source.summary);
  if (source.blocker !== undefined) fields.blocker = concise(source.blocker);
  if (source.next_action !== undefined) fields.next_action = concise(source.next_action);
  if (source.report !== undefined) fields.report = source.report;
  return fields;
};

const NarrativeOutput = Schema.Struct({
  ...ProducerReport.fields,
  diagnosis: Schema.optionalKey(Schema.String),
  actions: Schema.optionalKey(Schema.Array(Schema.String)),
  needs_person: Schema.optionalKey(Schema.String),
  finding: Schema.optionalKey(Schema.Json),
  findings: Schema.optionalKey(Schema.Array(Schema.Json)),
});

const asJson = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Json)), Result.getOrThrow);

export const narrativeOf = <A>(value: A) => {
  const decoded = Schema.decodeUnknownOption(NarrativeOutput)(value);
  if (Option.isNone(decoded)) return {};
  const said = decoded.value;
  const narrative = Arr.join(
    [
      said.diagnosis ?? said.summary ?? "",
      ...Arr.map(said.actions ?? [], (action) => `## Attempt\n\n${action}`),
      ...Arr.map(
        said.findings ?? [],
        (finding) => `## Finding\n\n\`\`\`json\n${asJson(finding)}\n\`\`\``,
      ),
      ...(said.needs_person === undefined ? [] : [`## Human next action\n\n${said.needs_person}`]),
      ...(said.blocker === undefined ? [] : [`## Current blocker\n\n${said.blocker}`]),
      ...(said.next_action === undefined ? [] : [`## Next action\n\n${said.next_action}`]),
      ...(said.finding === undefined
        ? []
        : [`## Structured finding\n\n\`\`\`json\n${asJson(said.finding)}\n\`\`\``]),
    ],
    "\n\n",
  );
  if (Str.trim(narrative) === "") return {};
  return {
    narrative,
    ...reportFields({
      summary: said.summary,
      blocker: said.blocker ?? said.needs_person,
      next_action: said.next_action ?? said.needs_person,
      report: said.report,
    }),
  };
};
