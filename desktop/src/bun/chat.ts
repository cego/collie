import * as Str from "effect/String";
import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import {
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
  flow,
  Result,
} from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
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
  harnessName,
  type HeldConversation,
} from "../shared/chat-view";
import type { ChatChoices, Offer, Resolved } from "../shared/chat-choices";
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
import { actionsLog } from "./sent";

const SessionFile = Schema.fromJsonString(
  Schema.Struct({
    session: Schema.String,
    harness: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("claude"))),
  }),
);

export interface ChatHarnessSet {
  readonly harness: string;
  readonly model: string | undefined;
  readonly effort: string | undefined;
}

export interface FlockConversation {
  readonly send: (
    text: string,
    about: About | null,
    now: boolean,
    attachments?: ReadonlyArray<string>,
  ) => Stream.Stream<AguiEvent>;
  readonly answer: (toolCallId: string, answers: Answers) => Effect.Effect<void>;
  readonly transcript: Effect.Effect<ReadonlyArray<ChatMessage>>;
  readonly conversations: Effect.Effect<Conversations>;
  readonly reopen: (conversation: HeldConversation | null) => Effect.Effect<string | null>;
  readonly nudge: Effect.Effect<void>;
  readonly desktopTurns: Stream.Stream<DesktopTurn>;
  readonly changed: Stream.Stream<string>;
  readonly choices: Stream.Stream<ChatChoices>;
}

type Held = Pick<ChatChoices, "heldOn" | "runsOn" | "turning">;

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

interface Voice {
  said?: string;
  files?: ReadonlyArray<Staged>;
  news?: FlockBatch;
}

// WARNING: News is written after a board change, so look only once it has settled.
const SETTLE = "3 seconds";

const LOOK_AGAIN = "2 minutes";

const HISTORY = 10;

export const refusal: (message: string) => AguiEvent = (message) => ({
  type: "RUN_ERROR",
  runId: "",
  message,
});

const PDF_BYTES = 4 * 1024 * 1024;
const TEXT_BYTES = 100 * 1024;
const strictly = new TextDecoder("utf-8", { fatal: true });
const utf8 = (bytes: Uint8Array) => {
  if (bytes.includes(0)) return null;
  try {
    return strictly.decode(bytes);
  } catch {
    return null;
  }
};

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
    if (held === null)
      return `Desktop no longer has ${Str.split(id, "/").at(-1)}; attach it again.`;
    files.push(held);
  }
  const images: ContentBlock[] = [];
  const documents: ContentBlock[] = [];
  const texts: ContentBlock[] = [];
  let budget = INLINE_BUDGET;
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

export const untilStarted = <A, E, R>(start: Effect.Effect<A, E, R>) =>
  Effect.cachedWithTTL(start, (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero));

export const openFlockChat = Effect.fn("FlockChat.open")(function* (opts: {
  readonly drivers: (
    context: DriverContext,
  ) =>
    | Readonly<Record<string, ChatDriver>>
    | Effect.Effect<
        Readonly<Record<string, ChatDriver>>,
        never,
        Scope.Scope | SecureRandom.SecureRandom | FileSystem.FileSystem
      >;
  readonly dir: string;
  readonly conversation: string;
  readonly machines: FlockChat["machines"];
  readonly proactive: () => boolean;
  readonly machineRule: FlockChat["machineRule"];
  readonly setMachineRule: FlockChat["setMachineRule"];
  readonly standingDirection: FlockChat["standingDirection"];
  readonly setStandingDirection: FlockChat["setStandingDirection"];
  readonly inSync: FlockChat["inSync"];
  readonly searchArtefacts?: FlockChat["searchArtefacts"];
  readonly helle?: FlockChat["helle"];
  readonly choice: () => Effect.Effect<
    | { readonly ok: true; readonly choice: Resolved }
    | { readonly ok: false; readonly problem: string },
    never,
    FileSystem.FileSystem | Path.Path
  >;
  readonly offered: (
    harness: string,
  ) => Effect.Effect<
    Offer | { readonly from: "reading" },
    never,
    FileSystem.FileSystem | Path.Path
  >;
  readonly retold: Stream.Stream<unknown>;
  readonly readModels?: (harness: string) => Effect.Effect<void>;
  readonly modelsChanged?: Stream.Stream<unknown>;
  readonly chatHarness: () => ChatHarnessSet;
  readonly setChatHarness: FlockChat["setChatHarness"];
}) {
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  const random = yield* SecureRandom.SecureRandom;
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
  const services = yield* Effect.context<
    SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path
  >();
  const run = Effect.runPromiseWith(services);
  let live:
    | { readonly running: Live; readonly scope: Scope.Closeable; readonly choice: Resolved }
    | undefined;
  let turning: Live | undefined;
  const flock: FlockChat = {
    machines: opts.machines,
    conversation: opts.conversation,
    actionsLog: yield* actionsLog(opts.dir),
    said: () => said,
    attachments: () => carried,
    uploaded: new Map(),
    machineRule: opts.machineRule,
    setMachineRule: opts.setMachineRule,
    standingDirection: opts.standingDirection,
    setStandingDirection: opts.setStandingDirection,
    inSync: opts.inSync,
    searchArtefacts: opts.searchArtefacts,
    helle: opts.helle,
    chatHarness: opts.chatHarness,
    chatChoices: Effect.suspend(() =>
      Effect.forEach(
        Arr.filter(Rec.toEntries(drivers), ([, driver]) => driver.installed),
        ([harness]) => readModels(harness),
      ).pipe(Effect.andThen(Effect.suspend(() => accountOf(SubscriptionRef.getUnsafe(held))))),
    ),
    setChatHarness: opts.setChatHarness,
  };
  const usage = (yield* Path.Path).join(opts.dir, "flock-usage.jsonl");
  const desktopTurns = yield* SubscriptionRef.make<DesktopTurn>("ended");
  // WARNING: grows by one key per item spoken of, for as long as Desktop runs.
  const spoken = new Set<string>();
  let resting = false;
  const ask = (toolUseID: string, signal: AbortSignal) => {
    // WARNING: a Desktop turn has nobody to click an answer, so it gets none.
    if (said === undefined) return Promise.resolve(null);
    const early = clicked.get(toolUseID);
    if (early !== undefined) {
      clicked.delete(toolUseID);
      return Promise.resolve(early);
    }
    const answered = Deferred.makeUnsafe<Answers>();
    asking.set(toolUseID, answered);
    return run(
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
      const rule =
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(opts.machineRule()), (present) => Str.trim(present)),
        ) ?? "";
      return rule === ""
        ? undefined
        : {
            rule,
            machines: Arr.map(opts.machines(), ({ name, local }) => ({
              name,
              local: local === true,
            })),
          };
    },
  });

  const drivers = Effect.isEffect(provided) ? yield* provided : provided;
  const readModels = (harness: string) => opts.readModels?.(harness) ?? Effect.void;

  const start = Effect.fnUntraced(function* (driver: ChatDriver, id: string, choice: Resolved) {
    const session = yield* driver.open(id, choice.model, choice.effort);
    const events = yield* PubSub.unbounded<AguiEvent>();
    let ended: string | null = null;
    const endWith = (why: string) =>
      Effect.suspend(() => {
        ended = why;
        return tell.pipe(Effect.andThen(PubSub.publish(events, refusal(why))));
      });
    yield* session.events.pipe(
      Stream.runForEach((event) => PubSub.publish(events, event)),
      Effect.matchCauseEffect({
        onSuccess: () => endWith(`${choice.harness} ended the Flock chat's session.`),
        onFailure: (cause) => endWith(saidOf(cause)),
      }),
      Effect.forkScoped,
    );
    // WARNING: added after the reader, so it runs first and ends the reader's pending message.
    yield* Effect.addFinalizer(() => session.close);
    return { session, events, ended: () => ended };
  });

  type Live = Effect.Success<ReturnType<typeof start>>;
  let id = Option.isSome(saved) ? saved.value.session : yield* random.uuidV4();
  let heldOn = Option.isSome(saved) ? saved.value.harness : opts.chatHarness().harness;
  const changed = yield* SubscriptionRef.make(id);
  const held = yield* SubscriptionRef.make<Held>({ heldOn, runsOn: null, turning: false });
  const tell: Effect.Effect<void> = Effect.suspend(() =>
    SubscriptionRef.set(held, {
      heldOn,
      runsOn: live?.running.ended() === null ? live.choice : null,
      turning: turning !== undefined,
    }),
  );
  const remember = Effect.suspend(() =>
    fs
      .writeFileString(
        file,
        flow(Schema.encodeResult(SessionFile), Result.getOrThrow)({ session: id, harness: heldOn }),
      )
      .pipe(Effect.andThen(SubscriptionRef.set(changed, id)), Effect.andThen(tell)),
  );
  if (Option.isNone(saved)) yield* remember;
  const warm = Effect.gen(function* () {
    const resolved = yield* opts.choice().pipe(Effect.provideContext(services));
    if (!resolved.ok) return resolved.problem;
    const { choice } = resolved;
    const driver = drivers[choice.harness];
    if (driver === undefined) return `The Flock chat has no driver for ${choice.harness}.`;
    if (!driver.installed)
      return `${choice.harness} is not installed or not on PATH on this computer`;
    if (
      live !== undefined &&
      live.running.ended() === null &&
      live.choice.harness === choice.harness &&
      live.choice.model === choice.model &&
      live.choice.effort === choice.effort
    )
      return live.running;
    yield* switchHarness(choice.harness);
    yield* end;
    const scope = yield* Scope.make();
    live = { running: yield* start(driver, id, choice).pipe(Scope.provide(scope)), scope, choice };
    yield* tell;
    return live.running;
  });
  const end: Effect.Effect<void> = Effect.suspend(() => {
    const ending = live;
    live = undefined;
    return ending === undefined
      ? Effect.void
      : Scope.close(ending.scope, Exit.void).pipe(Effect.andThen(tell));
  });
  yield* Effect.addFinalizer(() => end);

  const turns = yield* Semaphore.make(1);
  const switchHarness = (harness: string) =>
    Effect.gen(function* () {
      if (harness === heldOn) return;
      yield* end;
      id = yield* random.uuidV4();
      heldOn = harness;
      yield* remember;
    }).pipe(Effect.orDie);

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

  // WARNING: a turn its reader dropped is interrupted and seen out, so the next starts clean.
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
        Effect.andThen(tell),
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
    noticed = voice.said === undefined ? undefined : voice.news;
    turning = running;
    yield* tell;
    yield* running.session.offer(content);
    let news = voice.news;
    return Stream.fromSubscription(heard).pipe(
      Stream.takeUntil(ends),
      Stream.tap((event) =>
        Effect.suspend(() => {
          if (event.type === "TOOL_CALL_START" && event.toolCallName === "AskUserQuestion")
            questions.add(event.toolCallId);
          if (ends(event)) finished = true;
          // WARNING: the model's first event shows it has the message and its News.
          if (news === undefined || event.type === "RUN_STARTED" || ends(event)) return Effect.void;
          const settled = news;
          news = undefined;
          for (const placed of settled.items) spoken.add(newsKey(placed));
          // WARNING: a quick reply's settling runs after this turn's voice has ended.
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

  const speakFirst: Effect.Effect<void> = Effect.gen(function* () {
    if (!opts.proactive() || resting) return;
    const fresh = worthSpeaking(yield* waiting, spoken);
    if (fresh === null) return;
    const running = yield* warm;
    if (isString(running) || running.ended() !== null) return;
    const before = running.session.lastTurn();
    const choice = live!.choice;
    yield* SubscriptionRef.set(desktopTurns, "started");
    yield* turnOn(running, `${DESKTOP_SAID}\n${flockNewsText(fresh)}`, { news: fresh }).pipe(
      Effect.flatMap(Stream.runDrain),
      Effect.scoped,
      Effect.ensuring(SubscriptionRef.set(desktopTurns, "ended")),
    );
    // WARNING: a turn that failed before the model had its News waits for the next look, not the next nudge.
    resting = Arr.every(fresh.items, (placed) => !spoken.has(newsKey(placed)));
    const result = running.session.lastTurn();
    if (result !== undefined && result !== before)
      yield* appendJournal(usage, UsageLine, {
        at: yield* nowIso,
        session: id,
        turn: "desktop",
        harness: choice.harness,
        model: choice.model,
        duration_ms: result.duration_ms,
        usage: result.usage,
      });
  }).pipe(turns.withPermitsIfAvailable(1), Effect.provideContext(services), Effect.ignore);

  // WARNING: a fixed look-again for News written after its board change settled; a host push would replace it.
  yield* Effect.sync(() => {
    resting = false;
  }).pipe(Effect.andThen(nudge), Effect.repeat(Schedule.spaced(LOOK_AGAIN)), Effect.forkIn(scope));

  const accountOf = (now: Held) =>
    Effect.forEach(Rec.toEntries(drivers), ([harness, driver]) =>
      opts.offered(harness).pipe(
        Effect.map((offered) => ({
          harness,
          label: harnessName(harness),
          installed: driver.installed,
          offered,
        })),
      ),
    ).pipe(
      Effect.map((harnesses) => ({ ...now, harnesses })),
      Effect.provideContext(services),
    );

  yield* Stream.merge(
    opts.retold.pipe(Stream.tap(() => readModels(opts.chatHarness().harness))),
    opts.modelsChanged ?? Stream.empty,
  ).pipe(
    Stream.runForEach(() => tell),
    Effect.forkScoped,
  );

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
      Effect.forEach(
        Arr.filter(Rec.toEntries(drivers), ([, driver]) => driver.installed),
        ([harness, driver]) =>
          driver
            .earlier(HISTORY + 1)
            .pipe(Effect.map((sessions) => Arr.map(sessions, (one) => ({ ...one, harness })))),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((listed) => ({
          current: id,
          earlier: Arr.filter(listed.flat(), ({ session }) => session !== id)
            .sort((a, b) => b.at - a.at)
            .slice(0, HISTORY),
        })),
      ),
    ),
    // WARNING: a turn under way is interrupted, and its session ends before the next starts.
    reopen: (conversation) =>
      Effect.gen(function* () {
        if (turning !== undefined) yield* turning.session.interrupt;
        return yield* turns.withPermits(1)(
          Effect.gen(function* () {
            const set = opts.chatHarness().harness;
            if (conversation !== null && conversation.harness !== set) {
              const refused = yield* opts.setChatHarness({ harness: conversation.harness });
              if (refused !== null) return refused;
            }
            yield* end;
            id = conversation?.session ?? (yield* random.uuidV4());
            heldOn = conversation?.harness ?? set;
            yield* remember;
            return null;
          }),
        );
      }).pipe(Effect.orDie),
    nudge,
    desktopTurns: SubscriptionRef.changes(desktopTurns),
    changed: SubscriptionRef.changes(changed),
    choices: Stream.unwrap(
      Effect.suspend(() =>
        readModels(opts.chatHarness().harness).pipe(
          Effect.as(SubscriptionRef.changes(held).pipe(Stream.mapEffect(accountOf))),
        ),
      ),
    ),
  };
  return conversation;
});
