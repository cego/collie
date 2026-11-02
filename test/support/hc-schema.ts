// The pinned `hc.openrpc.json`, as the two questions the tests ask of it: every reply a
// method may answer with, and whether one reply is among them.

import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { isString } from "../../src/schema";
import { Exit, JsonSchema, Result, Schema, SchemaRepresentation, flow } from "effect";

/** One node of the schema, in the keywords `hc.openrpc.json` uses. */
interface Node {
  readonly $ref?: string;
  readonly type?: string | ReadonlyArray<string>;
  readonly properties?: Readonly<Record<string, Node>>;
  readonly required?: ReadonlyArray<string>;
  readonly items?: Node;
  readonly additionalProperties?: Node;
  readonly anyOf?: ReadonlyArray<Node>;
  readonly enum?: ReadonlyArray<Schema.Json>;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
}

interface Document {
  readonly info: { readonly version: string };
  readonly components: { readonly schemas: Readonly<Record<string, Node>> };
  readonly methods: ReadonlyArray<{
    readonly name: string;
    readonly result: { readonly schema: Node };
  }>;
}

const root = new URL("../../", import.meta.url).pathname;
// SAFETY: the pinned files committed beside the code; a lookup below throws by name when
// one is not shaped as this says, failing the test.
export const pin = (await Bun.file(`${root}hc-pin.json`).json()) as {
  readonly version: string;
  readonly schema: string;
};
// SAFETY: as above.
const doc = (await Bun.file(`${root}${pin.schema}`).json()) as Document;

export const schemaVersion = doc.info.version;

/** A reply as one line of JSON, the way a finding names it. */
export const jsonText = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Json)),
  Result.getOrThrow,
);

const resultOf = (method: string): Node => {
  const found = Arr.findFirst(doc.methods, (m) => m.name === method);
  if (found._tag === "None") throw new Error(`${pin.schema} has no method ${method}`);
  return found.value.result.schema;
};

export const hasMethod = (method: string) => Arr.some(doc.methods, (m) => m.name === method);

const component = (ref: string): [string, Node] => {
  const name = pipe(ref, Str.replace("#/components/schemas/", ""));
  const found = doc.components.schemas[name];
  if (!found) throw new Error(`${pin.schema} has no component ${name}`);
  return [name, found];
};

const ANY: ReadonlyArray<Schema.Json> = [null, false, 0, "s", [], {}];

/**
 * Replies a node allows: each alternative at each position at least once, and each object
 * both with only its required properties and with all of them.
 */
function samples(node: Node, seen: ReadonlyArray<string> = []): ReadonlyArray<Schema.Json> {
  if (node.$ref !== undefined) {
    const [name, target] = component(node.$ref);
    // WaitResult nests itself: one level of it is sampled.
    return seen.includes(name) ? [] : samples(target, [...seen, name]);
  }
  if (node.anyOf) return Arr.flatMap(node.anyOf, (branch) => samples(branch, seen));
  if (node.enum) return node.enum;
  if (node.type !== undefined && !isString(node.type))
    return Arr.flatMap(node.type, (type) => samples({ ...node, type }, seen));
  switch (node.type) {
    case "null":
      return [null];
    case "boolean":
      return [false, true];
    case "integer":
      return [node.minimum ?? 0, ...(node.maximum === undefined ? [] : [node.maximum])];
    case "number":
      return [0, 1.5];
    case "string":
      return ["s"];
    case "array": {
      const items = node.items ? samples(node.items, seen) : ANY;
      const length = Math.max(node.minItems ?? 0, 1);
      return [
        ...(node.minItems ? [] : [[]]),
        ...Arr.map(items, (item) => Arr.makeBy(length, () => item)),
      ];
    }
    case "object": {
      const properties = Rec.toEntries(node.properties ?? {});
      if (properties.length === 0) {
        const values = node.additionalProperties ? samples(node.additionalProperties, seen) : ANY;
        return [{}, ...Arr.map(values, (value) => ({ key: value }))];
      }
      const required = node.required ?? [];
      const options = Arr.map(
        properties,
        ([name, schema]) => [name, samples(schema, seen)] as const,
      );
      const first = Arr.map(options, ([name, values]): [string, Schema.Json] => [
        name,
        values[0] ?? null,
      ]);
      const full = Rec.fromEntries(first);
      const minimal = Rec.fromEntries(Arr.filter(first, ([name]) => Arr.contains(required, name)));
      const variants = Arr.flatMap(options, ([name, values]) =>
        Arr.map(values.slice(1), (value) => ({ ...full, [name]: value })),
      );
      return [minimal, full, ...variants];
    }
    default:
      return ANY;
  }
}

/** Every reply the pinned schema allows `method` to answer with, as far as sampling goes. */
export const replySamples = (method: string) => samples(resultOf(method));

const definitions = Rec.map(
  doc.components.schemas,
  // SAFETY: a component is a JSON Schema node; the conversion reads it as one.
  (node) => JsonSchema.fromSchemaOpenApi3_1(node as JsonSchema.JsonSchema).schema,
);

const allowed = new Map<string, Schema.Top>();

/** Why the pinned schema forbids `reply` to `method`, or undefined where it allows it. */
export function replyViolation(method: string, reply: Schema.Json): string | undefined {
  let schema = allowed.get(method);
  if (!schema) {
    schema = SchemaRepresentation.fromJsonSchemaDocument({
      dialect: "draft-2020-12",
      // SAFETY: as above.
      schema: JsonSchema.fromSchemaOpenApi3_1(resultOf(method) as JsonSchema.JsonSchema).schema,
      definitions,
    });
    allowed.set(method, schema);
  }
  // SAFETY: a schema imported from JSON Schema decodes plain JSON and needs no services.
  const exit = Schema.decodeExit(schema as Schema.Decoder<unknown>)(reply);
  return Exit.isSuccess(exit) ? undefined : String(exit.cause);
}
