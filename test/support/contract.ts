// A walker over herdr's published JSON Schema (`herdr api schema --json`), used by
// `test/herdr-contract.test.ts` to check Collie's hand-written boundary structs
// against it. Deliberately not a general JSON Schema implementation: it covers the
// keywords herdr's own document uses and nothing else, so it stays a few
// dependency-free lines instead of a validator to maintain.

import { Effect, Option, Schema } from "effect";
import type * as SchemaAST from "effect/SchemaAST";

/** One node of herdr's schema document, in the keywords herdr actually emits. */
interface Node {
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, Node>>;
  readonly type?: string | ReadonlyArray<string>;
  readonly const?: Schema.Json;
  readonly enum?: ReadonlyArray<Schema.Json>;
  readonly properties?: Readonly<Record<string, Node>>;
  readonly required?: ReadonlyArray<string>;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly additionalProperties?: boolean | Node;
  readonly items?: Node;
  readonly oneOf?: ReadonlyArray<Node>;
  readonly anyOf?: ReadonlyArray<Node>;
}

interface Document {
  readonly protocol: number;
  readonly schemas: Readonly<Record<string, Node>>;
}

/** Where in herdr's schema one of Collie's reply structs is described. */
export type ReplyLocation =
  | { readonly envelope: string }
  | { readonly schema: string }
  | { readonly def: string; readonly in: string };

/**
 * herdr's contract, as the two questions Collie needs to ask of it. Locating a variant,
 * following `$ref`s and comparing JSON Schema types are all implementation: a caller
 * names a struct and where herdr describes it, and gets back the disagreements in
 * words. Nothing about JSON Schema crosses this seam.
 */
export interface Contract {
  /** herdr's socket protocol version, as the schema declares it. */
  readonly protocol: number;
  /**
   * Every disagreement between a reply struct and herdr's schema, in the one direction
   * that matters: Collie must accept everything herdr may send. A field herdr sends and
   * Collie does not read is not a disagreement, and neither is a field Collie tolerates
   * the absence of. Empty means they agree.
   */
  replyFindings(path: string, schema: Schema.Top, at: ReplyLocation): ReadonlyArray<string>;
  /**
   * Every way herdr's request schema would reject the params Collie sends for one
   * method: a missing required key, a key herdr forbids, a primitive of the wrong type.
   */
  requestFindings(method: string, params: Schema.Json): ReadonlyArray<string>;
}

/** herdr writes every reference as `#/schemas/<schema>/$defs/<name>`. */
const REF = /^#\/schemas\/([^/]+)\/\$defs\/([^/]+)$/;

export function loadContract(path: string): Effect.Effect<Contract> {
  return Effect.map(readDocument(path), contractOf);
}

// SAFETY: herdr's own schema document, and every lookup in `contractOf` throws by
// name when the shape is not what herdr says — failing the test, as a decode error of
// the same document would.
const readDocument = (path: string): Effect.Effect<Document> =>
  Effect.promise(() => Bun.file(path).json() as Promise<Document>);

function contractOf(doc: Document): Contract {
  const schema = (name: string): Node => {
    const found = doc.schemas[name];
    if (!found) throw new Error(`herdr schema has no schemas/${name}`);
    return found;
  };

  const def = (name: string, defName: string): Node => {
    const found = schema(name).$defs?.[defName];
    if (!found) throw new Error(`herdr schema has no schemas/${name}/$defs/${defName}`);
    return found;
  };

  const resolve = (node: Node): Node => {
    let current = node;
    while (current.$ref !== undefined) {
      const parts = REF.exec(current.$ref);
      if (!parts) throw new Error(`unsupported $ref ${current.$ref}`);
      current = def(parts[1]!, parts[2]!);
    }
    return current;
  };

  const variant = (node: Node, key: string, value: string): Node => {
    const found = (node.oneOf ?? node.anyOf ?? []).find(
      (member) => member.properties?.[key]?.const === value,
    );
    if (!found) throw new Error(`herdr schema has no variant with ${key} "${value}"`);
    return found;
  };

  const member = (node: Node, key: string): Node => {
    const found = node.properties?.[key];
    if (!found) throw new Error(`herdr schema node has no property ${key}`);
    return found;
  };

  /** The reply envelope Collie decodes for the variant herdr tags with `type`. */
  const envelope = (type: string): Node => ({
    type: "object",
    properties: {
      result: variant(resolve(member(schema("success_response"), "result")), "type", type),
    },
    required: ["result"],
  });

  const locate = (at: ReplyLocation): Node => {
    if ("envelope" in at) return envelope(at.envelope);
    if ("schema" in at) return schema(at.schema);
    return def(at.in, at.def);
  };

  return {
    protocol: doc.protocol,
    replyFindings: (path, schema, at) => walkReply(resolve, path, schema.ast, locate(at)),
    requestFindings: (method, params) =>
      walkRequest(
        resolve,
        method,
        params,
        resolve(member(variant(schema("request"), "method", method), "params")),
      ),
  };
}

/** Follows a `$ref` until the node carries keywords of its own. */
type Resolve = (node: Node) => Node;

/**
 * A union accepts every type its members accept — and anything at all if any member
 * does, which is what `undefined` means throughout.
 */
function unionTypes<T>(
  members: ReadonlyArray<T>,
  typesOf: (member: T) => ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
  const all = new Set<string>();
  for (const member of members) {
    const types = typesOf(member);
    if (!types) return undefined;
    for (const type of types) all.add(type);
  }
  return all;
}

/** The JSON types a herdr node may hold, or `undefined` when it constrains none. */
function herdrTypes(resolve: Resolve, node: Node): ReadonlySet<string> | undefined {
  const resolved = resolve(node);
  const branches = resolved.oneOf ?? resolved.anyOf;
  if (branches) return unionTypes(branches, (branch) => herdrTypes(resolve, branch));
  if (resolved.type !== undefined) {
    return new Set(Array.isArray(resolved.type) ? resolved.type : [resolved.type]);
  }
  if (resolved.enum) return new Set(resolved.enum.map(jsonType));
  if (resolved.const !== undefined) return new Set([jsonType(resolved.const)]);
  return undefined;
}

/**
 * herdr's `integer` and JSON's `number` stand for each other wherever a type name is
 * compared; whether a particular number is a whole one is `numberProblem`'s question.
 * No other two type names are interchangeable.
 */
const NUMERIC = new Set(["number", "integer"]);

function interchangeable(one: string, other: string): boolean {
  return one === other || (NUMERIC.has(one) && NUMERIC.has(other));
}

/** Whether any of these type names stands for `actual`. */
function admits(names: ReadonlySet<string>, actual: string): boolean {
  return [...names].some((name) => interchangeable(name, actual));
}

/** The JSON types a Collie schema accepts, or `undefined` when it accepts anything. */
function collieTypes(ast: SchemaAST.AST): ReadonlySet<string> | undefined {
  switch (ast._tag) {
    case "String":
      return new Set(["string"]);
    case "Number":
      return new Set(["number"]);
    case "Boolean":
      return new Set(["boolean"]);
    case "Null":
      return new Set(["null"]);
    case "Objects":
      return new Set(["object"]);
    case "Arrays":
      return new Set(["array"]);
    case "Literal":
      return new Set([jsonType(jsonLiteral(ast.literal))]);
    case "Union":
      return unionTypes(ast.types, collieTypes);
    default:
      // `Schema.Json`, `Schema.Unknown` and friends: nothing to disagree about.
      return undefined;
  }
}

/**
 * Every member of a Collie schema with this tag: the schema itself when it is one, or a
 * union's members — one of which is what `NullOr(Struct)` and `NullOr(Array)` are.
 *
 * All of them for the same reason as `branchesWith`: a union with two structs in it has
 * no single shape to compare, and that has to be reported rather than passed over. It
 * is our own code on this side, but a struct nobody can write today is exactly the kind
 * of assumption this check exists to stop relying on.
 */
function taggedMembers<Tag extends SchemaAST.AST["_tag"]>(
  ast: SchemaAST.AST,
  tag: Tag,
): ReadonlyArray<Tagged<Tag>> {
  if (tagged(ast, tag)) return [ast];
  if (ast._tag !== "Union") return [];
  return ast.types.filter((type) => tagged(type, tag));
}

type Tagged<Tag extends SchemaAST.AST["_tag"]> = Extract<SchemaAST.AST, { readonly _tag: Tag }>;

const tagged = <Tag extends SchemaAST.AST["_tag"]>(
  ast: SchemaAST.AST,
  tag: Tag,
): ast is Tagged<Tag> => ast._tag === tag;

/**
 * Every branch of a herdr node that carries `keyword`. herdr writes a nullable struct as
 * `anyOf: [<the struct>, { type: "null" }]`, so the object to descend into is a branch
 * rather than the node itself — reading `properties` straight off that wrapper found
 * nothing and silently skipped every field under it.
 *
 * All of them, not the single one, because the three counts mean different things and
 * the caller has to tell them apart: one is the shape to descend into, none means herdr
 * does not describe this as such a shape at all, and more than one is a shape this
 * check cannot compare — which has to be said out loud rather than passed over.
 */
function branchesWith(
  resolve: Resolve,
  node: Node,
  keyword: "properties" | "items",
): ReadonlyArray<Node> {
  const resolved = resolve(node);
  if (resolved[keyword] !== undefined) return [resolved];
  const branches = (resolved.oneOf ?? resolved.anyOf ?? []).map(resolve);
  return branches.filter((branch) => branch[keyword] !== undefined);
}

/**
 * One field, compared on both sides. Either side offering several alternatives
 * leaves no pair to compare, and saying so is the only honest answer: passing over it
 * is how a field goes unchecked, which is the failure the whole test exists to prevent.
 * Only worth saying when the other side describes that shape at all — when it does not,
 * the type comparison has already reported the real disagreement.
 *
 * Objects and arrays share this because keeping two copies of it in step by hand did
 * not work: one round taught herdr's side to report and left Collie's silent.
 */
function comparedField<Mine>(
  path: string,
  noun: string,
  mine: ReadonlyArray<Mine>,
  theirs: ReadonlyArray<Node>,
  descend: (mine: Mine, theirs: Node) => ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (theirs.length > 0 && mine.length > 1)
    return [ambiguous(path, mine.length, noun, "Collie's struct")];
  if (mine.length === 1 && theirs.length > 1)
    return [ambiguous(path, theirs.length, noun, "herdr's schema")];
  const [only] = mine;
  const [declared] = theirs;
  return only && declared ? descend(only, declared) : [];
}

function ambiguous(path: string, count: number, noun: string, whose: string): string {
  return `${path} is ${count} alternative ${noun}s in ${whose}, which this check cannot compare`;
}

/** Each field of a Collie struct against the herdr object that declares them. */
function fieldFindings(
  resolve: Resolve,
  path: string,
  object: Tagged<"Objects">,
  declaredIn: Node,
): ReadonlyArray<string> {
  const findings: string[] = [];
  const required = new Set(declaredIn.required ?? []);
  for (const property of object.propertySignatures) {
    const name = String(property.name);
    const at = `${path}.${name}`;
    const optional = property.type.context?.isOptional === true;
    const declared = declaredIn.properties?.[name];
    if (!declared) {
      // A field herdr does not declare at all: an older or a coming name Collie reads
      // defensively. Only a hard requirement on one is a disagreement.
      if (!optional) findings.push(`${at} is required, but herdr does not declare it`);
      continue;
    }
    if (!optional && !required.has(name)) {
      findings.push(`${at} is required, but herdr does not guarantee it`);
    }
    findings.push(...walkReply(resolve, at, property.type, declared));
  }
  return findings;
}

/**
 * Every element schema of a Collie array against the one thing herdr says its elements
 * are. `Schema.Array` keeps that schema in `rest`, `Schema.Tuple` keeps one per position
 * in `elements`, and a tuple with a rest keeps both — all of them have to decode what
 * herdr sends, because herdr describes array elements only with `items`, which applies
 * to every position. Reading `rest` alone left a tuple's elements unchecked while the
 * field still counted as compared.
 */
function elementFindings(
  resolve: Resolve,
  path: string,
  array: Tagged<"Arrays">,
  listing: Node,
): ReadonlyArray<string> {
  const items = listing.items;
  if (!items) return [];
  return [
    ...array.elements.flatMap((element, index) =>
      walkReply(resolve, `${path}[${index}]`, element, items),
    ),
    ...array.rest.flatMap((element) => walkReply(resolve, `${path}[]`, element, items)),
  ];
}

/**
 * Whatever herdr may send here that Collie's decoder would refuse. Either side placing
 * no constraint means there is nothing to disagree about.
 */
function typeFindings(
  path: string,
  sends: ReadonlySet<string> | undefined,
  decodes: ReadonlySet<string> | undefined,
): ReadonlyArray<string> {
  if (!sends || !decodes) return [];
  const unhandled = [...sends].filter((type) => !admits(decodes, type));
  if (unhandled.length === 0) return [];
  return [`${path} is ${[...decodes].join("|")}, but herdr sends ${unhandled.join("|")}`];
}

function walkReply(
  resolve: Resolve,
  path: string,
  ast: SchemaAST.AST,
  node: Node,
): ReadonlyArray<string> {
  const resolved = resolve(node);
  return [
    ...typeFindings(path, herdrTypes(resolve, resolved), collieTypes(ast)),
    ...comparedField(
      path,
      "object",
      taggedMembers(ast, "Objects"),
      branchesWith(resolve, resolved, "properties"),
      (object, declaredIn) => fieldFindings(resolve, path, object, declaredIn),
    ),
    ...comparedField(
      path,
      "array",
      taggedMembers(ast, "Arrays"),
      branchesWith(resolve, resolved, "items"),
      (array, listing) => elementFindings(resolve, path, array, listing),
    ),
  ];
}

/**
 * What herdr's numeric constraints say about one number. `integer` plus `minimum` and
 * `maximum`, which are the numeric keywords herdr's document actually carries —
 * `exclusiveMinimum`, `exclusiveMaximum` and `multipleOf` appear nowhere in it.
 */
function numberProblem(
  path: string,
  value: number,
  node: Node,
  expects: ReadonlySet<string> | undefined,
): string | undefined {
  if (expects?.has("integer") && !expects.has("number") && !Number.isInteger(value)) {
    return `${path} is ${value}, but herdr expects a whole number`;
  }
  if (node.minimum !== undefined && value < node.minimum) {
    return `${path} is ${value}, but herdr's minimum is ${node.minimum}`;
  }
  if (node.maximum !== undefined && value > node.maximum) {
    return `${path} is ${value}, but herdr's maximum is ${node.maximum}`;
  }
  return undefined;
}

function walkRequest(
  resolve: Resolve,
  path: string,
  params: Schema.Json,
  node: Node,
): ReadonlyArray<string> {
  const resolved = resolve(node);
  const branches = resolved.oneOf ?? resolved.anyOf;
  if (branches) {
    for (const branch of branches) {
      if (walkRequest(resolve, path, params, branch).length === 0) return [];
    }
    return [`${path} matches no variant of herdr's schema`];
  }

  const actual = jsonType(params);
  const expects = herdrTypes(resolve, resolved);
  if (expects && !admits(expects, actual)) {
    return [`${path} is ${actual}, but herdr expects ${[...expects].join("|")}`];
  }
  if (actual === "number") {
    const problem = numberProblem(path, Number(params), resolved, expects);
    if (problem) return [problem];
  }
  if (resolved.const !== undefined && params !== resolved.const) {
    return [`${path} must be ${JSON.stringify(resolved.const)}`];
  }
  if (resolved.enum && !resolved.enum.includes(params)) {
    return [`${path} must be one of ${JSON.stringify(resolved.enum)}`];
  }

  const findings: string[] = [];
  const object = Option.getOrUndefined(asJsonObject(params));
  if (object) {
    for (const key of resolved.required ?? []) {
      if (!(key in object)) {
        findings.push(`${path}.${key} is required by herdr, but the request omits it`);
      }
    }
    for (const [key, value] of Object.entries(object)) {
      const declared = resolved.properties?.[key];
      if (!declared) {
        if (resolved.additionalProperties === false) {
          findings.push(`${path}.${key} is not a param herdr accepts`);
        }
        continue;
      }
      findings.push(...walkRequest(resolve, `${path}.${key}`, value, declared));
    }
  }
  if (Array.isArray(params) && resolved.items) {
    for (const [index, value] of params.entries()) {
      findings.push(...walkRequest(resolve, `${path}[${index}]`, value, resolved.items));
    }
  }
  return findings;
}

/**
 * The JSON Schema type name of a value. Named by decoding rather than by `typeof`, so
 * the names come from the same schemas the rest of the boundary is built from.
 *
 * There is no `integer` row on purpose: JSON has no integer type, so every number here
 * is a `number`, and whether herdr's `integer` is satisfied by a particular one is
 * `numberProblem`'s question.
 */
const JSON_TYPES: ReadonlyArray<readonly [string, Schema.Codec<unknown, unknown, never, never>]> = [
  ["null", Schema.Null],
  ["boolean", Schema.Boolean],
  ["number", Schema.Number],
  ["string", Schema.String],
  ["array", Schema.Array(Schema.Json)],
  ["object", Schema.JsonObject],
];

function jsonType(value: Schema.Json): string {
  for (const [name, schema] of JSON_TYPES) {
    if (Option.isSome(Schema.decodeUnknownOption(schema)(value))) return name;
  }
  throw new Error(`value is not JSON: ${JSON.stringify(value)}`);
}

const asJsonObject = Schema.decodeUnknownOption(Schema.JsonObject);

/**
 * Effect's literals may be `bigint`, which JSON has no type for. These structs decode
 * JSON from herdr, so such a literal could never match anything herdr sends: refusing
 * it by name beats naming it `integer` and comparing it as though it could.
 */
const jsonLiteral = Schema.decodeUnknownSync(Schema.Json);
