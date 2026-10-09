// The Flock chat resumes one warm session on the harness named in Desktop's Settings.

import {
  Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  PubSub,
  Schema,
  Schedule,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import * as Base64 from "effect/encoding/Base64";
import { type AguiEvent, ends } from "../shared/agui";
import { saidOf } from "../shared/said";
import {
  IMAGE_BYTES,
  INLINE_BUDGET,
  listing,
  shownAs,
  type Staged,
  TEXTUAL,
  showable,
} from "../shared/attachments";
import { isString } from "../../../src/schema";
import { describeAttachment, scaledCopy } from "./attachments";
import {
  type About,
  aboutNote,
  type Answers,
  type ChatMessage,
  type Conversations,
  DESKTOP_SAID,
  type DesktopTurn,
} from "../shared/chat-view";
import { type AgentChoice, pinned, said as choiceSaid } from "../../../src/harness-choice";
import { appendJournal } from "../../../src/journal";
import { nowIso } from "../../../src/time";
import { type ChatDriver, type ContentBlock, type DriverContext, TurnCost } from "./driver";
import {
  delivered,
  type FlockBatch,
  type FlockChat,
  flockBatch,
  flockNewsText,
  heardNews,
  newsKey,
  worthSpeaking,
} from "./flock-tools";

/** The current conversation and the harness it is held on; a file without one is claude's. */
const SessionFile = Schema.fromJsonString(
  Schema.Struct({
    session: Schema.String,
    harness: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("claude"))),
  }),
);

/** The Flock chat's harness and model, as Settings has them. */
export interface ChatHarnessSet {
  readonly harness: string;
  readonly model: string | undefined;
}

export interface FlockConversation {
  /**
   * One message from the human, about a card or none, and the events of the turn it starts:
   * after the turn under way, or `now`, interrupting it.
   */
  readonly send: (
    text: string,
    about: About | null,
    now: boolean,
    /** Desktop's copies the message carries, by id. */
    attachments?: ReadonlyArray<string>,
  ) => Stream.Stream<AguiEvent>;
  /** Answers the question the chat asked in that tool call, if it is still asking. */
  readonly answer: (toolCallId: string, answers: Answers) => Effect.Effect<void>;
  readonly transcript: Effect.Effect<ReadonlyArray<ChatMessage>>;
  readonly conversations: Effect.Effect<Conversations>;
  /** Ends the current session and makes that one current, or a fresh one. */
  readonly reopen: (session: string | null) => Effect.Effect<void>;
  /** Something changed on a board: News may be waiting, worth a turn of Desktop's own. */
  readonly nudge: Effect.Effect<void>;
  /** When a turn of Desktop's own starts and ends. */
  readonly desktopTurns: Stream.Stream<DesktopTurn>;
  readonly changed: Stream.Stream<string>;
  readonly refresh: Effect.Effect<void>;
}

/** A turn of Desktop's own, recorded as usage on this computer: data, never a limit. */
const UsageLine = Schema.fromJsonString(
  Schema.Struct({
    at: Schema.String,
    session: Schema.String,
    turn: Schema.Literal("desktop"),
    harness: Schema.String,
    model: Schema.String,
    ...TurnCost.fields,
  }),
);

/** Who a turn speaks for: the human's words and card, and the News it carries. */
interface Voice {
  said?: string;
  /** Desktop's copies of the files the human's message carried. */
  files?: ReadonlyArray<Staged>;
  news?: FlockBatch;
}

/** How long after a board change Desktop looks for News, so the host has written it. */
const SETTLE = "3 seconds";

/** How often Desktop looks for News no board change pointed to. */
const LOOK_AGAIN = "2 minutes";

/** How many earlier conversations the history offers. */
const HISTORY = 10;

export const refusal = (message: string): AguiEvent => ({ type: "RUN_ERROR", runId: "", message });

/** The largest PDF handed over as a document, and text as text; anything larger goes by name. */
const PDF_BYTES = 4 * 1024 * 1024;
const TEXT_BYTES = 100 * 1024;
const strictly = new TextDecoder("utf-8", { fatal: true });
/** The file as text, or null where it is not UTF-8 or holds a NUL. */
const utf8 = (bytes: Uint8Array) => {
  if (bytes.includes(0)) return null;
  try {
    return strictly.decode(bytes);
  } catch {
    return null;
  }
};

/**
 * The human's message as the model is handed it: their words, Desktop's notes of the card
 * it is about and of the files apart from them, and what of each file fits as an image,
 * document or text. Why not, where a file is gone.
 */
const contentOf = Effect.fnUntraced(function* (
  dir: string,
  text: string,
  about: About | null,
  ids: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const files: Staged[] = [];
  for (const id of ids) {
    const held = yield* describeAttachment(dir, id).pipe(Effect.orElseSucceed(() => null));
    if (held === null) return `Desktop no longer has ${id.split("/").at(-1)}; attach it again.`;
    files.push(held);
  }
  const images: ContentBlock[] = [];
  const documents: ContentBlock[] = [];
  const texts: ContentBlock[] = [];
  let budget = INLINE_BUDGET;
  // What does not fit goes by its listed path alone.
  const fits = (data: string) => {
    if (data.length > budget) return false;
    budget -= data.length;
    return true;
  };
  for (const file of files) {
    const media = shownAs(file.mediaType);
    const read = (path: string) =>
      fs.readFile(path).pipe(Effect.orElseSucceed(() => new Uint8Array()));
    if (media !== undefined) {
      const scaled = yield* scaledCopy(dir, file.id).pipe(Effect.orElseSucceed(() => null));
      const bytes = yield* read(scaled ?? file.path);
      const data = bytes.length <= IMAGE_BYTES && showable(bytes) ? Base64.encode(bytes) : null;
      if (data !== null && fits(data))
        images.push({ type: "image", source: { type: "base64", media_type: media, data } });
    } else if (file.mediaType === "application/pdf" && file.size <= PDF_BYTES) {
      const data = Base64.encode(yield* read(file.path));
      if (fits(data))
        documents.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data },
          title: file.name,
        });
    } else if (file.size <= TEXT_BYTES && TEXTUAL.test(file.mediaType)) {
      const text = utf8(yield* read(file.path));
      if (text !== null && fits(text))
        texts.push({ type: "text", text: `${file.name}:\n\n${text}` });
    }
  }
  const blocks: Array<ContentBlock> = [
    ...(text === "" ? [] : [{ type: "text" as const, text }]),
    ...(about === null ? [] : [{ type: "text" as const, text: aboutNote(about) }]),
    ...(files.length === 0 ? [] : [{ type: "text" as const, text: listing(files) }]),
    ...images,
    ...documents,
    ...texts,
  ];
  return { blocks, files };
});

/** `start` kept once it succeeds, and tried again on the next ask until it does. */
export const untilStarted = <A, E, R>(start: Effect.Effect<A, E, R>) =>
  Effect.cachedWithTTL(start, (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero));

/**
 * The current conversation's session, started by its first message and warm from then
 * until the scope closes, and never more than one. A message after the chat's model changed
 * ends the warm session and resumes the same conversation on the new model.
 */
export const openFlockChat = Effect.fn("FlockChat.open")(function* (opts: {
  readonly drivers: (
    context: DriverContext,
  ) =>
    | Readonly<Record<string, ChatDriver>>
    | Effect.Effect<
        Readonly<Record<string, ChatDriver>>,
        never,
        Scope.Scope | Crypto.Crypto | FileSystem.FileSystem
      >;
  readonly dir: string;
  readonly conversation: string;
  readonly machines: FlockChat["machines"];
  /** Whether Desktop may start a turn about News nobody asked for. */
  readonly proactive: () => boolean;
  readonly machineRule: FlockChat["machineRule"];
  readonly setMachineRule: FlockChat["setMachineRule"];
  readonly inSync: FlockChat["inSync"];
  /** What the chat runs on, as Settings have it now, or why it cannot run. */
  readonly choice: () =>
    | { readonly ok: true; readonly choice: AgentChoice }
    | { readonly ok: false; readonly problem: string };
  readonly chatHarness: () => ChatHarnessSet;
  readonly setChatHarness: FlockChat["setChatHarness"];
}) {
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  const crypto = yield* Crypto.Crypto;
  yield* fs.makeDirectory(opts.dir, { recursive: true });
  const file = (yield* Path.Path).join(opts.dir, "flock-chat.json");
  const saved = yield* fs
    .readFileString(file)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(SessionFile)), Effect.option);
  let said: string | undefined;
  let carried: ReadonlyArray<Staged> | undefined;
  let noticed: FlockBatch | undefined;
  const asking = new Map<string, Deferred.Deferred<Answers>>();
  const questions = new Set<string>();
  const clicked = new Map<string, Answers>();
  const services = yield* Effect.context<Crypto.Crypto | FileSystem.FileSystem | Path.Path>();
  const run = <A>(effect: Effect.Effect<A, never, Crypto.Crypto | FileSystem.FileSystem>) =>
    Effect.runPromise(effect.pipe(Effect.provideContext(services)));
  /** The session warm now, if one is. */
  let live:
    | { readonly running: Live; readonly scope: Scope.Closeable; readonly choice: AgentChoice }
    | undefined;
  const flock: FlockChat = {
    machines: opts.machines,
    conversation: opts.conversation,
    said: () => said,
    attachments: () => carried,
    uploaded: new Map(),
    machineRule: opts.machineRule,
    setMachineRule: opts.setMachineRule,
    inSync: opts.inSync,
    chatHarness: () => ({
      ...opts.chatHarness(),
      runsOn: live === undefined ? null : choiceSaid(pinned(live.choice)),
    }),
    setChatHarness: opts.setChatHarness,
  };
  const usage = (yield* Path.Path).join(opts.dir, "flock-usage.jsonl");
  const desktopTurns = yield* SubscriptionRef.make<DesktopTurn>("ended");
  // ponytail: grows by one key per item Desktop spoke about, for as long as Desktop runs.
  /** News a turn of Desktop's has been about, so an item a host failed to settle never wakes it twice. */
  const spoken = new Set<string>();
  let resting = false;
  const ask = (toolUseID: string, signal: AbortSignal) => {
    // A turn of Desktop's own has nobody to click an answer.
    if (said === undefined) return Promise.resolve(null);
    const early = clicked.get(toolUseID);
    if (early !== undefined) {
      clicked.delete(toolUseID);
      return Promise.resolve(early);
    }
    const answered = Deferred.makeUnsafe<Answers>();
    asking.set(toolUseID, answered);
    return Effect.runPromise(
      Deferred.await(answered).pipe(Effect.ensuring(Effect.sync(() => asking.delete(toolUseID)))),
      { signal },
    );
  };
  const provided = opts.drivers({
    dir: opts.dir,
    flock,
    run,
    ask,
    noticed: () => (noticed === undefined ? undefined : flockNewsText(noticed)),
    placement: () => {
      const rule = opts.machineRule()?.trim() ?? "";
      return rule === ""
        ? undefined
        : {
            rule,
            machines: opts.machines().map(({ name, local }) => ({ name, local: local === true })),
          };
    },
  });

  const drivers = Effect.isEffect(provided) ? yield* provided : provided;

  /** One session, live until its scope closes. */
  const start = Effect.fnUntraced(function* (driver: ChatDriver, id: string, choice: AgentChoice) {
    const session = yield* driver.open(id, pinned(choice).model, choice.effort ?? "");
    const events = yield* PubSub.unbounded<AguiEvent>();
    /** Why the session ended, once it has: every turn after it is told at once. */
    let ended: string | null = null;
    const endWith = (why: string) =>
      Effect.suspend(() => {
        ended = why;
        return PubSub.publish(events, refusal(why));
      });
    yield* session.events.pipe(
      Stream.runForEach((event) => PubSub.publish(events, event)),
      Effect.matchCauseEffect({
        onSuccess: () => endWith(`${choice.harness} ended the Flock chat's session.`),
        onFailure: (cause) => endWith(saidOf(cause)),
      }),
      Effect.forkScoped,
    );
    // Added after the reader, so it runs first and the reader's pending message ends.
    yield* Effect.addFinalizer(() => session.close);
    return { session, events, ended: () => ended };
  });

  type Live = Effect.Success<ReturnType<typeof start>>;
  let id = Option.isSome(saved) ? saved.value.session : yield* crypto.randomUUIDv4;
  let heldOn = Option.isSome(saved) ? saved.value.harness : opts.chatHarness().harness;
  const changed = yield* SubscriptionRef.make(id);
  const remember = Effect.suspend(() =>
    fs
      .writeFileString(file, Schema.encodeSync(SessionFile)({ session: id, harness: heldOn }))
      .pipe(Effect.andThen(SubscriptionRef.set(changed, id))),
  );
  if (Option.isNone(saved)) yield* remember;
  /**
   * The session on what Settings name now, started again where the last one ended, as one
   * that failed to start has; or why there is none.
   */
  const warm = Effect.gen(function* () {
    const resolved = opts.choice();
    if (!resolved.ok) return resolved.problem;
    const { choice } = resolved;
    const driver = drivers[choice.harness];
    if (driver === undefined) return `The Flock chat has no driver for ${choice.harness}.`;
    if (!driver.installed)
      return `${choice.harness} is not installed or not on PATH on this computer`;
    if (
      live !== undefined &&
      live.running.ended() === null &&
      choiceSaid(live.choice) === choiceSaid(choice)
    )
      return live.running;
    yield* switchHarness;
    yield* end;
    const scope = yield* Scope.make();
    live = { running: yield* start(driver, id, choice).pipe(Scope.provide(scope)), scope, choice };
    return live.running;
  });
  const end: Effect.Effect<void> = Effect.suspend(() => {
    const ending = live;
    live = undefined;
    return ending === undefined ? Effect.void : Scope.close(ending.scope, Exit.void);
  });
  yield* Effect.addFinalizer(() => end);

  const turns = yield* Semaphore.make(1);
  const switchHarness = Effect.gen(function* () {
    const harness = opts.chatHarness().harness;
    if (harness === heldOn) return;
    yield* end;
    id = yield* crypto.randomUUIDv4;
    heldOn = harness;
    yield* remember;
  }).pipe(Effect.orDie);
  const refresh = turns.withPermits(1)(switchHarness).pipe(Effect.orDie);

  /** The session a turn is under way on, if one is. */
  let turning: Live | undefined;
  // A throttle: the first board change in a while has Desktop look for News once things settle.
  let nudged = false;
  const nudge: Effect.Effect<void> = Effect.suspend(() => {
    if (nudged) return Effect.void;
    nudged = true;
    return Effect.sleep(SETTLE).pipe(
      Effect.andThen(
        Effect.sync(() => {
          nudged = false;
        }),
      ),
      Effect.andThen(speakFirst),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  });

  /**
   * A message on the session and the events of the turn it starts, in the words of whoever
   * said it, with the News it carries settled once the model has it. A turn its reader
   * dropped is interrupted and seen out, so the next starts clean; any turn's end may leave
   * News that waited for it.
   */
  const turnOn = Effect.fnUntraced(function* (
    running: Live,
    content: string | Array<ContentBlock>,
    voice: Voice,
  ) {
    const heard = yield* PubSub.subscribe(running.events);
    let finished = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        said = undefined;
        carried = undefined;
        noticed = undefined;
        turning = undefined;
        questions.clear();
        clicked.clear();
      }).pipe(
        Effect.andThen(
          finished
            ? Effect.void
            : running.session.interrupt.pipe(
                Effect.andThen(
                  Stream.fromSubscription(heard).pipe(Stream.takeUntil(ends), Stream.runDrain),
                ),
                Effect.timeout("10 seconds"),
                Effect.ignore,
              ),
        ),
        Effect.andThen(nudge),
      ),
    );
    said = voice.said;
    carried = voice.files;
    // A turn of Desktop's carries its News in its message; the human's carries it as context.
    noticed = voice.said === undefined ? undefined : voice.news;
    turning = running;
    yield* running.session.offer(content);
    let news = voice.news;
    return Stream.fromSubscription(heard).pipe(
      Stream.takeUntil(ends),
      Stream.tap((event) =>
        Effect.suspend(() => {
          if (event.type === "TOOL_CALL_START" && event.toolCallName === "AskUserQuestion")
            questions.add(event.toolCallId);
          if (ends(event)) finished = true;
          // The model saying anything is what shows it has the message, and its News.
          if (news === undefined || event.type === "RUN_STARTED" || ends(event)) return Effect.void;
          const settled = news;
          news = undefined;
          for (const placed of settled.items) spoken.add(newsKey(placed));
          // In this turn's voice, which has ended by the time a quick reply's settling runs.
          return delivered(
            { ...flock, said: () => voice.said, attachments: () => voice.files },
            settled,
          ).pipe(Effect.provideContext(services), Effect.forkIn(scope), Effect.asVoid);
        }),
      ),
    );
  });

  const waiting = heardNews(flock).pipe(
    Effect.map(({ batch }) => batch),
    Effect.provideContext(services),
    Effect.orElseSucceed(() => flockBatch([])),
  );

  /** A turn of Desktop's own about News that matters, when the chat is idle and may speak first. */
  const speakFirst: Effect.Effect<void> = Effect.gen(function* () {
    if (!opts.proactive() || resting) return;
    const fresh = worthSpeaking(yield* waiting, spoken);
    if (fresh === null) return;
    const running = yield* warm;
    if (isString(running) || running.ended() !== null) return;
    const before = running.session.lastTurn();
    const choice = pinned(live!.choice);
    yield* SubscriptionRef.set(desktopTurns, "started");
    yield* turnOn(running, `${DESKTOP_SAID}\n${flockNewsText(fresh)}`, { news: fresh }).pipe(
      Effect.flatMap(Stream.runDrain),
      Effect.scoped,
      Effect.ensuring(SubscriptionRef.set(desktopTurns, "ended")),
    );
    // A turn that failed before the model had its News waits for the next look, not the next nudge.
    resting = fresh.items.every((placed) => !spoken.has(newsKey(placed)));
    const result = running.session.lastTurn();
    if (result !== undefined && result !== before)
      yield* appendJournal(usage, UsageLine, {
        at: yield* nowIso(),
        session: id,
        turn: "desktop",
        harness: choice.harness,
        model: choice.model,
        duration_ms: result.duration_ms,
        usage: result.usage,
      });
  }).pipe(turns.withPermitsIfAvailable(1), Effect.provideContext(services), Effect.ignore);

  // ponytail: a fixed look-again for News written after its board change settled; a host push would replace it.
  yield* Effect.sync(() => {
    resting = false;
  }).pipe(Effect.andThen(nudge), Effect.repeat(Schedule.spaced(LOOK_AGAIN)), Effect.forkIn(scope));

  const conversation: FlockConversation = {
    send: (text, about, now, attachments = []) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const content = yield* contentOf(opts.dir, text, about, attachments).pipe(
            Effect.provideContext(services),
          );
          if (isString(content)) return Stream.make(refusal(content));
          if (now && turning !== undefined) yield* turning.session.interrupt;
          yield* Effect.acquireRelease(turns.take(1), () => turns.release(1));
          const running = yield* warm;
          if (isString(running)) return Stream.make(refusal(running));
          const ended = running.ended();
          if (ended !== null) return Stream.make(refusal(ended));
          const news = yield* waiting;
          const voice: Voice = { said: text };
          if (content.files.length > 0) voice.files = content.files;
          if (news.items.length > 0) voice.news = news;
          return yield* turnOn(
            running,
            attachments.length > 0 || about !== null ? content.blocks : text,
            voice,
          );
        }),
      ),
    answer: (toolCallId, answers) =>
      Effect.suspend(() => {
        const answered = asking.get(toolCallId);
        if (answered !== undefined) return Deferred.succeed(answered, answers);
        if (questions.has(toolCallId)) clicked.set(toolCallId, answers);
        return Effect.void;
      }),
    transcript: Effect.suspend(() => drivers[heldOn]?.transcript(id) ?? Effect.succeed([])),
    conversations: Effect.suspend(() =>
      (drivers[heldOn]?.earlier(HISTORY + 1) ?? Effect.succeed([])).pipe(
        Effect.map((sessions) => ({
          current: id,
          earlier: sessions.filter(({ session }) => session !== id).slice(0, HISTORY),
        })),
      ),
    ),
    // A turn under way is interrupted, and the session it ran on ends before the next starts.
    reopen: (session) =>
      Effect.gen(function* () {
        if (turning !== undefined) yield* turning.session.interrupt;
        yield* turns.withPermits(1)(
          Effect.gen(function* () {
            yield* end;
            id = session ?? (yield* crypto.randomUUIDv4);
            heldOn = opts.chatHarness().harness;
            yield* remember;
          }),
        );
      }).pipe(Effect.orDie),
    nudge,
    desktopTurns: SubscriptionRef.changes(desktopTurns),
    changed: SubscriptionRef.changes(changed),
    refresh,
  };
  yield* refresh;
  return conversation;
});
