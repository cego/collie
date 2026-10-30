// This Machine's Harness catalogue, read from each installed harness and kept on the host
// beside Usage (ADR-0049): each harness read at most once per interval, with a timeout per
// read and a back-off after a failure, which leaves Collie's table in its place.

import {
  Clock,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  ClaudeModels,
  CodexModelList,
  claudeEntries,
  codexEntries,
  opencodeEntries,
  piEntries,
  tableEntries,
  withAdded,
  type CatalogueEntry,
  type HarnessCatalogue,
} from "./catalogue-model";
import { loadDefaults } from "./config";
import { currentEnv } from "./env";
import { reason } from "./naming";

/** How long a harness's reading stands before it is read again. */
export const CATALOGUE_INTERVAL_MS = 30 * 60_000;
/** How long one read may take before the harness is said not to answer. */
export const CATALOGUE_CALL_MS = 20_000;
/** The wait after a failed read, doubled for each failure after it, up to the interval. */
export const CATALOGUE_RETRY_MS = 60_000;

/** A harness's entries, null where it is not installed, or why it could not be read. */
export type HarnessSource = Effect.Effect<ReadonlyArray<CatalogueEntry> | null, string>;

/** What each harness answers, decoded where it is JSON; null where it is not installed. */
export interface HarnessAdapters {
  readonly claude: Effect.Effect<ClaudeModels | null, string>;
  readonly codex: Effect.Effect<CodexModelList | null, string>;
  readonly pi: Effect.Effect<string | null, string>;
  readonly opencode: Effect.Effect<string | null, string>;
}

export type Harness = keyof HarnessAdapters;
const HARNESSES: ReadonlyArray<Harness> = ["claude", "codex", "pi", "opencode"];
export type CatalogueSources = Readonly<Record<Harness, HarnessSource>>;

export class HarnessCatalogues extends Context.Service<
  HarnessCatalogues,
  { readonly catalogues: Effect.Effect<ReadonlyArray<HarnessCatalogue>> }
>()("collie/HarnessCatalogues") {}

const SOURCE = {
  claude: "Claude Code's supportedModels()",
  codex: "codex app-server model/list",
  pi: "pi --list-models",
  opencode: "opencode models",
} satisfies Record<Harness, string>;

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

/** A harness that prints a list: its entries, or what it said instead of one. */
const listed = (
  harness: Harness,
  printed: Effect.Effect<string | null, string>,
  decode: (text: string) => ReadonlyArray<CatalogueEntry> | null,
): HarnessSource =>
  Effect.flatMap(printed, (text) => {
    if (text === null) return Effect.succeed(null);
    const entries = decode(text);
    return entries === null
      ? Effect.fail(`${SOURCE[harness]} said: ${firstLine(text)}`)
      : Effect.succeed(entries);
  });

export const sourcesOf = (adapters: HarnessAdapters): CatalogueSources => ({
  claude: Effect.map(adapters.claude, (models) => (models === null ? null : claudeEntries(models))),
  codex: Effect.map(adapters.codex, (list) => (list === null ? null : codexEntries(list))),
  pi: listed("pi", adapters.pi, piEntries),
  opencode: listed("opencode", adapters.opencode, opencodeEntries),
});

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** One harness behind its interval, its back-off after a failure, and its timeout. */
const paced = Effect.fn("Catalogue.paced")(function* (harness: Harness, source: HarnessSource) {
  const single = yield* Semaphore.make(1);
  let until = 0;
  let failures = 0;
  let shown: HarnessCatalogue | null | undefined;
  return single.withPermits(1)(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (shown !== undefined && now < until) return shown;
      const read = yield* source.pipe(
        Effect.timeoutOrElse({
          duration: CATALOGUE_CALL_MS,
          orElse: () =>
            Effect.fail(`${SOURCE[harness]} did not answer within ${CATALOGUE_CALL_MS / 1000}s`),
        }),
        Effect.result,
      );
      if (Result.isSuccess(read)) {
        failures = 0;
        until = now + CATALOGUE_INTERVAL_MS;
        shown =
          read.success === null
            ? null
            : { harness, at: iso(now), table: null, entries: read.success };
      } else {
        failures += 1;
        until = now + Math.min(CATALOGUE_INTERVAL_MS, CATALOGUE_RETRY_MS * 2 ** (failures - 1));
        shown = { harness, at: iso(now), table: read.failure, entries: tableEntries(harness) };
      }
      return shown;
    }),
  );
});

export const makeCatalogue = Effect.fn("Catalogue.make")(function* (
  sources: CatalogueSources,
  /** The `models.<harness>` setting, read each time. */
  added: Effect.Effect<Readonly<Record<string, ReadonlyArray<string>>>>,
) {
  const readers = yield* Effect.forEach(HARNESSES, (harness) => paced(harness, sources[harness]));
  return HarnessCatalogues.of({
    catalogues: Effect.all([Effect.all(readers, { concurrency: "unbounded" }), added]).pipe(
      Effect.map(([read, extra]) =>
        read.filter((one) => one !== null).map((one) => withAdded(one, extra[one.harness] ?? [])),
      ),
    ),
  });
});

/** A harness's command run to its end: what it printed, or null where it is not installed. */
const printed = (command: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawned = yield* spawner
      .spawn(
        ChildProcess.make(command, args, {
          stdout: "pipe",
          stderr: "pipe",
          extendEnv: true,
        }),
      )
      .pipe(Effect.option);
    if (Option.isNone(spawned)) return null;
    const [out, err, code] = yield* Effect.all(
      [
        spawned.value.stdout.pipe(Stream.decodeText(), Stream.mkString),
        spawned.value.stderr.pipe(Stream.decodeText(), Stream.mkString),
        spawned.value.exitCode,
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.mapError(reason));
    if (Number(code) !== 0)
      return yield* Effect.fail(`${command} exited ${code}: ${firstLine(err || out)}`);
    return out;
  }).pipe(Effect.scoped);

/**
 * One exchange with a harness that speaks JSON lines on stdio: `lines` sent, stdin held
 * open, and the first line `reply` answers taken; null where it is not installed.
 */
const exchange = <A>(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  lines: ReadonlyArray<object>,
  reply: (line: string) => Result.Result<A, string> | undefined,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const sent = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
    const spawned = yield* spawner
      .spawn(
        ChildProcess.make(command, args, {
          cwd,
          // Held open: a closed stdin is the cue to stop before answering.
          stdin: Stream.concat(Stream.make(new TextEncoder().encode(sent)), Stream.never),
          stdout: "pipe",
          stderr: "ignore",
          extendEnv: true,
        }),
      )
      .pipe(Effect.option);
    if (Option.isNone(spawned)) return null;
    const answer = yield* spawned.value.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.map(reply),
      Stream.filter((answered) => answered !== undefined),
      Stream.runHead,
      Effect.mapError(reason),
    );
    if (Option.isNone(answer)) return yield* Effect.fail(`${command} stopped before it answered`);
    return yield* Result.match(answer.value, {
      onSuccess: (answered) => Effect.succeed(answered),
      onFailure: (why) => Effect.fail(why),
    });
  }).pipe(Effect.scoped);

const ClaudeReply = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("control_response"),
    response: Schema.Struct({
      request_id: Schema.optionalKey(Schema.String),
      response: Schema.optionalKey(Schema.Struct({ models: Schema.Unknown })),
      error: Schema.optionalKey(Schema.String),
    }),
  }),
);
const decodeClaudeReply = Schema.decodeUnknownOption(ClaudeReply);
const decodeClaudeModels = Schema.decodeUnknownOption(ClaudeModels);

const CodexReply = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.Number,
    result: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
  }),
);
const decodeCodexReply = Schema.decodeUnknownOption(CodexReply);
const decodeCodexModels = Schema.decodeUnknownOption(CodexModelList);

const undecodable = (harness: Harness) =>
  Result.fail(`${SOURCE[harness]} answered in a shape Collie does not read`);

/** What the Agent SDK's `supportedModels()` asks: Claude Code's `initialize` over stream-json. */
const claudeModels = (cwd: string) =>
  exchange(
    "claude",
    [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--no-session-persistence",
    ],
    cwd,
    [{ type: "control_request", request_id: "models", request: { subtype: "initialize" } }],
    (line) => {
      const reply = Option.getOrNull(decodeClaudeReply(line))?.response;
      if (reply?.request_id !== "models") return undefined;
      if (reply.response === undefined)
        return Result.fail(`claude: ${reply.error ?? "initialize failed"}`);
      return Option.match(decodeClaudeModels(reply.response.models), {
        onNone: () => undecodable("claude"),
        onSome: (models) => Result.succeed(models),
      });
    },
  );

const codexModels = (cwd: string) =>
  exchange(
    "codex",
    ["app-server"],
    cwd,
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "collie", version: "0" } },
      },
      { jsonrpc: "2.0", method: "initialized" },
      // ponytail: one page; follow `nextCursor` if a Codex ever lists more than a page.
      { jsonrpc: "2.0", id: 2, method: "model/list", params: { includeHidden: true } },
    ],
    (line) => {
      const reply = Option.getOrNull(decodeCodexReply(line));
      if (reply?.id !== 2) return undefined;
      if (reply.error !== undefined) return Result.fail(`codex model/list: ${reply.error.message}`);
      return Option.match(decodeCodexModels(reply.result), {
        onNone: () => undecodable("codex"),
        onSome: (list) => Result.succeed(list),
      });
    },
  );

export const liveAdapters = (cwd: string) =>
  Effect.map(
    Effect.context<ChildProcessSpawner.ChildProcessSpawner>(),
    (services): HarnessAdapters => ({
      claude: Effect.provideContext(claudeModels(cwd), services),
      codex: Effect.provideContext(codexModels(cwd), services),
      pi: Effect.provideContext(printed("pi", ["--list-models"]), services),
      opencode: Effect.provideContext(printed("opencode", ["models"]), services),
    }),
  );

/** This Machine's one reader of its harnesses, on the environment this process runs in. */
export const catalogueLayer = (cwd: string) =>
  Layer.effect(
    HarnessCatalogues,
    Effect.gen(function* () {
      const env = yield* currentEnv.pipe(Effect.orDie);
      const files = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
      return yield* makeCatalogue(
        sourcesOf(yield* liveAdapters(cwd)),
        loadDefaults(env.userDir).pipe(
          Effect.map((defaults) => defaults.models),
          Effect.orElseSucceed(() => ({})),
          Effect.provideContext(files),
        ),
      );
    }),
  );
