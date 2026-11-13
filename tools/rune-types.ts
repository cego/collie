// The Rust types the Rune spike decodes `DesktopRpcs` with, generated from the JSON Schema
// documents of every RPC in `DesktopRpcs`, so no Schema is copied by hand (desktop-rune/README.md):
//
//   bun run tools/rune-types.ts --write   # regenerate desktop-rune/protocol/src/generated.rs
//   bun run tools/rune-types.ts --check   # fail where the checked-in file differs

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Data, Effect, FileSystem, pipe, Schema } from "effect";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcSchema from "effect/rpc/RpcSchema";
import { DesktopRpcs } from "../desktop/src/shared/flock";

export const GENERATED = new URL("../desktop-rune/protocol/src/generated.rs", import.meta.url)
  .pathname;
export const REGENERATE = "bun run tools/rune-types.ts --write";

/** Each part of an RPC the spike speaks that is not void, and its Rust name. */
const SPOKEN = [
  ["flock", "success", "FlockItem"],
  ["syncNow", "payload", "SyncNowPayload"],
  ["syncNow", "success", "SyncNowSuccess"],
  ["syncNow", "error", "ActionFailed"],
  ["terminal", "payload", "TerminalPayload"],
  ["terminal", "success", "TerminalEvent"],
  ["terminal", "error", "ActionFailed"],
  ["terminalSend", "payload", "TerminalSendPayload"],
  ["terminalSend", "error", "ActionFailed"],
  ["say", "payload", "SayPayload"],
  ["say", "success", "AguiEvent"],
  ["runDetail", "payload", "RunDetailPayload"],
  ["runDetail", "success", "KeptRecord"],
  ["runDetail", "error", "ActionFailed"],
  ["runFile", "payload", "RunFilePayload"],
  ["runFile", "success", "RunFile"],
  ["runFile", "error", "ActionFailed"],
  ["artefactSeen", "success", "Artefact"],
  ["artefacts", "payload", "ArtefactsPayload"],
  ["artefacts", "success", "ArtefactCollection"],
  ["artefacts", "error", "ActionFailed"],
  ["artefactRead", "payload", "ArtefactReadPayload"],
  ["artefactRead", "success", "RunFile"],
  ["artefactRead", "error", "ActionFailed"],
  ["artefactSeen", "payload", "ArtefactSeenPayload"],
  ["artefactSeen", "error", "ActionFailed"],
  ["stagePaths", "payload", "StagePathsPayload"],
  ["stagePaths", "success", "StagedOrRefused"],
  ["recordMark", "payload", "RecordMarkPayload"],
] as const;

/** The JSON Schema keywords `Schema.toJsonSchemaDocument` writes for these RPCs. */
interface Json {
  readonly type?: string;
  readonly enum?: ReadonlyArray<string>;
  readonly properties?: Readonly<Record<string, Json>>;
  readonly required?: ReadonlyArray<string>;
  readonly additionalProperties?: boolean | Json;
  readonly items?: Json;
  readonly anyOf?: ReadonlyArray<Json>;
  readonly $ref?: string;
  readonly not?: Json;
}
const Json: Schema.Codec<Json> = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  enum: Schema.optionalKey(Schema.Array(Schema.String)),
  properties: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.suspend(() => Json),
    ),
  ),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
  additionalProperties: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.suspend(() => Json)]),
  ),
  items: Schema.optionalKey(Schema.suspend(() => Json)),
  anyOf: Schema.optionalKey(Schema.Array(Schema.suspend(() => Json))),
  $ref: Schema.optionalKey(Schema.String),
  not: Schema.optionalKey(Schema.suspend(() => Json)),
});
const Document = Schema.Struct({ schema: Json, definitions: Schema.Record(Schema.String, Json) });
type Document = typeof Document.Type;

/** Rust's keywords, which a field takes raw (`r#type`). */
const KEYWORDS = new Set([
  ...["as", "async", "await", "break", "const", "continue", "dyn", "else", "enum", "extern"],
  ...["false", "fn", "for", "gen", "if", "impl", "in", "let", "loop", "match", "mod", "move"],
  ...["mut", "pub", "ref", "return", "static", "struct", "trait", "true", "type", "unsafe"],
  ...["use", "where", "while", "abstract", "become", "box", "do", "final", "macro", "override"],
  ...["priv", "try", "typeof", "unsized", "virtual", "yield", "self"],
]);
/** Names the prelude has, which a generated type must not shadow. */
const PRELUDE = new Set(["Option", "Result", "String", "Vec", "Box", "Some", "None", "Ok", "Err"]);

/** `RUN_STARTED` and `runStarted` are both `RunStarted`. */
const pascal = (words: string) =>
  Arr.join(
    Arr.map(
      Arr.filter(
        Str.split(pipe(words, Str.replace(/([a-z0-9])([A-Z])/g, "$1 $2")), /[^A-Za-z0-9]+/),
        Str.isNonEmpty,
      ),
      (word) => Str.capitalize(/^[A-Z0-9]+$/.test(word) ? Str.toLowerCase(word) : word),
    ),
    "",
  );
const snake = (key: string) => {
  const name = Str.camelToSnake(pipe(key, Str.replace(/^_+/, "")));
  return KEYWORDS.has(name) ? `r#${name}` : name;
};
const singular = (name: string) =>
  /[^s]s$/.test(name) ? pipe(name, Str.slice(0, -1)) : `${name}Item`;

/** A string enum of one value: what an untagged union's members are told apart by. */
const literalOf = (schema: Json) =>
  schema.type === "string" && schema.enum?.length === 1
    ? Option.some(schema.enum[0]!)
    : Option.none();

/** The value a union member is known by: its `_tag`, else its first one-value field. */
const discriminant = (member: Json) => {
  const fields = Rec.toEntries(member.properties ?? {});
  return Arr.findFirst(
    [
      ...Arr.filter(fields, ([key]) => key === "_tag"),
      ...Arr.filter(fields, ([key]) => key !== "_tag"),
    ],
    ([, field]) => literalOf(field),
  );
};

/** A union member with no one-value field, named for the fields it requires. */
const UNNAMED = new Map([
  ["machine message", "MachineMessage"],
  ["_tag", "UnknownMessage"],
]);

const DERIVES = "#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]";

const generator = () => {
  /** Every type in the order first met, by name, with the schema it was made from. */
  const named = new Map<string, { readonly source: string; code: string }>();
  const bySource = new Map<string, string>();
  let definitions: Document["definitions"] = {};

  /** One type per schema: `wanted`, or prefixed by where it is used where that is taken. */
  const declare = (
    source: string,
    wanted: string,
    within: string,
    code: (name: string) => string,
  ) => {
    const had = bySource.get(source);
    if (had !== undefined) return had;
    const free = (name: string) => !named.has(name) && !PRELUDE.has(name);
    const chosen = Option.getOrElse(Arr.findFirst([wanted, `${within}${wanted}`], free), () => {
      for (let n = 2; ; n++) if (free(`${within}${wanted}${n}`)) return `${within}${wanted}${n}`;
    });
    bySource.set(source, chosen);
    named.set(chosen, { source, code: "" });
    named.get(chosen)!.code = code(chosen);
    return chosen;
  };

  const literals = (schema: Json, wanted: string, within: string) =>
    declare(JSON.stringify(schema), wanted, within, (name) => {
      const variants = Arr.map(
        schema.enum ?? [],
        (value) => `    #[serde(rename = ${JSON.stringify(value)})]\n    ${pascal(value)},\n`,
      );
      return `${DERIVES}\npub enum ${name} {\n${Arr.join(variants, "")}}\n`;
    });

  const struct = (schema: Json, wanted: string, within: string) =>
    declare(JSON.stringify(schema), wanted, within, (name) => {
      const required = new Set(schema.required ?? []);
      const fields = Arr.map(Rec.toEntries(schema.properties ?? {}), ([key, field]) => {
        const inner = typeOf(field, key === "_tag" ? `${name}Tag` : pascal(key), name);
        const rust = snake(key);
        const attrs = Arr.filter(
          [
            pipe(rust, Str.replace(/^r#/, "")) === key ? "" : `rename = ${JSON.stringify(key)}`,
            ...(required.has(key)
              ? []
              : [
                  "default",
                  'skip_serializing_if = "Option::is_none"',
                  isNullable(field) ? 'with = "crate::double_option"' : "",
                ]),
          ],
          Str.isNonEmpty,
        );
        const serde = attrs.length === 0 ? "" : `    #[serde(${Arr.join(attrs, ", ")})]\n`;
        return `${serde}    pub ${rust}: ${required.has(key) ? inner : `Option<${inner}>`},\n`;
      });
      return `${DERIVES}\npub struct ${name} {\n${Arr.join(fields, "")}}\n`;
    });

  const union = (members: ReadonlyArray<Json>, wanted: string, within: string) =>
    declare(JSON.stringify(members), wanted, within, (name) => {
      const variants = Arr.map(members, (member, i) => {
        const variant = Option.getOrElse(
          Option.map(discriminant(member), pascal),
          () => UNNAMED.get(Arr.join(member.required ?? [], " ")) ?? `${name}${i}`,
        );
        return `    ${variant}(${typeOf(member, variant, name)}),\n`;
      });
      return `${DERIVES}\n#[serde(untagged)]\npub enum ${name} {\n${Arr.join(variants, "")}}\n`;
    });

  const isNullable = (schema: Json) => Arr.some(schema.anyOf ?? [], ({ type }) => type === "null");

  const typeOf = (schema: Json, wanted: string, within: string): string => {
    if (schema.$ref !== undefined) {
      const definition = pipe(schema.$ref, Str.replace("#/$defs/", ""));
      return typeOf(
        definitions[definition]!,
        pipe(definition, Str.replace(/Encoded$/, "")),
        within,
      );
    }
    if (schema.anyOf !== undefined) {
      const present = Arr.filter(schema.anyOf, ({ type }) => type !== "null");
      const inner =
        present.length === 1 ? typeOf(present[0]!, wanted, within) : union(present, wanted, within);
      return isNullable(schema) ? `Option<${inner}>` : inner;
    }
    switch (schema.type) {
      case "string":
        return schema.enum === undefined ? "String" : literals(schema, wanted, within);
      case "number":
        return "f64";
      case "integer":
        return "i64";
      case "boolean":
        return "bool";
      case "array":
        return `Vec<${typeOf(schema.items ?? {}, singular(wanted), within)}>`;
      case "object":
        return schema.properties === undefined && Predicate.isObject(schema.additionalProperties)
          ? `std::collections::BTreeMap<String, ${typeOf(schema.additionalProperties, singular(wanted), within)}>`
          : struct(schema, wanted, within);
      default:
        return "serde_json::Value";
    }
  };

  /** The Rust type of one RPC part, or none where it is void or never. */
  const part = (document: Document, wanted: string) => {
    definitions = document.definitions;
    const { schema } = document;
    if (schema.type === "null" || schema.not !== undefined) return;
    typeOf(schema, wanted, "");
  };

  return { part, named };
};

const schemaOf = (rpc: Rpc.AnyWithProps, part: (typeof SPOKEN)[number][1]) => {
  if (part === "payload") return rpc.payloadSchema;
  if (part === "error") return rpc.errorSchema;
  return RpcSchema.isStreamSchema(rpc.successSchema)
    ? rpc.successSchema.success
    : rpc.successSchema;
};

/** `generated.rs` as the generator writes it from today's Schemas. */
/** Every RPC's parts: the spike's own names first, so they stay; the rest named by their RPC. */
const ALL: ReadonlyArray<readonly [string, (typeof SPOKEN)[number][1], string]> = [
  ...SPOKEN,
  ...Arr.flatMap([...DesktopRpcs.requests.keys()], (tag) =>
    Arr.map(
      ["payload", "success", "error"] as const,
      (which) => [tag, which, `${pascal(tag)}${pascal(which)}`] as const,
    ),
  ),
];

export const rustTypes = Effect.gen(function* () {
  const { part, named } = generator();
  for (const [tag, which, name] of ALL) {
    // SAFETY: every RPC of a group carries its payload, success and error schemas.
    const rpc = DesktopRpcs.requests.get(tag) as Rpc.AnyWithProps;
    const document = yield* Schema.decodeEffect(Document)(
      Schema.toJsonSchemaDocument(schemaOf(rpc, which)),
    );
    part(document, name);
  }
  return Arr.join(
    [
      "// @generated by `bun run tools/rune-types.ts --write` from the Schemas of every RPC in",
      "// `DesktopRpcs`. Do not edit by hand.",
      "",
      "use serde::{Deserialize, Serialize};",
      "",
      Arr.join(
        Arr.map([...named.values()], ({ code }) => code),
        "\n",
      ),
    ],
    "\n",
  );
});

class Stale extends Data.TaggedError("Stale")<{ readonly path: string }> {
  override get message() {
    return `${this.path} differs from today's Schemas; run \`${REGENERATE}\``;
  }
}

if (import.meta.main)
  BunRuntime.runMain(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fresh = yield* rustTypes;
      if (Bun.argv[2] === "--write") return yield* fs.writeFileString(GENERATED, fresh);
      if ((yield* fs.readFileString(GENERATED)) !== fresh)
        return yield* new Stale({ path: GENERATED });
    }).pipe(Effect.provide(BunServices.layer)),
  );
