import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { DEFAULT_MODEL, HARNESS_MODELS } from "./harness-choice";

export const CatalogueEntry = Schema.Struct({
  model: Schema.String,
  label: Schema.String,
  description: Schema.NullOr(Schema.String),
  efforts: Schema.Array(Schema.String),
  defaultEffort: Schema.NullOr(Schema.String),
  hidden: Schema.Boolean,
  isDefault: Schema.optionalKey(Schema.Boolean),
  from: Schema.Literals(["harness", "table", "added"]),
});
export type CatalogueEntry = typeof CatalogueEntry.Type;

export const HarnessCatalogue = Schema.Struct({
  harness: Schema.String,
  at: Schema.String,
  table: Schema.NullOr(Schema.String),
  entries: Schema.Array(CatalogueEntry),
});
export type HarnessCatalogue = typeof HarnessCatalogue.Type;

const entry: (
  model: string,
  label: string,
  rest?: Partial<Omit<CatalogueEntry, "model" | "label">>,
) => CatalogueEntry = (model, label, rest = {}) => ({
  model,
  label,
  description: null,
  efforts: [],
  defaultEffort: null,
  hidden: false,
  from: "harness",
  ...rest,
});

export const ClaudeModels = Schema.Array(
  Schema.Struct({
    value: Schema.String,
    displayName: Schema.String,
    description: Schema.String,
    supportsEffort: Schema.optionalKey(Schema.Boolean),
    supportedEffortLevels: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);
export type ClaudeModels = typeof ClaudeModels.Type;

// WARNING: Claude's default entry is replaced by Collie's own default.
export const claudeEntries = (models: ClaudeModels) =>
  Arr.map(
    Arr.filter(models, ({ value }) => value !== DEFAULT_MODEL),
    (model) =>
      entry(model.value, model.displayName, {
        description: model.description === "" ? null : model.description,
        efforts: model.supportsEffort === true ? (model.supportedEffortLevels ?? []) : [],
      }),
  );

export const CodexModelList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      displayName: Schema.String,
      description: Schema.optionalKey(Schema.NullOr(Schema.String)),
      hidden: Schema.Boolean,
      isDefault: Schema.optionalKey(Schema.Boolean),
      supportedReasoningEfforts: Schema.Array(Schema.Struct({ reasoningEffort: Schema.String })),
      defaultReasoningEffort: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});
export type CodexModelList = typeof CodexModelList.Type;

export const codexEntries = ({ data }: CodexModelList) =>
  Arr.map(data, (model) =>
    entry(model.id, model.displayName, {
      description: model.description ?? null,
      efforts: Arr.map(model.supportedReasoningEfforts, ({ reasoningEffort }) => reasoningEffort),
      defaultEffort: model.defaultReasoningEffort ?? null,
      hidden: model.hidden,
      ...(model.isDefault === true && { isDefault: true }),
    }),
  );

// WARNING: pi's thinking column says only yes or no, so effort is not read from it.
export const piEntries = (text: string) => {
  const [header, ...rows] = Arr.map(Str.split(text, "\n"), (line) =>
    Str.split(Str.trim(line), /\s+/),
  );
  const column = (name: string) => header?.indexOf(name) ?? -1;
  const [provider, model, thinking] = [column("provider"), column("model"), column("thinking")];
  if (provider < 0 || model < 0 || thinking < 0) return null;
  return Arr.map(
    Arr.filter(rows, (row) => row.length === header!.length),
    (row) =>
      entry(`${row[provider]}/${row[model]}`, row[model]!, {
        efforts: row[thinking] === "yes" ? (HARNESS_MODELS.pi?.efforts ?? []) : [],
      }),
  );
};

export const opencodeEntries = (text: string) => {
  const lines = Arr.filter(Str.split(text, "\n"), (line) => Str.trim(line) !== "");
  const ids = Arr.filter(lines, (line) => /^[^\s/]+\/\S+$/.test(line));
  if (ids.length === 0 || ids.length < lines.length) return null;
  return Arr.map(ids, (id) =>
    entry(id, pipe(id, Str.slice(Option.getOrElse(pipe(id, Str.indexOf("/")), () => -1) + 1))),
  );
};

export const tableEntries = (harness: string) => {
  const table = HARNESS_MODELS[harness];
  return Arr.map(table?.models ?? [], (model) =>
    entry(model, model, { efforts: table?.efforts ?? [], from: "table" }),
  );
};

export const withAdded = (catalogue: HarnessCatalogue, added: ReadonlyArray<string>) => {
  const listed = new Set(Arr.map(catalogue.entries, (one) => one.model));
  const fresh = Arr.filter(added, (model) => !listed.has(model));
  const efforts = HARNESS_MODELS[catalogue.harness]?.efforts ?? [];
  return {
    ...catalogue,
    entries: [
      ...Arr.map(catalogue.entries, (one) =>
        one.hidden && added.includes(one.model)
          ? { ...one, hidden: false, from: "added" as const }
          : one,
      ),
      ...Arr.map(fresh, (model) => entry(model, model, { efforts, from: "added" })),
    ],
  };
};

const PAD = 10;

export function modelsLines(catalogues: ReadonlyArray<HarnessCatalogue>, only?: string) {
  const kept = Arr.filter(catalogues, (one) => only === undefined || one.harness === only);
  if (kept.length === 0) return `${only ?? "No harness"} is not installed on this Machine.`;
  return Arr.join(
    Arr.flatMap(kept, ({ harness, table, entries }) => [
      ...(table === null ? [] : [`${pipe(harness, Str.padEnd(PAD))}from Collie's table: ${table}`]),
      ...Arr.map(entries, (entry) => {
        const marks = Arr.filter(
          [
            entry.efforts.length === 0 ? null : `efforts ${Arr.join(entry.efforts, ", ")}`,
            entry.defaultEffort === null ? null : `default ${entry.defaultEffort}`,
            entry.hidden ? "hidden" : null,
            entry.from === "added" ? `added in models.${harness}` : null,
          ],
          (mark) => mark !== null,
        );
        const named = entry.label === entry.model ? entry.model : `${entry.model} (${entry.label})`;
        return `${pipe(harness, Str.padEnd(PAD))}${Arr.join([named, ...marks], " · ")}`;
      }),
    ]),
    "\n",
  );
}
