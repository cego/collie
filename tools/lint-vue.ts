import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Arr from "effect/Array";
import * as Num from "effect/Number";
import * as Str from "effect/String";
import { Console, Data, Effect, FileSystem, Option, Path, Result, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import ts from "../desktop/node_modules/typescript/lib/typescript.js";
import {
  NodeTypes,
  type RootNode,
  type TemplateChildNode,
} from "../desktop/node_modules/@vue/compiler-dom";
import {
  createParsedCommandLine,
  createVueLanguagePlugin,
  forEachEmbeddedCode,
  getDefaultCompilerOptions,
  type CodeMapping,
  type VueCompilerOptions,
} from "../desktop/node_modules/@vue/language-core/index.js";

export class VueLintFailure extends Data.TaggedError("VueLintFailure")<{
  file: string;
  reason: string;
}> {
  override get message() {
    return `${this.file}: ${this.reason}`;
  }
}

const Span = Schema.Struct({
  offset: Schema.Int,
  length: Schema.Int,
  line: Schema.Int,
  column: Schema.Int,
});
export const VueDiagnostic = Schema.Struct({
  filename: Schema.String,
  code: Schema.String,
  message: Schema.String,
  severity: Schema.String,
  labels: Schema.Array(Schema.Struct({ span: Span })),
});
export type VueDiagnostic = typeof VueDiagnostic.Type;

export interface Rewrite {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface VueProjection {
  readonly file: string;
  readonly source: string;
  readonly code: string;
  readonly mappings: ReadonlyArray<CodeMapping>;
  readonly rewrites: ReadonlyArray<Rewrite>;
  readonly extension: string;
  readonly templateNames: ReadonlyArray<{ readonly start: number; readonly end: number }>;
}

export function projectVue(
  file: string,
  source: string,
  options: ts.CompilerOptions = {},
  vue: VueCompilerOptions = getDefaultCompilerOptions(),
): Result.Result<VueProjection, VueLintFailure> {
  const built = Result.try({
    try: () => {
      const plugin = createVueLanguagePlugin(ts, options, vue, (id: string) => id);
      const root = plugin.createVirtualCode?.(file, "vue", ts.ScriptSnapshot.fromString(source), {
        getAssociatedScript: () => undefined,
      });
      const service =
        root === undefined
          ? Option.none()
          : Arr.findFirst([...forEachEmbeddedCode(root)], (code) =>
              /^script_(?:js|jsx|ts|tsx)$/.test(code.id),
            );
      return { root, service: Option.getOrUndefined(service) };
    },
    catch: (cause) => new VueLintFailure({ file, reason: String(cause) }),
  });
  if (Result.isFailure(built)) return Result.fail(built.failure);
  const { root, service } = built.success;
  const errors = root?.vueSfc?.errors ?? [];
  if (errors.length > 0)
    return Result.fail(
      new VueLintFailure({
        file,
        reason: Arr.join(
          Arr.map(errors, (error) => error.message),
          "; ",
        ),
      }),
    );
  const syntax = Arr.flatMap(
    [root?.vueSfc?.descriptor.script, root?.vueSfc?.descriptor.scriptSetup],
    (block) =>
      block === undefined || block === null
        ? []
        : (ts.transpileModule(block.content, {
            fileName: `${file}.${block.lang ?? "js"}`,
            reportDiagnostics: true,
            compilerOptions: {
              target: ts.ScriptTarget.Latest,
              module: ts.ModuleKind.ESNext,
              jsx: ts.JsxEmit.Preserve,
            },
          }).diagnostics ?? []),
  );
  if (syntax.length > 0)
    return Result.fail(
      new VueLintFailure({
        file,
        reason: Arr.join(
          Arr.map(syntax, (error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")),
          "; ",
        ),
      }),
    );
  if (service === undefined)
    return Result.fail(new VueLintFailure({ file, reason: "Vue produced no semantic script" }));
  const templateNames: Array<{ start: number; end: number }> = [];
  const template = root?.ir.template;
  const visitTemplate = (node: RootNode | TemplateChildNode) => {
    if (node.type === NodeTypes.ELEMENT) {
      for (const prop of node.props) {
        if (
          prop.type !== NodeTypes.DIRECTIVE ||
          prop.arg?.type !== NodeTypes.SIMPLE_EXPRESSION ||
          !prop.arg.isStatic
        )
          continue;
        templateNames.push({
          start: (template?.startTagEnd ?? 0) + prop.arg.loc.start.offset,
          end: (template?.startTagEnd ?? 0) + prop.arg.loc.end.offset,
        });
      }
    }
    if (node.type === NodeTypes.IF)
      for (const branch of node.branches) for (const child of branch.children) visitTemplate(child);
    if (
      node.type === NodeTypes.ROOT ||
      node.type === NodeTypes.ELEMENT ||
      node.type === NodeTypes.FOR
    )
      for (const child of node.children) visitTemplate(child);
  };
  if (template?.ast !== undefined) visitTemplate(template.ast);
  return Result.succeed({
    file,
    source,
    code: service.snapshot.getText(0, service.snapshot.getLength()),
    mappings: service.mappings,
    rewrites: [],
    extension: `.${Str.slice(7)(service.id)}`,
    templateNames,
  });
}

export function rewriteProjection(
  projection: VueProjection,
  resolve: (name: string) => string | null,
): VueProjection {
  const edits: Rewrite[] = [];
  const file = ts.createSourceFile(projection.file, projection.code, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    const parent = node.parent;
    if (
      ts.isStringLiteralLike(node) &&
      parent !== undefined &&
      (((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
        parent.moduleSpecifier === node) ||
        ts.isExternalModuleReference(parent) ||
        (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) ||
        (ts.isCallExpression(parent) &&
          parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
          parent.arguments[0] === node))
    ) {
      const text = resolve(node.text);
      if (text !== null) edits.push({ start: node.getStart(file) + 1, end: node.end - 1, text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const reference of ts.preProcessFile(projection.code).typeReferenceDirectives) {
    const text = resolve(reference.fileName);
    if (text !== null) edits.push({ start: reference.pos, end: reference.end, text });
  }
  const rewrites = Arr.sort(edits, (a: Rewrite, b: Rewrite) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : 0,
  );
  let at = 0;
  let code = "";
  for (const edit of rewrites) {
    code += Str.slice(at, edit.start)(projection.code) + edit.text;
    at = edit.end;
  }
  return { ...projection, code: code + Str.slice(at)(projection.code), rewrites };
}

export function mapVueDiagnostic(
  projection: VueProjection,
  diagnostic: VueDiagnostic,
): VueDiagnostic | null {
  const originalGeneratedOffset = (offset: number) => {
    let shift = 0;
    for (const edit of projection.rewrites) {
      const start = edit.start + shift;
      if (offset < start) return offset - shift;
      if (offset < start + edit.text.length)
        return edit.start + Num.min(offset - start, edit.end - edit.start);
      shift += edit.text.length - (edit.end - edit.start);
    }
    return offset - shift;
  };
  const sourceRange = (startOffset: number, endOffset: number) => {
    for (const mapping of projection.mappings) {
      if (!mapping.data.verification) continue;
      for (const [index, length] of mapping.lengths.entries()) {
        const start = mapping.generatedOffsets[index];
        const from = mapping.sourceOffsets[index];
        const generatedLength = mapping.generatedLengths?.[index] ?? length;
        if (start === undefined || from === undefined || length === 0 || length !== generatedLength)
          continue;
        if (startOffset >= start && startOffset < start + length && endOffset <= start + length)
          return { at: from + startOffset - start, end: from + endOffset - start };
      }
    }
    return null;
  };
  const bytes = new TextEncoder().encode(projection.code);
  const decoder = new TextDecoder();
  const labels = Arr.flatMap(diagnostic.labels, ({ span }) => {
    const start = originalGeneratedOffset(decoder.decode(bytes.subarray(0, span.offset)).length);
    const end = originalGeneratedOffset(
      decoder.decode(bytes.subarray(0, span.offset + span.length)).length,
    );
    const range = sourceRange(start, end);
    if (range === null) return [];
    // Vue compiles static directive and slot names into JavaScript keys.
    // Their bound expressions retain normal semantic lint coverage.
    if (
      Arr.some(projection.templateNames, (name) => range.at >= name.start && range.end <= name.end)
    )
      return [];
    const before = Str.slice(0, range.at)(projection.source);
    return [
      {
        span: {
          offset: new TextEncoder().encode(before).length,
          length: new TextEncoder().encode(Str.slice(range.at, range.end)(projection.source))
            .length,
          line: Str.split(before, "\n").length,
          column: range.at - Option.getOrElse(Str.lastIndexOf("\n")(before), () => -1),
        },
      },
    ];
  });
  return labels.length === 0 ? null : { ...diagnostic, filename: projection.file, labels };
}

const Inventory = Schema.fromJsonString(
  Schema.Struct({ diagnostics: Schema.Array(VueDiagnostic) }),
);
const json = Schema.encodeEffect(Inventory);

export const projectionIncludes = (projectFiles: ReadonlyArray<string>): ReadonlyArray<string> => [
  "./*.ts",
  "./*.tsx",
  "./*.js",
  "./*.jsx",
  ...projectFiles,
];

const capture = Effect.fn("VueLint.capture")(function* (command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(command);
      const [stdout, stderr, code] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.decodeText(), Stream.mkString),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, code };
    }),
  );
});

export const lintVue = Effect.fn("lintVue")(function* (
  root: string,
  selected: ReadonlyArray<string> = [],
  asJson: boolean = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const desktop = paths.join(root, "desktop");
  const prepared = yield* capture(
    ChildProcess.make(paths.join(desktop, "node_modules/.bin/nuxi"), ["prepare", "view"], {
      cwd: desktop,
    }),
  );
  if (prepared.code !== 0)
    return yield* new VueLintFailure({ file: desktop, reason: prepared.stdout + prepared.stderr });
  if (Str.trim(prepared.stderr) !== "") yield* Console.error(prepared.stderr);
  const context = paths.join(desktop, "view/.nuxt/tsconfig.app.json");
  yield* fs.access(context);
  const parsed = createParsedCommandLine(ts, ts.sys, context);
  const errors: ts.Diagnostic[] = [];
  const project = ts.getParsedCommandLineOfConfigFile(
    context,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (error) => {
        errors.push(error);
      },
    },
  );
  if (project === undefined || project.options.configFilePath === undefined)
    return yield* new VueLintFailure({
      file: context,
      reason: "Vue compiler options could not be read",
    });
  const configErrors = [...errors, ...project.errors];
  if (configErrors.length > 0)
    return yield* new VueLintFailure({
      file: context,
      reason: Arr.join(
        Arr.map(configErrors, (error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")),
        "\n",
      ),
    });
  const files =
    selected.length > 0
      ? Arr.map(selected, (file) => paths.resolve(root, file))
      : Arr.map(yield* fs.glob("**/*.vue", { root: paths.join(desktop, "view/app") }), (file) =>
          paths.join(desktop, "view/app", file),
        );
  if (files.length === 0) {
    if (asJson) yield* Console.log(yield* json({ diagnostics: [] }));
    return 0;
  }
  const projections = new Map<string, VueProjection>();
  for (const file of files)
    projections.set(
      file,
      yield* Effect.fromResult(
        projectVue(file, yield* fs.readFileString(file), parsed.options, parsed.vueOptions),
      ),
    );
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const scratch = paths.join(desktop, ".scratch");
      yield* fs.makeDirectory(scratch, { recursive: true });
      const temp = yield* fs.makeTempDirectoryScoped({
        directory: scratch,
        prefix: "effect-lint-",
      });
      const virtualFiles = new Map(
        Arr.map(
          [...projections],
          ([file, projection], index) =>
            [file, paths.join(temp, `${index}${projection.extension}`)] as const,
        ),
      );
      const readHost: ts.ModuleResolutionHost = {
        ...ts.sys,
        fileExists: (file) =>
          (Str.endsWith(".vue.ts")(file) && projections.has(Str.slice(0, -3)(file))) ||
          ts.sys.fileExists(file),
      };
      const written = new Map<string, VueProjection>();
      for (const [file, projection] of projections) {
        const rewritten = rewriteProjection(projection, (name) => {
          const resolved = ts.resolveModuleName(
            name,
            file,
            parsed.options,
            readHost,
          ).resolvedModule;
          const vue =
            resolved === undefined
              ? undefined
              : virtualFiles.get(Str.slice(0, -3)(resolved.resolvedFileName));
          if (vue !== undefined) return vue;
          return Str.startsWith(".")(name)
            ? (resolved?.resolvedFileName ?? paths.resolve(paths.dirname(file), name))
            : null;
        });
        const target = virtualFiles.get(file);
        if (target === undefined)
          return yield* new VueLintFailure({ file, reason: "projection target missing" });
        written.set(target, rewritten);
        yield* fs.writeFileString(target, rewritten.code, { flag: "wx" });
      }
      yield* fs.writeFileString(
        paths.join(temp, "tsconfig.json"),
        yield* Schema.encodeEffect(
          Schema.fromJsonString(
            Schema.Struct({ extends: Schema.String, include: Schema.Array(Schema.String) }),
          ),
        )({ extends: context, include: projectionIncludes(project.fileNames) }),
      );
      yield* fs.writeFileString(
        paths.join(temp, "oxlint.json"),
        yield* Schema.encodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              extends: Schema.Array(Schema.String),
              ignorePatterns: Schema.Array(Schema.String),
            }),
          ),
        )({ extends: [paths.join(root, ".oxlintrc.json")], ignorePatterns: [] }),
      );
      const { stdout, stderr, code } = yield* capture(
        ChildProcess.make(
          paths.join(root, "node_modules/.bin/effect-tsgo"),
          [
            "oxlint",
            "--config",
            paths.join(temp, "oxlint.json"),
            "--no-ignore",
            "--format=json",
            ...virtualFiles.values(),
          ],
          { cwd: root },
        ),
      );
      const inventory = yield* Schema.decodeEffect(Inventory)(stdout);
      if (code !== 0 && inventory.diagnostics.length === 0)
        return yield* new VueLintFailure({
          file: root,
          reason: stderr || "Oxlint failed without diagnostics",
        });
      const diagnostics = Arr.flatMap(inventory.diagnostics, (diagnostic) => {
        const projection = written.get(paths.resolve(root, diagnostic.filename));
        if (projection === undefined) return [diagnostic];
        const mapped = mapVueDiagnostic(projection, diagnostic);
        return mapped === null ? [] : [mapped];
      });
      if (asJson) yield* Console.log(yield* json({ diagnostics }));
      else
        for (const diagnostic of diagnostics) {
          const at = diagnostic.labels[0]?.span;
          yield* Console.error(
            `${diagnostic.filename}:${at?.line ?? 1}:${at?.column ?? 1}: ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`,
          );
        }
      return diagnostics.length > 0 ? 1 : 0;
    }),
  );
});

if (import.meta.main) {
  const args = Arr.drop(Bun.argv, 2);
  BunRuntime.runMain(
    lintVue(
      process.cwd(),
      Arr.filter(args, (arg) => arg !== "--format=json"),
      Arr.contains(args, "--format=json"),
    ).pipe(
      Effect.provide(BunServices.layer),
      Effect.flatMap((code) =>
        Effect.sync(() => {
          process.exitCode = code;
        }),
      ),
    ),
  );
}
