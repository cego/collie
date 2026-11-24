import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Order from "effect/Order";
import * as Rec from "effect/Record";
import { Effect, FileSystem, Option, Schema } from "effect";
import { appendRunJournal, readRunJournal, runJournal } from "./journal";
import { readControl, readingContext } from "./compaction";
import type { CompactionPorts } from "./compaction";
import { launchDir, readLaunches, stemOf } from "./launches";
import type { Launched } from "./launches";
import { shell } from "./mr";
import { isoAt, nowIso } from "./time";
import { adds, ledgerOf, readSource, Source, UsageEntry } from "./usage-ledger-model";
import type { Reading, Startup } from "./usage-ledger-model";

export interface LedgerDeps {
  readonly dir: string;
}

export interface LedgerAt {
  readonly run: string;
  readonly agent: string;
  readonly step?: string;
  readonly heal?: boolean;
}

export interface LedgerAgent {
  readonly harness: string;
  readonly cwd: string;
  readonly dir: string;
}

const UsageJson = Schema.fromJsonString(UsageEntry);
const ledgerPath = (runDir: string) => runJournal(runDir, "usage.jsonl");

export const appendUsage = (runDir: string, entry: UsageEntry) =>
  appendRunJournal(ledgerPath(runDir), UsageJson, entry);

export const readUsage = Effect.fn("UsageLedger.read")(function* (runDir: string) {
  const none: Array<UsageEntry> = [];
  return yield* readRunJournal(ledgerPath(runDir), UsageJson).pipe(
    Effect.orElseSucceed(() => none),
  );
});

const STATE = "ledger.json";
const LedgerState = Schema.Struct({
  offsets: Schema.Record(Schema.String, Schema.Finite),
  sources: Schema.Array(Source),
});
const LedgerStateJson = Schema.fromJsonString(LedgerState);
const NEWLINE = 10;
const HEADS = 200;

const readState = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file);
    return yield* Schema.decodeEffect(LedgerStateJson)(text);
  }).pipe(Effect.orElseSucceed(() => ({ offsets: {}, sources: [] })));

const headsOf = (cwd: string) =>
  shell("git", ["log", "--first-parent", "--format=%H %ct", "-n", String(HEADS)], cwd).pipe(
    Effect.map((ran) =>
      ran.code !== 0
        ? []
        : Arr.getSomes(
            Arr.map(Str.split(Str.trim(ran.stdout), "\n"), (line) => {
              const [sha, seconds] = Str.split(line, " ");
              return sha === undefined || seconds === undefined || sha === ""
                ? Option.none()
                : Option.some({ sha, ms: Number(seconds) * 1000 });
            }),
          ),
    ),
  );

const headAt = (heads: ReadonlyArray<{ readonly sha: string; readonly ms: number }>, ms: number) =>
  Number.isFinite(ms)
    ? Arr.findFirst(heads, (one) => one.ms <= ms).pipe(
        Option.map((one) => one.sha),
        Option.getOrNull,
      )
    : (heads[0]?.sha ?? null);

const launchAt = (launches: ReadonlyArray<Launched>, ms: number) =>
  Arr.findLast(launches, (one) => !Number.isFinite(ms) || (one.at ?? 0) <= ms).pipe(
    Option.orElse(() => Arr.head(launches)),
    Option.getOrUndefined,
  );

const personaChars = (deps: LedgerDeps, run: string, first: Launched | undefined) =>
  first === undefined
    ? Effect.succeed(null)
    : FileSystem.FileSystem.use((fs) =>
        fs.readFileString(`${launchDir(deps.dir, run)}/${stemOf(first)}.persona.md`),
      ).pipe(
        Effect.map((text) => Str.trimEnd(text).length),
        Effect.orElseSucceed(() => null),
      );

const readNew = (sources: ReadonlyArray<Source>, offsets: Readonly<Record<string, number>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const decoder = new TextDecoder();
    let moved = offsets;
    const readings: Array<Reading> = [];
    for (const source of sources) {
      const bytes = yield* fs.readFile(source.path).pipe(Effect.option);
      if (Option.isNone(bytes)) {
        continue;
      }
      const end = bytes.value.lastIndexOf(NEWLINE) + 1;
      // WARNING: a file shorter than what was read of it is a new file in its place.
      const from = (offsets[source.path] ?? 0) > end ? 0 : (offsets[source.path] ?? 0);
      if (end <= from) {
        continue;
      }
      readings.push(readSource(source, decoder.decode(bytes.value.subarray(from, end))));
      moved = Rec.set(moved, source.path, end);
    }
    return { readings, offsets: moved };
  });

export const recordFrom = Effect.fn("UsageLedger.recordFrom")(function* (
  deps: LedgerDeps,
  at: LedgerAt,
  agent: LedgerAgent,
  found: ReadonlyArray<Source>,
) {
  const fs = yield* FileSystem.FileSystem;
  const stateFile = `${agent.dir}/${STATE}`;
  const state = yield* readState(stateFile);
  const sources = Arr.dedupeWith([...state.sources, ...found], (a, b) => a.path === b.path);
  const { readings, offsets } = yield* readNew(sources, state.offsets);
  const evidence = `${deps.dir}/evidence/${at.run}`;
  const ledger = ledgerOf(yield* readUsage(evidence));
  const launches = Arr.sortWith(
    Arr.filter(
      yield* readLaunches(at.run).pipe(Effect.orElseSucceed(() => [])),
      (one) => one.agent === at.agent,
    ),
    (one: Launched) => one.at ?? 0,
    Order.Number,
  );
  const heads = yield* headsOf(agent.cwd);
  const now = yield* nowIso;
  // WARNING: a reused agent's launch is given no persona of its own.
  const persona = yield* personaChars(
    deps,
    at.run,
    Option.getOrUndefined(Arr.findFirst(launches, (one) => !one.reused)),
  );
  const when = (ms: number) => (Number.isFinite(ms) ? isoAt(ms) : now);
  const stepAt = (ms: number) => launchAt(launches, ms)?.operation ?? at.step ?? "";
  const keys = { agent: at.agent };

  const read: Array<UsageEntry> = [];
  for (const reading of readings) {
    for (const one of reading.requests) {
      const launch = launchAt(launches, one.at);
      read.push({
        what: "request",
        ...keys,
        key: one.key,
        at: when(one.at),
        session: one.session,
        parent: one.parent,
        step: launch?.operation ?? at.step ?? "",
        harness: agent.harness,
        model: one.model ?? launch?.model ?? null,
        effort: launch?.effort ?? null,
        head: headAt(heads, one.at),
        input: one.input,
        cacheRead: one.cacheRead,
        cacheCreation: one.cacheCreation,
        output: one.output,
        reasoning: one.reasoning,
      });
    }
    for (const one of reading.events) {
      read.push({
        what: one.what,
        ...keys,
        key: one.key,
        at: when(one.at),
        session: one.session,
        parent: one.parent,
        step: stepAt(one.at),
        chars: one.chars,
      });
    }
    const own = new Set(
      Arr.map(
        Arr.filter([...reading.requests, ...reading.events], (one) => one.parent === null),
        (one) => one.session,
      ),
    );
    for (const session of own) {
      const seen = Arr.findFirst(reading.startup, (one) => one.session === session).pipe(
        Option.map((one) => one.startup),
        Option.getOrElse(() => {
          const none: Partial<Startup> = {};
          return none;
        }),
      );
      read.push({
        what: "session",
        ...keys,
        session,
        harness: agent.harness,
        recovery: at.heal === true,
        startup: {
          system: seen.system ?? null,
          persona,
          project: seen.project ?? null,
          tools: seen.tools ?? null,
          skills: seen.skills ?? null,
        },
      });
    }
  }
  // WARNING: a Heal's sessions may be recorded before it was known to be one.
  if (at.heal === true) {
    for (const kept of ledger.sessions.values()) {
      if (kept.agent === at.agent) {
        read.push({ ...kept, recovery: true });
      }
    }
  }

  const batch = ledgerOf(read);
  const fresh = Arr.filter(
    [...batch.requests.values(), ...batch.happenings.values(), ...batch.sessions.values()],
    (entry) => adds(ledger, entry),
  );
  for (const entry of fresh) {
    yield* appendUsage(evidence, entry);
  }
  yield* fs.makeDirectory(agent.dir, { recursive: true });
  yield* fs.writeFileString(
    stateFile,
    yield* Schema.encodeEffect(LedgerStateJson)({ offsets, sources }),
  );
});

// WARNING: a failed read records nothing and fails nothing.
export const recordUsage = (
  deps: LedgerDeps & { readonly stateDir: string; readonly ports: CompactionPorts },
  at: LedgerAt,
) =>
  Effect.gen(function* () {
    const control = yield* readControl(deps.stateDir, at.agent);
    if (control === null) {
      return;
    }
    const records = deps.ports[control.harness]?.records;
    const found =
      records === undefined
        ? []
        : yield* records(readingContext(control, at.run)).pipe(Effect.orElseSucceed(() => []));
    yield* recordFrom(deps, at, control, found);
  }).pipe(Effect.ignore);
