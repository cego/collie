import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { isString } from "../../src/schema";
import { Exit, JsonSchema, Result, Schema, SchemaRepresentation, flow } from "effect";

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
// WARNING: the pinned files committed beside the code; a lookup below throws by name when one is not shaped as this says, failing the test.
export const pin = (await Bun.file(`${root}hc-pin.json`).json()) as {
  readonly version: string;
  readonly schema: string;
};
// WARNING: as above.
const doc = (await Bun.file(`${root}${pin.schema}`).json()) as Document;

export const schemaVersion = doc.info.version;

export const jsonText = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Json)),
  Result.getOrThrow,
);

const resultOf = (method: string) => {
  const found = Arr.findFirst(doc.methods, (m) => m.name === method);
  if (found._tag === "None") throw new Error(`${pin.schema} has no method ${method}`);
  return found.value.result.schema;
};

export const hasMethod = (method: string) => Arr.some(doc.methods, (m) => m.name === method);

const component: (ref: string) => [string, Node] = (ref) => {
  const name = pipe(ref, Str.replace("#/components/schemas/", ""));
  const found = doc.components.schemas[name];
  if (!found) throw new Error(`${pin.schema} has no component ${name}`);
  return [name, found];
};

const ANY: ReadonlyArray<Schema.Json> = [null, false, 0, "s", [], {}];

function samples(node: Node, seen: ReadonlyArray<string> = []) {
  if (node.$ref !== undefined) {
    const [name, target] = component(node.$ref);
    // WARNING: WaitResult nests itself, so only one level of it is sampled.
    const answer: ReadonlyArray<Schema.Json> = seen.includes(name)
      ? []
      : samples(target, [...seen, name]);
    return answer;
  }
  if (node.anyOf) {
    const answer: ReadonlyArray<Schema.Json> = Arr.flatMap(node.anyOf, (branch) =>
      samples(branch, seen),
    );
    return answer;
  }
  if (node.enum) {
    const answer: ReadonlyArray<Schema.Json> = node.enum;
    return answer;
  }
  if (node.type !== undefined && !isString(node.type)) {
    const answer: ReadonlyArray<Schema.Json> = Arr.flatMap(node.type, (type) =>
      samples({ ...node, type }, seen),
    );
    return answer;
  }
  switch (node.type) {
    case "null": {
      const answer: ReadonlyArray<Schema.Json> = [null];
      return answer;
    }
    case "boolean": {
      const answer: ReadonlyArray<Schema.Json> = [false, true];
      return answer;
    }
    case "integer": {
      const answer: ReadonlyArray<Schema.Json> = [
        node.minimum ?? 0,
        ...(node.maximum === undefined ? [] : [node.maximum]),
      ];
      return answer;
    }
    case "number": {
      const answer: ReadonlyArray<Schema.Json> = [0, 1.5];
      return answer;
    }
    case "string": {
      const answer: ReadonlyArray<Schema.Json> = ["s"];
      return answer;
    }
    case "array": {
      const items = node.items ? samples(node.items, seen) : ANY;
      const length = Math.max(node.minItems ?? 0, 1);
      const answer: ReadonlyArray<Schema.Json> = [
        ...(node.minItems ? [] : [[]]),
        ...Arr.map(items, (item) => Arr.makeBy(length, () => item)),
      ];
      return answer;
    }
    case "object": {
      const properties = Rec.toEntries(node.properties ?? {});
      if (properties.length === 0) {
        const values = node.additionalProperties ? samples(node.additionalProperties, seen) : ANY;
        const answer: ReadonlyArray<Schema.Json> = [
          {},
          ...Arr.map(values, (value) => ({ key: value })),
        ];
        return answer;
      }
      const required = node.required ?? [];
      const options = Arr.map(
        properties,
        ([name, schema]) => [name, samples(schema, seen)] as const,
      );
      const first = Arr.map(options, ([name, values]) => {
        const returned: [string, Schema.Json] = [name, values[0] ?? null];
        return returned;
      });
      const full = Rec.fromEntries(first);
      const minimal = Rec.fromEntries(Arr.filter(first, ([name]) => Arr.contains(required, name)));
      const variants = Arr.flatMap(options, ([name, values]) =>
        Arr.map(values.slice(1), (value) => ({ ...full, [name]: value })),
      );
      const answer: ReadonlyArray<Schema.Json> = [minimal, full, ...variants];
      return answer;
    }
    default: {
      const answer: ReadonlyArray<Schema.Json> = ANY;
      return answer;
    }
  }
}

export const replySamples = (method: string) => samples(resultOf(method));

const definitions = Rec.map(
  doc.components.schemas,
  // WARNING: a component is a JSON Schema node; the conversion reads it as one.
  (node) => JsonSchema.fromSchemaOpenApi3_1(node as JsonSchema.JsonSchema).schema,
);

const allowed = new Map<string, Schema.Top>();

export function replyViolation(method: string, reply: Schema.Json) {
  let schema = allowed.get(method);
  if (!schema) {
    schema = SchemaRepresentation.fromJsonSchemaDocument({
      dialect: "draft-2020-12",
      // WARNING: as above.
      // WARNING: A method's result is a JSON Schema node, as at the other conversion.
      schema: JsonSchema.fromSchemaOpenApi3_1(resultOf(method) as JsonSchema.JsonSchema).schema,
      definitions,
    });
    allowed.set(method, schema);
  }
  // WARNING: a schema imported from JSON Schema decodes plain JSON and needs no services.
  const exit = Schema.decodeExit(schema as Schema.Decoder<unknown>)(reply);
  return Exit.isSuccess(exit) ? undefined : String(exit.cause);
}
