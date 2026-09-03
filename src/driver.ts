import { Crypto, Effect, Fiber, FileSystem, Path, Schema, Option, Queue, Stream } from "effect";
import { nowIso } from "./time";
import {
  currentPid,
  holdsLock,
  lockWriteIsFresh,
  processStartTime,
  signalProcess,
  withLock,
} from "./lock";
import type { EnginePrompts } from "./engine";
import type { PickItem } from "./inputs";
import { isString } from "./schema";

export const PROGRESS = "progress.jsonl";
export const RUNNER_LOG = "runner.log";
export const RUNNER_PID = "runner.pid";
export const STOPPED = "stopped";
export const CHOICE = "choice.json";
export const CHOICE_ANSWER = "choice-answer.json";
export interface ProgressLine {
  at: string;
  text: string;
}
export interface PendingChoice {
  id: string;
  kind: "menu" | "ask";
  run: string;
  step: string;
  header: string;
  footer: string;
  items: readonly PickItem[];
}
export interface ChoiceAnswer {
  id: string;
  choice?: string | null;
  text?: string | null;
}
export interface OwnerRecord {
  pid: number;
  start: string | null;
  at: string;
}

const PickItemJson = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  subtitle: Schema.optionalKey(Schema.String),
});
const ProgressLineJson = Schema.fromJsonString(
  Schema.Struct({ at: Schema.String, text: Schema.String }),
);
const PendingChoiceJson = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literals(["menu", "ask"]),
    run: Schema.String,
    step: Schema.String,
    header: Schema.String,
    footer: Schema.String,
    items: Schema.Array(PickItemJson),
  }),
);
const ChoiceAnswerJson = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    choice: Schema.optionalKey(Schema.NullOr(Schema.String)),
    text: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);
/**
 * The ownership claim. One shape only: the spec allows no persisted-state
 * compatibility layer, and the bare integer a previous release wrote decoded to a
 * claim with no start time — which `liveOwner` treats as alive and `stopDriver`
 * refuses to signal, so such a Run could be neither stopped nor resumed, for ever.
 */
const OwnerRecordJson = Schema.fromJsonString(
  Schema.Struct({ pid: Schema.Int, start: Schema.NullOr(Schema.String), at: Schema.String }),
);

const JsonString = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(JsonString);

/**
 * A command for the Run's owning Driver. The Driver reads the inbox, so the shape
 * lives here with it and every writer imports it; two definitions of one persisted
 * boundary is exactly what run.json stopped having.
 */
const InboxCommand = Schema.Struct({
  type: Schema.Literals(["answer", "stop", "resume"]),
  requestId: Schema.String,
  choiceId: Schema.optionalKey(Schema.String),
  answer: Schema.optionalKey(Schema.String),
});
export const InboxCommandJson = Schema.fromJsonString(InboxCommand);
export interface InboxCommandValue extends Schema.Schema.Type<typeof InboxCommand> {}

function read<S extends Schema.Top>(schema: S, file: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(file).pipe(Effect.catch(() => Effect.succeed(false))))) return null;
    return yield* fs.readFileString(file).pipe(
      Effect.flatMap((raw) => Schema.decodeUnknownEffect(schema)(raw)),
      Effect.catch(() => Effect.succeed(null)),
    );
  });
}

export const appendProgress = Effect.fn("appendProgress")(function* (dir: string, text: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(dir, { recursive: true });
  const at = yield* nowIso();
  yield* fs.writeFileString(path.join(dir, PROGRESS), `${encodeJson({ at, text })}\n`, {
    flag: "a",
  });
  yield* fs.writeFileString(path.join(dir, RUNNER_LOG), `${at} ${text}\n`, { flag: "a" });
});

export const readProgress = Effect.fn("readProgress")(function* (dir: string, limit = 0) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(dir, PROGRESS);
  if (!(yield* fs.exists(file))) return [];
  const lines: ProgressLine[] = [];
  for (const raw of (yield* fs.readFileString(file)).split("\n")) {
    if (!raw.trim()) continue;
    try {
      const line = Schema.decodeUnknownOption(ProgressLineJson)(raw);
      if (Option.isSome(line)) lines.push(line.value);
    } catch {
      /* torn line */
    }
  }
  return limit > 0 ? lines.slice(-limit) : lines;
});
export const lastProgress = Effect.fn("lastProgress")(function* (dir: string) {
  return (yield* readProgress(dir, 1))[0]?.text ?? null;
});
export const writeChoice = Effect.fn("writeChoice")(function* (dir: string, choice: PendingChoice) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(path.join(dir, CHOICE), `${encodeJson(choice)}\n`);
});
export const readChoice = Effect.fn("readChoice")(function* (dir: string) {
  const path = yield* Path.Path;
  return yield* read(PendingChoiceJson, path.join(dir, CHOICE));
});
export const answerChoice = Effect.fn("answerChoice")(function* (
  dir: string,
  answer: ChoiceAnswer,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(path.join(dir, CHOICE_ANSWER), `${encodeJson(answer)}\n`);
});
export const clearChoice = Effect.fn("clearChoice")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const name of [CHOICE, CHOICE_ANSWER])
    yield* fs.remove(path.join(dir, name), { force: true });
});

const consumeInboxAnswer = Effect.fn("consumeInboxAnswer")(function* (
  dir: string,
  choice: PendingChoice,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const file of yield* inboxFiles(dir)) {
    const command = yield* read(InboxCommandJson, file);
    if (command?.type !== "answer" || command.choiceId !== choice.id || !isString(command.answer))
      continue;
    // Checked against the Choice it is about to satisfy, not just its id: an empty
    // answer dismisses a menu, and anything else has to be one of its own options.
    if (
      choice.kind === "menu" &&
      command.answer !== "" &&
      !choice.items.some((item) => item.id === command.answer)
    )
      continue;
    yield* fs.remove(file, { force: true });
    return choice.kind === "ask"
      ? { id: choice.id, text: command.answer }
      : { id: choice.id, choice: command.answer };
  }
  return null;
});

/**
 * Every command in the Run's inbox, oldest name first, or none at all. The inbox's
 * layout — one directory, one JSON file per request — is named here and by the writer,
 * and nowhere else.
 */
export const inboxFiles = Effect.fn("inboxFiles")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inbox = path.join(dir, "inbox");
  if (!(yield* fs.exists(inbox))) return [];
  const names = yield* fs
    .readDirectory(inbox)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(error),
      ),
    );
  return names
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(inbox, name));
});

/**
 * Everything the previous Driver left behind. A command is removed only by the
 * consumer that matches it, and the SIGTERM path consumes nothing, so a stop written
 * while a Driver was mid-Step outlived it — and the next Driver's first Choice found
 * that stop and killed itself, which made any Workflow that asks a question
 * unresumable. A pending Choice is stale for the same reason: the question belonged to
 * a process that is gone. A Driver therefore starts from an empty inbox, and only
 * commands written during its own life reach it.
 */
export const clearPreviousDriver = Effect.fn("clearPreviousDriver")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* clearChoice(dir);
  let resumedBy: string | null = null;
  for (const file of yield* inboxFiles(dir)) {
    // A `resume` command is addressed to this Driver, not the last one: it is the
    // record of the request that started it, so it is read before it is cleared.
    const command = yield* read(InboxCommandJson, file);
    if (command?.type === "resume") resumedBy = command.requestId;
    yield* fs.remove(file, { force: true });
  }
  return resumedBy;
});

/** Whether a stop already took effect on this Run before anyone came to drive it. */
export const stoppedBefore = Effect.fn("stoppedBefore")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.exists(path.join(dir, STOPPED));
});

/**
 * A stop request handed over through the inbox, consumed so it is acted on once. The
 * spec makes the inbox how another process gives the owning Driver a command; this is
 * the Driver's side of that for a stop, and it reads the inbox only while waiting on
 * a Choice — a Driver mid-Step is waiting on an agent and reads nothing, which is why
 * `collie run stop` signals as well.
 */
const consumeInboxStop = Effect.fn("consumeInboxStop")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  for (const file of yield* inboxFiles(dir)) {
    const command = yield* read(InboxCommandJson, file);
    if (command?.type !== "stop") continue;
    yield* fs.remove(file, { force: true });
    return true;
  }
  return false;
});

const readOwner = Effect.fn("readOwner")(function* (dir: string) {
  const path = yield* Path.Path;
  const raw = yield* read(OwnerRecordJson, path.join(dir, RUNNER_PID));
  return raw && raw.pid > 0 ? raw : null;
});

const liveOwner = Effect.fn("liveOwner")(function* (dir: string) {
  const owner = yield* readOwner(dir);
  if (!owner || !(yield* signalProcess(owner.pid))) return null;
  if (owner.start !== null) {
    const start = yield* processStartTime(owner.pid);
    if (start === null || start !== owner.start) return null;
  }
  return owner;
});

export const acquireDriver = Effect.fn("acquireDriver")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(dir, { recursive: true });
  const file = path.join(dir, RUNNER_PID);
  const me = yield* currentPid;
  const claim: OwnerRecord = { pid: me, start: yield* processStartTime(me), at: yield* nowIso() };
  for (let attempt = 0; attempt < 2; attempt++) {
    const won = yield* fs.writeFileString(file, `${encodeJson(claim)}\n`, { flag: "wx" }).pipe(
      Effect.as(true),
      Effect.catchTag("PlatformError", (e) =>
        e.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(e),
      ),
    );
    if (won) return true;
    if (!(yield* takeOverStale(dir, file))) return false;
  }
  return false;
});

const takeOverStale = Effect.fn("takeOverStale")(function* (dir: string, file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (yield* liveOwner(dir)) return false;
  const lock = `${file}.takeover`;
  return yield* withLock(
    lock,
    Effect.succeed(false),
    Effect.gen(function* () {
      if ((yield* liveOwner(dir)) || (yield* midWriteClaim(dir, file)) || !(yield* holdsLock(lock)))
        return false;
      yield* fs.remove(file, { force: true });
      return true;
    }),
  );
});

const midWriteClaim = Effect.fn("midWriteClaim")(function* (dir: string, file: string) {
  if ((yield* readOwner(dir)) !== null) return false;
  return yield* lockWriteIsFresh(file).pipe(Effect.catch(() => Effect.succeed(false)));
});

export const releaseDriver = Effect.fn("releaseDriver")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const owner = yield* readOwner(dir);
  if (owner && owner.pid === (yield* currentPid))
    yield* fs.remove(path.join(dir, RUNNER_PID), { force: true });
});
export const driverPid = Effect.fn("driverPid")(function* (dir: string) {
  return (yield* liveOwner(dir))?.pid ?? null;
});
export const driverAlive = Effect.fn("driverAlive")(function* (dir: string) {
  return (yield* driverPid(dir)) !== null;
});
export const stopDriver = Effect.fn("stopDriver")(function* (dir: string) {
  const owner = yield* liveOwner(dir);
  return !!owner && owner.start !== null && (yield* signalProcess(owner.pid, "SIGTERM"));
});

export function filePrompts(opts: {
  dir: string;
  run: string;
  step: () => string;
  timeoutMs: number;
  pollMs?: number;
  /** Optional synchronization hook after both watch streams have been acquired. */
  onWatching?: Effect.Effect<void>;
}): EnginePrompts {
  let seq = 0;
  // Unique per Driver, not only per Choice within one: `${run}-1` from a resumed Run
  // would otherwise repeat an id its previous Driver had already used. Taken once,
  // lazily, because filePrompts is a plain constructor and Crypto is a service.
  let epoch: string | null = null;
  const epochOnce = Effect.gen(function* () {
    if (epoch === null) epoch = (yield* (yield* Crypto.Crypto).randomUUIDv4).slice(0, 8);
    return epoch;
  });
  const wait = (asked: Omit<PendingChoice, "id">) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const choice: PendingChoice = { ...asked, id: `${opts.run}-${yield* epochOnce}-${++seq}` };
      yield* clearChoice(opts.dir);
      const inbox = path.join(opts.dir, "inbox");
      yield* fs.makeDirectory(inbox, { recursive: true });

      /** This Choice's answer, or nothing yet. A stop found here is acted on. */
      const check = Effect.gen(function* () {
        const answer =
          (yield* consumeInboxAnswer(opts.dir, choice)) ??
          (yield* read(ChoiceAnswerJson, path.join(opts.dir, CHOICE_ANSWER)));
        if (answer && answer.id === choice.id) return answer;
        // The same request the signal carries, arriving as a file. Raising it on
        // ourselves keeps one path recording what a stop does to the Run.
        if (yield* consumeInboxStop(opts.dir)) yield* signalProcess(yield* currentPid, "SIGTERM");
        return null;
      });

      /**
       * What might mean something has changed. `FileSystem.watch` is not recursive —
       * a write into `inbox/` raises nothing on a watch of the Run directory — so both
       * are watched: the inbox for commands, the Run dir for `choice-answer.json`.
       *
       * The tick rides alongside them rather than driving the wait. Events are only
       * invalidation signals, and one that never arrives — a watch the platform drops,
       * a file written before the subscription settled — should cost latency, not the
       * answer.
       */
      const watch = (directory: string) =>
        fs.watch(directory).pipe(Stream.catchCause(() => Stream.empty));

      const answered = yield* Effect.gen(function* () {
        const runEvents = yield* Stream.toQueue(watch(opts.dir), { capacity: "unbounded" });
        const inboxEvents = yield* Stream.toQueue(watch(inbox), { capacity: "unbounded" });
        if (opts.onWatching) {
          const probe = Effect.fn("filePrompts.probeWatch")(function* (
            directory: string,
            events: typeof runEvents,
          ) {
            // Queue acquisition does not guarantee that the platform watcher has
            // finished subscribing. Keep changing a harmless marker until the real
            // watch queue answers, synchronized by Fiber/Queue rather than a sleep.
            const marker = path.join(directory, ".watch-ready");
            const writer = yield* fs
              .writeFileString(marker, ".", { flag: "a" })
              .pipe(Effect.andThen(Effect.yieldNow), Effect.forever, Effect.forkScoped);
            yield* Queue.take(events).pipe(
              Effect.mapError(() => new Error(`watch ended before subscribing to ${directory}`)),
            );
            yield* Fiber.interrupt(writer);
            yield* fs.remove(marker, { force: true });
          });
          yield* probe(opts.dir, runEvents);
          yield* probe(inbox, inboxEvents);
          yield* opts.onWatching;
        }
        const queued = (events: typeof runEvents) =>
          Stream.fromQueue(events).pipe(Stream.catchCause(() => Stream.empty));
        const events = Stream.merge(
          Stream.merge(queued(runEvents), queued(inboxEvents)),
          Stream.tick(`${opts.pollMs ?? 500} millis`),
        );
        const queue = yield* Stream.toQueue(events, { capacity: "unbounded" });
        // Subscribed before the first read, so an answer written in the gap between
        // them still arrives as an event rather than being waited on for ever.
        yield* writeChoice(opts.dir, choice);
        const already = yield* check;
        if (already) return Option.some(already);
        return yield* Stream.fromQueue(queue).pipe(
          Stream.mapEffect(() => check),
          Stream.filter((found): found is ChoiceAnswer => found !== null),
          Stream.runHead,
        );
      }).pipe(
        Effect.scoped,
        Effect.timeout(opts.timeoutMs),
        // Running out of time is this function answering nothing, not a failure.
        Effect.catchTag("TimeoutError", () => Effect.succeed(Option.none<ChoiceAnswer>())),
        Effect.ensuring(clearChoice(opts.dir).pipe(Effect.ignore)),
      );
      return Option.getOrNull(answered);
    });
  return {
    menu: (items, menuOpts) =>
      wait({
        kind: "menu",
        run: opts.run,
        step: opts.step(),
        header: menuOpts.header,
        footer: menuOpts.footer ?? "",
        items,
      }).pipe(
        Effect.map((answer) =>
          answer?.choice ? (items.find((i) => i.id === answer.choice) ?? null) : null,
        ),
      ),
    ask: (question) =>
      wait({
        kind: "ask",
        run: opts.run,
        step: opts.step(),
        header: question,
        footer: "",
        items: [],
      }).pipe(Effect.map((answer) => answer?.text ?? null)),
  };
}
