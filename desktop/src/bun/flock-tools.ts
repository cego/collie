// The Flock chat's tools: Collie's own Toolkit, answered by each Machine's host over the
// `chat` channel Desktop holds for it. Everything a tool says or takes is named
// `<machine>:<id>`; a bare id is taken where one Machine has it, and refused with the
// candidates where several do. The human's words go with each write as the channel's
// declaration, attached here and never by the model.

import { Cause, Clock, Crypto, Effect, Exit, FileSystem, Option, Result, Schema } from "effect";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import {
  type Declaration,
  type FLOCK_READS,
  HostRefused,
  NEWS_BATCH,
  type NewsBatch,
  PROTOCOL,
  type Significance,
  type TaskView,
} from "../../../src/board-model";
import {
  claimProject,
  type HelleCredentials,
  type HelleProject,
  helleMe,
  helleProjects,
  releaseClaim,
} from "../../../src/helle";
import { HELLE_TOKEN_STEPS } from "../../../src/helle-url";
import { isString, type JsonObject } from "../../../src/schema";
import { scheduleLines } from "../../../src/schedule-model";
import { DEFAULT_MODEL } from "../../../src/harness-choice";
import {
  answerWith,
  CollieTools,
  decodeAsked,
  decodeLoose,
  describeTool,
  herdLines,
  HoldInput,
  refusedActions,
  RunInput,
  TAKES,
} from "../../../src/toolkit";
import type { Staged } from "../shared/attachments";
import { type ChatChoices, type Resolved, runsAsOffered } from "../shared/chat-choices";
import { type ChatBoard, unreadBecause } from "../shared/flock";
import { moveSchedule, type ScheduleDoor } from "../../../src/schedule-move";
import { carriedPaths } from "./carried";
import { type ActionsLog, confirmed, Outlined, reasonOf, unlogged, withheldOf } from "./sent";
import type { Door } from "./machine";

/** What the Flock chat asks of a Machine's host, over the channel the bridge declared `chat`. */
export const chatDoor = (door: Door) => ({
  act: (asked: Parameters<Door["act"]>[0]) => door.act(asked),
  confirm: (asked: Parameters<Door["confirm"]>[0]) => door.confirm(asked),
  control: (asked: Parameters<Door["control"]>[0]) => door.control(asked),
  declare: (asked: Parameters<Door["declare"]>[0]) => door.declare(asked),
  decline: (asked: Parameters<Door["decline"]>[0]) => door.decline(asked),
  dispose: (asked: Parameters<Door["dispose"]>[0]) => door.dispose(asked),
  news: (asked: Parameters<Door["news"]>[0]) => door.news(asked),
  propose: (asked: Parameters<Door["propose"]>[0]) => door.propose(asked),
  readFile: (asked: Parameters<Door["readFile"]>[0]) => door.readFile(asked),
  glob: (asked: Parameters<Door["glob"]>[0]) => door.glob(asked),
  grep: (asked: Parameters<Door["grep"]>[0]) => door.grep(asked),
  writeFile: (asked: Parameters<Door["writeFile"]>[0]) => door.writeFile(asked),
  editFile: (asked: Parameters<Door["editFile"]>[0]) => door.editFile(asked),
  upload: (asked: Parameters<Door["upload"]>[0]) => door.upload(asked),
  read: (asked: Parameters<Door["read"]>[0]) => door.read(asked),
  progress: (asked: Parameters<Door["progress"]>[0]) => door.progress(asked),
  schedules: () => door.schedules(),
  changeSchedule: (asked: Parameters<Door["changeSchedule"]>[0]) => door.changeSchedule(asked),
});

export type ChatDoor = ReturnType<typeof chatDoor>;

/** A Machine as the Flock chat reaches it: the name the window calls it by, its board, and its `chat` channel. */
export interface ChatMachine {
  readonly name: string;
  /** The board Desktop follows for it, or why it has none live. */
  readonly board: ChatBoard;
  /** Absent until its `chat` channel is open. */
  readonly door?: ChatDoor;
  /** This computer, where Desktop runs. */
  readonly local?: boolean;
}

type LiveBoard = Extract<ChatBoard, { readonly _tag: "Live" }>;

/** A Machine the chat can act on now: its live board and open channel. */
export interface Reached {
  readonly name: string;
  readonly board: LiveBoard;
  readonly door: ChatDoor;
}

export interface FlockChat {
  readonly machines: () => ReadonlyArray<ChatMachine>;
  /** `flock@<this computer>`, which the host records each operation under. */
  readonly conversation: string;
  /** The human's message this turn, where there is one. */
  readonly said: () => string | undefined;
  /** Desktop's copies of the files the human's message this turn carried. */
  readonly attachments: () => ReadonlyArray<Staged> | undefined;
  /** Where each write's attempts are kept; none where absent. */
  readonly actionsLog?: ActionsLog;
  /** What this session uploaded to each Machine: path there, and when, by sha256. */
  readonly uploaded: Map<string, Map<string, { readonly path: string; readonly at: number }>>;
  readonly machineRule: () => string | undefined;
  readonly setMachineRule: (rule: string) => Effect.Effect<void>;
  /** Each Machine's In sync standing; with a Machine's name, Sync now on it. */
  readonly inSync: (sync: string | undefined) => Effect.Effect<string>;
  /** Helle with the token Desktop holds, or null without one; none where absent. */
  readonly helle?: Effect.Effect<HelleCredentials | null, string>;
  /** The chat's harness, model and effort as set. */
  readonly chatHarness: () => {
    readonly harness: string;
    readonly model: string | undefined;
    readonly effort: string | undefined;
  };
  /** What the chat holds, runs on and each harness offers. */
  readonly chatChoices: Effect.Effect<ChatChoices>;
  /** Saved with Settings' checks; why not, where it is refused. */
  readonly setChatHarness: (change: {
    readonly harness?: string;
    readonly model?: string;
    readonly effort?: string;
  }) => Effect.Effect<string | null>;
}

/** Desktop's own: a Herd's chat never chooses between Machines. */
const MachineRuleTool = Tool.make("collie_machine_rule", {
  description:
    "The human's Machine rule: their own words, from Desktop's Settings, for which Machine " +
    "each kind of work goes to. Without `rule` it is read back; with `rule` it is replaced " +
    "by exactly that text, which Settings then shows, and an empty `rule` clears it. Replace " +
    "it only when the human asks for the rule to change.",
  parameters: Schema.Struct({ rule: Schema.optionalKey(Schema.String) }),
  success: Schema.String,
  failureMode: "return",
  needsApproval: false,
})
  .annotate(Tool.Title, "The Machine rule")
  .annotate(Tool.Readonly, false);

/** Desktop's own: moving needs two Machines, which a Herd's chat never has. */
const MoveScheduleTool = Tool.make("collie_move_schedule", {
  description:
    "Move a Schedule to another Machine, when the human asks: it is added there paused, " +
    "removed here, then resumed there, and starts fresh with no catch-up. Name it as " +
    "<machine>:<name> and the Machine by name. `checkout` is its checkout's absolute path " +
    "on that Machine, where it is not the same path. Both Machines must be reachable.",
  parameters: Schema.Struct({
    schedule: Schema.String,
    to: Schema.String,
    checkout: Schema.optionalKey(Schema.String),
  }),
  success: Schema.String,
  failureMode: "return",
  needsApproval: false,
})
  .annotate(Tool.Title, "Move a Schedule")
  .annotate(Tool.Readonly, false);

const SchedulesTool = Tool.make("collie_schedules", {
  description:
    "Each Machine's Schedules, named <machine>:<name>, with their Workflow, checkout, cron, time zone, next occurrence, paused state and last outcome. A Machine that cannot be read says why; its list is never reported as empty.",
  parameters: Tool.EmptyParams,
  success: Schema.String,
  failureMode: "return",
  needsApproval: false,
})
  .annotate(Tool.Title, "The Flock's Schedules")
  .annotate(Tool.Readonly, true);

/** Desktop's own: a Herd's chat runs on the Home's harness. */
const ChatHarnessTool = Tool.make("collie_chat_harness", {
  description:
    "The harness, model and effort this conversation runs on, from Desktop's Settings. " +
    "Without arguments they are read back, with what the conversation runs on now; with " +
    "`harness`, `model` or `effort` they are replaced, checked as Settings checks them, and " +
    "an empty `model` or `effort` unsets it. Another harness unsets the model and the effort. " +
    "A change applies with the next message, and another harness starts a new conversation " +
    "with it. Change them only when the human asks.",
  parameters: Schema.Struct({
    harness: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.String),
    effort: Schema.optionalKey(Schema.String),
  }),
  success: Schema.String,
  failureMode: "return",
  needsApproval: false,
})
  .annotate(Tool.Title, "The Flock chat's harness")
  .annotate(Tool.Readonly, false);

/** Desktop's own: what its Machines page says of each Machine, and its Sync now. */
const InSyncTool = Tool.make("collie_in_sync", {
  description:
    "Whether each Machine is In sync with Desktop (its Collie version, settings, the " +
    "credentials Desktop gives, onboarding) and why one is not. With `sync` naming a " +
    "Machine, does what connecting would: reopens it to upgrade where it runs an older " +
    "Collie, else syncs its settings and gives what it lacks, and says how that went.",
  parameters: Schema.Struct({ sync: Schema.optionalKey(Schema.String) }),
  success: Schema.String,
  failureMode: "return",
  needsApproval: false,
})
  .annotate(Tool.Title, "In sync")
  .annotate(Tool.Readonly, false);

/** Desktop's own: Helle is the team's, not a Machine's. */
const HelleTool = Tool.make("collie_helle", {
  description:
    "Helle, the team's record of who holds each project, as the human is signed in to it. " +
    "Without arguments, every project with its holder and queue, the human's own marked. " +
    "`claim` names a project's slug to claim for the human: they hold it or are queued. " +
    "`release` names one to release, and is done before a `claim` in the same call. Claim or release only when the human asks.",
  parameters: Schema.Struct({
    claim: Schema.optionalKey(Schema.String),
    release: Schema.optionalKey(Schema.String),
  }),
  success: Schema.String,
  failureMode: "return",
  needsApproval: false,
})
  .annotate(Tool.Title, "Helle")
  .annotate(Tool.Readonly, false);

/**
 * The Toolkit's tools a front door can answer. Definitions, the installation and
 * workspace-wide holds read a Machine's own files, which no host operation hands over.
 */
export const FlockTools = Toolkit.make(
  CollieTools.tools.collie_herd,
  CollieTools.tools.collie_run,
  CollieTools.tools.collie_workspaces,
  CollieTools.tools.collie_receipts,
  CollieTools.tools.collie_news,
  CollieTools.tools.collie_hold,
  CollieTools.tools.collie_do,
  CollieTools.tools.collie_propose,
  MachineRuleTool,
  MoveScheduleTool,
  SchedulesTool,
  ChatHarnessTool,
  InSyncTool,
  HelleTool,
);

export const FLOCK_TOOLS = Object.values(FlockTools.tools).map(describeTool);

const ANSWER_WITHIN = "10 seconds";

/** A host's answer within `ANSWER_WITHIN`, or why it gave none. */
const answered = <A, E>(
  machine: ChatMachine,
  asking: Effect.Effect<A, E>,
): Effect.Effect<Result.Result<A, string>> =>
  asking.pipe(
    Effect.timeoutOption(ANSWER_WITHIN),
    Effect.map(
      Option.match({
        onNone: () => Result.fail(`${machine.name} did not answer within 10 s`),
        onSome: (answer) => Result.succeed(answer),
      }),
    ),
    // A host without the operation answers with a defect, not a failure.
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.succeed(
            Result.fail(
              `${machine.name} did not answer; its Collie may be older than Desktop's; upgrade Collie on ${machine.name}`,
            ),
          ),
    ),
  );

/** The Machine's live board and channel, or why it has none. */
const reachedAt = (
  { name, board, door }: ChatMachine,
  now: number,
): Result.Result<Reached, string> =>
  board._tag !== "Live"
    ? Result.fail(unreadBecause(name, board, now))
    : door === undefined
      ? Result.fail(`${name}'s chat channel is not open yet`)
      : Result.succeed({ name, board, door });

export const reach = (machine: ChatMachine) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    Result.match(reachedAt(machine, now), {
      onSuccess: Effect.succeed,
      onFailure: (reason) => Effect.fail(new HostRefused({ reason })),
    }),
  );

/** Each Machine, and the live board Desktop follows for it or why it has none. */
const boards = (flock: FlockChat) =>
  Effect.map(Clock.currentTimeMillis, (now) =>
    flock.machines().map((machine) => {
      const { board } = machine;
      return board._tag === "Live"
        ? { machine, board, unread: null }
        : { machine, board: null, unread: unreadBecause(machine.name, board, now) };
    }),
  );

type Boards = Effect.Success<ReturnType<typeof boards>>;

/** A Run or a proposal, and the Machine it is on. */
interface Placed {
  readonly machine: ChatMachine;
  readonly id: string;
}

/**
 * Where a name points: the Machine it names, or the only Machine with that id. A name
 * nobody has goes to the only Machine there is, whose host says it has no such thing.
 */
export const place = (
  named: string,
  /** `ids` is null for a Machine whose board could not be read, and `unread` says why. */
  owners: ReadonlyArray<{
    readonly machine: ChatMachine;
    readonly ids: ReadonlySet<string> | null;
    readonly unread: string | null;
  }>,
  what: string,
): Result.Result<Placed, string> => {
  const colon = named.indexOf(":");
  const prefixed =
    colon > 0 ? owners.find(({ machine }) => machine.name === named.slice(0, colon)) : undefined;
  if (prefixed !== undefined)
    return Result.succeed({ machine: prefixed.machine, id: named.slice(colon + 1) });
  const having = owners.filter(({ ids }) => ids?.has(named) === true);
  const unread = owners.filter(({ ids }) => ids === null);
  if (colon > 0 && having.length === 0)
    return Result.fail(
      `No Machine "${named.slice(0, colon)}". Nothing was done; the Machines are ${owners
        .map(({ machine }) => machine.name)
        .join(", ")}.`,
    );
  const [only] = having;
  if (only !== undefined && having.length === 1 && unread.length > 0)
    return Result.fail(
      `${what} "${named}" is on ${only.machine.name}, and ${unread
        .map(({ machine }) => machine.name)
        .join(", ")} could not be checked for one too (${unread
        .map(({ unread }) => unread)
        .join("; ")}). Nothing was done; name it as ${only.machine.name}:${named}.`,
    );
  if (having.length === 1) return Result.succeed({ machine: having[0]!.machine, id: named });
  if (having.length > 1)
    return Result.fail(
      `${what} "${named}" is on more than one Machine: ${having
        .map(({ machine }) => `${machine.name}:${named}`)
        .join(", ")}. Nothing was done; name the one meant.`,
    );
  if (owners.length === 1) return Result.succeed({ machine: owners[0]!.machine, id: named });
  return Result.fail(
    `No ${what} "${named}" on any Machine. Nothing was done; collie_herd lists them as <machine>:<id>.`,
  );
};

const runsOf = (tasks: ReadonlyArray<TaskView>) =>
  new Set(
    tasks.flatMap((task) => [
      task.run,
      ...task.runs,
      ...task.children.flatMap(({ run }) => (run === null ? [] : [run])),
    ]),
  );

const proposalsOf = (tasks: ReadonlyArray<TaskView>) =>
  new Set(tasks.flatMap(({ decision }) => (decision?.kind === "proposal" ? [decision.id] : [])));

const owning = (known: Boards, ids: (tasks: ReadonlyArray<TaskView>) => ReadonlySet<string>) =>
  known.map(({ machine, board, unread }) => ({
    machine,
    ids: board === null ? null : ids(board.tasks),
    unread,
  }));

/** Who has the Run `named`, each host with an open channel asked where no board lists a bare id. */
const runOwners = (known: Boards, named: string) => {
  const owners = owning(known, runsOf);
  if (named.indexOf(":") > 0 || owners.length < 2 || owners.some(({ ids }) => ids?.has(named)))
    return Effect.succeed(owners);
  return Effect.forEach(
    owners,
    (owner) =>
      owner.ids === null || owner.machine.door === undefined
        ? Effect.succeed(owner)
        : answered(owner.machine, owner.machine.door.progress({ runId: named })).pipe(
            Effect.map(
              Result.match({
                onSuccess: (progress) =>
                  progress === null ? owner : { ...owner, ids: new Set([named]) },
                onFailure: (why) => ({ ...owner, ids: null, unread: why }),
              }),
            ),
          ),
    { concurrency: "unbounded" },
  );
};

/** Says, before a write, who is asking and what the human said that turn. */
export const declareVoice = (flock: FlockChat, machine: Reached) => {
  const said = flock.said();
  const files = flock.attachments()?.map(({ name }) => name) ?? [];
  let voice: Declaration = { frontDoor: "chat", conversation: flock.conversation };
  if (said !== undefined) voice = { ...voice, said };
  if (files.length > 0) voice = { ...voice, attachments: files };
  return machine.door.declare(voice);
};

/** The Machine to write to, refused where it has no live board or its board speaks an older protocol than Desktop's. */
export const writable = (machine: ChatMachine) =>
  reach(machine).pipe(
    Effect.mapError(
      ({ reason }) =>
        new HostRefused({ reason: `${reason}. Nothing was done on ${machine.name}.` }),
    ),
    Effect.filterOrFail(
      (reached) => reached.board.protocol >= PROTOCOL,
      () =>
        new HostRefused({
          reason: `its Collie is older than Desktop's chat; upgrade Collie on ${machine.name}. Nothing was done there.`,
        }),
    ),
  );

/** `declareVoice` on a `writable` Machine, which it gives back. */
export const speaking = (flock: FlockChat, machine: ChatMachine) =>
  writable(machine).pipe(Effect.tap((reached) => declareVoice(flock, reached)));

export const newRequest = Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4);

export { reasonOf };

/** A chat write to `machine` under `request`, logged and confirmed as a board action is. */
const sentOn = <A, E extends { readonly _tag: string; readonly message: string }, R>(
  flock: FlockChat,
  machine: ChatMachine,
  request: string,
  kind: string,
  about: string,
  action: Schema.Json,
  call: (reached: Reached) => Effect.Effect<A, E, R>,
) => {
  const log = flock.actionsLog ?? unlogged;
  const sending = {
    door: "chat" as const,
    machine: machine.name,
    request,
    kind,
    about: about === "" ? null : about,
  };
  return writable(machine).pipe(
    Effect.tapError((refused) =>
      log({ ...sending, attempt: 0, ended: "not-sent", reason: reasonOf(refused) }),
    ),
    Effect.flatMap((reached) =>
      confirmed(
        { ...sending, log, withheld: withheldOf(action), what: `the ${kind} to ${about}` },
        declareVoice(flock, reached).pipe(Effect.andThen(call(reached))),
      ),
    ),
  );
};

/** What a write's outcome is called in the chat: one no reply confirmed is not a failure. */
const endedAs = (error: { readonly _tag: string; readonly message: string }) => ({
  state: error._tag === "Unconfirmed" ? "not confirmed" : "failed",
  note: reasonOf(error),
});

const herd = Effect.fn("FlockTools.herd")(function* (flock: FlockChat) {
  const known = yield* boards(flock);
  const on = (machine: ChatMachine, run: string) => `${machine.name}:${run}`;
  const prefixed = known.flatMap(({ machine, board }) =>
    (board?.tasks ?? []).map((task) => ({ ...task, run: on(machine, task.run) })),
  );
  const lost = known.flatMap(({ unread }) => (unread === null ? [] : [`- (${unread})`]));
  return [herdLines(prefixed, yield* Clock.currentTimeMillis), ...lost].join("\n");
});

const onRun = Effect.fn("FlockTools.onRun")(function* (
  flock: FlockChat,
  input: typeof RunInput.Type,
  tool: string,
  answer: (placed: Placed) => Effect.Effect<string>,
) {
  if (input.run === undefined)
    return `${tool} takes {"run": "<machine>:<run id>"}; Desktop's chat has no board selection to stand in.`;
  const known = yield* boards(flock);
  const placed = place(input.run, yield* runOwners(known, input.run), "Run");
  return Result.isFailure(placed) ? placed.failure : yield* answer(placed.success);
});

/** A Machine's own answer to one of its reads, headed with its name. */
const readOn = (machine: ChatMachine, tool: (typeof FLOCK_READS)[number], input: JsonObject) =>
  reach(machine).pipe(
    Effect.matchEffect({
      onFailure: ({ reason }) => Effect.succeed(reason),
      onSuccess: ({ door }) =>
        answered(machine, door.read({ tool, input })).pipe(
          Effect.map(Result.match({ onSuccess: (text) => text, onFailure: (why) => `${why}.` })),
        ),
    }),
    Effect.map((text) => `## ${machine.name}\n\n${text}`),
  );

const run = (flock: FlockChat, input: typeof RunInput.Type) =>
  onRun(flock, input, "collie_run", ({ machine, id }) =>
    readOn(machine, "collie_run", { run: id }),
  );

const receipts = (flock: FlockChat, input: typeof RunInput.Type) =>
  onRun(flock, input, "collie_receipts", ({ machine, id }) =>
    readOn(machine, "collie_receipts", { run: id }),
  );

const workspaces = Effect.fn("FlockTools.workspaces")(function* (flock: FlockChat) {
  const sections = yield* Effect.forEach(
    flock.machines(),
    (machine) => readOn(machine, "collie_workspaces", {}),
    { concurrency: "unbounded" },
  );
  return [
    ...sections,
    "a start names its workspace as <machine>: followed by a workspace id, a label, a checkout's path on that Machine, a repository's directory name under that Machine's Projects root, or projects-root.",
  ].join("\n\n");
});

const schedules = Effect.fn("FlockTools.schedules")(function* (flock: FlockChat) {
  const sections = yield* Effect.forEach(
    flock.machines(),
    (machine) =>
      reach(machine).pipe(
        Effect.flatMap(({ door }) => door.schedules()),
        Effect.map((listing) =>
          scheduleLines({
            ...listing,
            schedules: listing.schedules.map((entry) => ({
              ...entry,
              name: `${machine.name}:${entry.name}`,
            })),
          }),
        ),
        Effect.timeout(ANSWER_WITHIN),
        Effect.catch((error) => Effect.succeed(`Schedules could not be read: ${reasonOf(error)}`)),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.succeed(
                `Schedules could not be read; upgrade Collie on ${machine.name}, whose host may have no Schedules operation.`,
              ),
        ),
        Effect.map((text) => `## ${machine.name}\n\n${text}`),
      ),
    { concurrency: "unbounded" },
  );
  return sections.length === 0 ? "No Machines to read Schedules from." : sections.join("\n\n");
});

type NewsItem = (typeof NewsBatch.Type)["items"][number];

/** One Herd's pending News on one Machine. */
export interface Heard {
  readonly machine: string;
  readonly herd: string;
  readonly items: ReadonlyArray<NewsItem>;
}

const RANK: Record<Significance, number> = {
  decision: 3,
  consequential: 2,
  "try-it": 1,
  routine: 0,
};

type PlacedNews = {
  readonly machine: string;
  readonly herd: string;
  readonly item: NewsItem;
};

/** One item across the Flock: the same key in two Herds is two items. */
export const newsKey = ({ machine, herd, item }: PlacedNews) =>
  `${machine}\u0000${herd}\u0000${item.key}`;

const bySignificance = (newestFirst: boolean) => (a: PlacedNews, b: PlacedNews) =>
  RANK[b.item.significance] - RANK[a.item.significance] ||
  (newestFirst ? b.item.at.localeCompare(a.item.at) : a.item.at.localeCompare(b.item.at));

/**
 * Every Herd's News as one batch: a screen's worth of what matters most, newest first among
 * equals, listed by significance then time, and how many items each Machine had left out.
 */
export const flockBatch = (heard: ReadonlyArray<Heard>) => {
  const all = heard.flatMap(({ machine, herd, items }) =>
    items.map((item) => ({ machine, herd, item })),
  );
  const pressing = all.toSorted(bySignificance(true));
  const items = pressing.slice(0, NEWS_BATCH).toSorted(bySignificance(false));
  const omitted = new Map<string, number>();
  for (const { machine } of pressing.slice(NEWS_BATCH))
    omitted.set(machine, (omitted.get(machine) ?? 0) + 1);
  return { items, omitted };
};
export type FlockBatch = ReturnType<typeof flockBatch>;

export const flockNewsText = (batch: FlockBatch) =>
  [
    ...batch.items.map(
      ({ machine, item }) => `- [${item.significance}] ${machine}:${item.run}: ${item.text}`,
    ),
    ...[...batch.omitted].map(
      ([machine, count]) => `- and ${count} older or less pressing items on ${machine}`,
    ),
  ].join("\n");

/**
 * What a turn nobody asked for would be about: the decisions and consequential items not yet
 * spoken of, or null. Everything else waits for the human's next message.
 */
export const worthSpeaking = (
  batch: FlockBatch,
  spoken: ReadonlySet<string>,
): FlockBatch | null => {
  const items = batch.items.filter(
    (placed) =>
      RANK[placed.item.significance] >= RANK.consequential && !spoken.has(newsKey(placed)),
  );
  return items.length === 0 ? null : { items, omitted: new Map() };
};

/**
 * Every Herd's pending News on every Machine, taking nothing: what the conversation is
 * given is settled apart, by `delivered`. Asked as `sent` with no keys, so a host from
 * before `keys`, which settles what it hands over, records only that it was handed over.
 */
export const heardNews = Effect.fn("FlockTools.heardNews")(function* (flock: FlockChat) {
  const told = yield* Effect.forEach(
    flock.machines(),
    (machine) =>
      // `reach` first, so an unread Machine's reason comes without a write's refusal.
      reach(machine)
        .pipe(
          Effect.andThen(speaking(flock, machine)),
          Effect.flatMap((reached) =>
            Effect.forEach(reached.board.herds, (one) =>
              Effect.gen(function* () {
                const { items } = yield* reached.door.news({
                  herd: one.id,
                  conversation: flock.conversation,
                  as: "sent",
                  request: yield* newRequest,
                  keys: [],
                });
                return { machine: machine.name, herd: one.id, items };
              }),
            ),
          ),
        )
        .pipe(
          Effect.timeout(ANSWER_WITHIN),
          Effect.exit,
          Effect.map((exit) => ({ machine, exit })),
        ),
    { concurrency: "unbounded" },
  );
  const heard: Heard[] = [];
  const unread: string[] = [];
  for (const { machine, exit } of told)
    if (Exit.isSuccess(exit)) heard.push(...exit.value);
    else {
      const failed = Cause.findError(exit.cause);
      const why = Result.isSuccess(failed) ? reasonOf(failed.success) : "its host did not answer";
      unread.push(`${machine.name}'s News could not be read: ${why}`);
    }
  return { batch: flockBatch(heard), unread };
});

/** Settles what the conversation was given as read, in each Herd it came from. */
export const delivered = Effect.fn("FlockTools.delivered")(function* (
  flock: FlockChat,
  batch: FlockBatch,
) {
  const byMachine = new Map(flock.machines().map((machine) => [machine.name, machine]));
  const herds = Map.groupBy(batch.items, ({ machine, herd }) => `${machine}\u0000${herd}`);
  for (const items of herds.values()) {
    // SAFETY: `groupBy` makes no empty group.
    const { machine: name, herd } = items[0]!;
    const machine = byMachine.get(name);
    if (machine === undefined) continue;
    const reached = yield* reach(machine).pipe(Effect.option);
    if (Option.isNone(reached)) continue;
    yield* declareVoice(flock, reached.value).pipe(
      Effect.timeout(ANSWER_WITHIN),
      Effect.ignoreCause,
    );
    yield* reached.value.door
      .news({
        herd,
        conversation: flock.conversation,
        as: "read",
        request: yield* newRequest,
        keys: items.map(({ item }) => item.key),
      })
      .pipe(Effect.timeout(ANSWER_WITHIN), Effect.ignoreCause);
  }
});

const news = Effect.fn("FlockTools.news")(function* (flock: FlockChat) {
  const { batch, unread } = yield* heardNews(flock);
  yield* delivered(flock, batch);
  const said = [flockNewsText(batch), ...unread.map((line) => `- (${line})`)].filter(
    (part) => part !== "",
  );
  return said.length === 0 ? "Nothing new on any Machine." : said.join("\n");
});

const hold = Effect.fn("FlockTools.hold")(
  function* (flock: FlockChat, input: typeof HoldInput.Type) {
    if (input.run === undefined)
      return "collie_hold from Desktop's chat takes a Run; hold a workspace's Runs one by one, by the ids collie_herd lists.";
    const known = yield* boards(flock);
    const placed = place(input.run, yield* runOwners(known, input.run), "Run");
    if (Result.isFailure(placed)) return placed.failure;
    const { machine, id } = placed.success;
    const request = yield* newRequest;
    const holding = {
      runId: id,
      control: "hold" as const,
      set: true,
      request,
      reason: input.reason ?? "asked in chat",
    };
    const done = yield* sentOn(flock, machine, request, "hold", id, holding, (reached) =>
      reached.door.control(holding),
    );
    return done.detail || `Held ${machine.name}:${id}`;
  },
  Effect.catch((error) => {
    const { state, note } = endedAs(error);
    return Effect.succeed(`hold: ${state} — ${note}`);
  }),
);

/** A text field of an action decoded from JSON, or "" where it has none. */
const textAt = (action: JsonObject, key: string) => {
  const value = action[key];
  return isString(value) ? value : "";
};

/** The field an action names its Machine in, and the name. */
const machineRef = (
  action: JsonObject,
): { readonly field: string; readonly name: string } | null => {
  for (const field of ["run", "workspace"]) {
    const value = action[field];
    if (isString(value)) return { field, name: value };
  }
  return null;
};

/** The Machine an action's `machine` field names, or null where it names none. */
const machineField = (
  action: JsonObject,
  known: Boards,
): Result.Result<ChatMachine | null, string> => {
  const explicit = textAt(action, "machine");
  if (explicit === "") return Result.succeed(null);
  const found = known.find((one) => one.machine.name === explicit);
  return found === undefined
    ? Result.fail(`No Machine "${explicit}". Nothing was done.`)
    : Result.succeed(found.machine);
};

interface Localized {
  /** Null for an action that names no Machine. */
  readonly machine: ChatMachine | null;
  /** The action under the Machine's own ids. */
  readonly action: JsonObject;
}

const placeOne = Effect.fnUntraced(function* (
  action: JsonObject,
  known: Boards,
): Effect.fn.Return<Result.Result<Localized, string>> {
  const kind = textAt(action, "kind");
  if (kind === "cleanup" || kind === "home_cleanup") {
    const named = machineField(action, known);
    if (Result.isFailure(named)) return Result.fail(named.failure);
    if (named.success === null && known.length > 1)
      return Result.fail('Name the Machine this is for in its "machine" field. Nothing was done.');
    const { machine: _, ...local } = action;
    return Result.succeed({ machine: named.success, action: local });
  }
  if (kind.startsWith("schedule_")) {
    const named = machineField(action, known);
    if (Result.isFailure(named)) return Result.fail(named.failure);
    let machine = named.success;
    const savedStart = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))(
      action.start,
    );
    const start = Option.isSome(savedStart) ? { ...savedStart.value } : null;
    const local = { ...action };
    delete local.machine;
    const refs = [
      { field: "name", value: action.name },
      { field: "workspace", value: start?.workspace },
    ];
    for (const { field, value } of refs) {
      if (!isString(value) || !value.includes(":")) continue;
      const placed = place(
        value,
        owning(known, () => new Set()),
        field === "name" ? "Schedule" : "workspace",
      );
      if (Result.isFailure(placed)) return Result.fail(placed.failure);
      if (machine !== null && machine !== placed.success.machine)
        return Result.fail("The Schedule names different Machines. Nothing was done.");
      machine = placed.success.machine;
      if (field === "name") local.name = placed.success.id;
      else if (start !== null) start.workspace = placed.success.id;
    }
    if (machine === null && kind === "schedule_add" && known.length > 1)
      return Result.fail("Name the Machine this Schedule is for. Nothing was done.");
    if (start !== null) local.start = start;
    return Result.succeed({ machine, action: local });
  }
  const about = machineRef(action);
  if (about === null) return Result.succeed({ machine: null, action });
  const where =
    about.field === "run"
      ? place(about.name, yield* runOwners(known, about.name), "Run")
      : place(
          about.name,
          owning(known, () => new Set()),
          "workspace",
        );
  return Result.map(where, ({ machine, id }) => ({
    machine,
    action: { ...action, [about.field]: id },
  }));
});

const carryOut = Effect.fn("FlockTools.do")(function* (flock: FlockChat, input: JsonObject) {
  const decoded = decodeAsked(input);
  if (Result.isFailure(decoded))
    return refusedActions("collie_do", input, decoded.failure, TAKES.collie_do);
  const actions = Option.match(decodeLoose(input), {
    onNone: () => [],
    onSome: (loose) => loose.actions,
  });
  if (actions.length === 0) return "collie_do needs an action. Ask which one they meant.";
  const known = yield* boards(flock);
  const said: string[] = [];
  const request = yield* newRequest;
  for (const [index, action] of actions.entries()) {
    const kind = textAt(action, "kind");
    const settles = kind === "confirm" || kind === "decline";
    const where: Result.Result<Localized, string> = settles
      ? Result.map(
          place(textAt(action, "proposal"), owning(known, proposalsOf), "proposal"),
          ({ machine, id }) => ({ machine, action: { ...action, proposal: id } }),
        )
      : yield* placeOne(action, known);
    if (Result.isFailure(where)) {
      said.push(`${kind}: failed — ${where.failure}`);
      break;
    }
    const { machine: found, action: local } = where.success;
    const machine = found ?? (flock.machines().length === 1 ? flock.machines()[0]! : null);
    if (machine === null) {
      said.push(`${kind}: failed — name the Machine it is for, as <machine>:<workspace>`);
      break;
    }
    const step = `${request}-${index}`;
    const done = yield* sentOn(
      flock,
      machine,
      step,
      kind,
      textAt(local, "run") || textAt(local, "proposal"),
      local,
      (reached) =>
        withFiles(flock, reached, local).pipe(
          Effect.flatMap((sent) => doOne(reached, kind, sent, step)),
          Effect.filterOrFail(
            (done) => done.state !== "failed",
            (done) =>
              "outline" in done && isString(done.outline)
                ? new Outlined({ reason: done.note, logged: done.outline })
                : new HostRefused({ reason: done.note }),
          ),
        ),
    ).pipe(Effect.catch((error) => Effect.succeed(endedAs(error))));
    said.push(`${kind}: ${done.state}${done.note ? ` — ${done.note}` : ""}`);
    // What follows a failure was asked for on the assumption that it did not happen.
    if (done.state === "failed" || done.state === "not confirmed") break;
  }
  return said.join("\n");
});

/** The kinds of action that carry files to the work they start or steer. */
const CARRIES = new Set(["start", "followup", "take_offer", "deliver"]);

/** The action with the files it carries as paths on its Machine. */
const withFiles = (flock: FlockChat, machine: Reached, action: JsonObject) => {
  if (!CARRIES.has(textAt(action, "kind"))) return Effect.succeed(action);
  const named = action["attachments"];
  const given = Array.isArray(named) ? named.filter(isString) : undefined;
  return carriedPaths(flock, machine, given).pipe(
    Effect.map((paths): JsonObject =>
      paths === undefined ? action : { ...action, attachments: paths },
    ),
  );
};

const doOne = (machine: Reached, kind: string, action: JsonObject, request: string) => {
  const door = machine.door;
  const text = (key: string) => textAt(action, key);
  switch (kind) {
    case "confirm":
      return door.confirm({ proposal: text("proposal"), hash: text("hash"), request }).pipe(
        Effect.map(({ results }) => ({
          state: results.every((one) => one.state !== "failed") ? "applied" : "failed",
          note: results
            .map((one) => `${one.kind} ${one.state}${one.note ? ` (${one.note})` : ""}`)
            .join("; "),
          outline: results.map((one) => `${one.kind} ${one.state}`).join("; "),
        })),
      );
    case "decline":
      return door
        .decline({ proposal: text("proposal"), hash: text("hash"), request })
        .pipe(Effect.as({ state: "applied", note: "" }));
    case "disposition":
      return door
        .dispose({
          runId: text("run"),
          // SAFETY: decodeAsked held `became` to the three a disposition takes.
          kind: text("became") as "merged" | "abandoned" | "superseded",
          ref: text("ref"),
          note: null,
          request,
        })
        .pipe(Effect.map((done) => ({ state: "applied", note: `marked ${done.kind}` })));
    default:
      return door
        .act({ actions: [action], request })
        .pipe(
          Effect.map((results) => results[0] ?? { state: "failed", note: "the host said nothing" }),
        );
  }
};

const ProposeLoose = Schema.Struct({
  interpretation: Schema.String,
  actions: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
  request_id: Schema.optionalKey(Schema.String),
});

const propose = Effect.fn("FlockTools.propose")(
  function* (flock: FlockChat, input: JsonObject) {
    const { interpretation, actions, request_id } = Schema.decodeUnknownSync(ProposeLoose)(input);
    const known = yield* boards(flock);
    const placed: Localized[] = [];
    for (const action of actions) {
      const one = yield* placeOne(action, known);
      if (Result.isFailure(one)) return one.failure;
      placed.push(one.success);
    }
    const named = [
      ...new Set(placed.flatMap(({ machine }) => (machine === null ? [] : [machine]))),
    ];
    const [machine, ...others] = named.length === 0 ? flock.machines() : named;
    if (machine === undefined || others.length > 0)
      return named.length > 1
        ? `These actions are on ${named.map((one) => one.name).join(" and ")}; propose each Machine's separately. Nothing was done.`
        : "Name the Machine this is for, as <machine>:<run> or <machine>:<workspace>. Nothing was done.";
    const request = request_id ?? (yield* newRequest);
    const reached = yield* writable(machine);
    const carrying = yield* Effect.forEach(placed, ({ action }) =>
      withFiles(flock, reached, action),
    );
    yield* declareVoice(flock, reached);
    const done = yield* reached.door.propose({
      herd: null,
      interpretation,
      actions: carrying,
      request,
    });
    const schedules = placed.flatMap(({ action }) =>
      textAt(action, "kind").startsWith("schedule_")
        ? [`${machine.name}:${textAt(action, "name")}`]
        : [],
    );
    return `Request: ${request}\n${schedules.length === 0 ? "" : `Schedules: ${schedules.join(", ")}\n`}${done.human}`;
  },
  Effect.catch((error) =>
    Effect.succeed(`collie_propose could not carry it out: ${reasonOf(error)}`),
  ),
);

const moveScheduleBetween = Effect.fn("FlockTools.moveSchedule")(function* (
  flock: FlockChat,
  input: { readonly schedule: string; readonly to: string; readonly checkout?: string },
) {
  const colon = input.schedule.indexOf(":");
  const named = (name: string) => flock.machines().find((one) => one.name === name);
  const from = colon > 0 ? named(input.schedule.slice(0, colon)) : undefined;
  const to = named(input.to);
  if (from === undefined || to === undefined)
    return `Name the Schedule as <machine>:<name> and the Machine it goes to by name; Machines: ${flock
      .machines()
      .map((one) => one.name)
      .join(", ")}. Nothing was moved.`;
  const reached = yield* Effect.forEach([from, to], (machine) =>
    writable(machine).pipe(Effect.result),
  );
  const away = reached.flatMap((one) => (one._tag === "Failure" ? [reasonOf(one.failure)] : []));
  if (away.length > 0) return `machine_unreachable: ${away.join("; ")}`;
  const [source, target] = reached.flatMap((one) => (one._tag === "Success" ? [one.success] : []));
  yield* declareVoice(flock, source!);
  yield* declareVoice(flock, target!);
  const door = (machine: Reached): ScheduleDoor => ({
    name: machine.name,
    schedules: () => machine.door.schedules(),
    changeSchedule: (asked) => machine.door.changeSchedule(asked),
  });
  const moved = yield* moveSchedule({
    from: door(source!),
    to: door(target!),
    name: input.schedule.slice(colon + 1),
    request: yield* newRequest,
    checkout: input.checkout,
  });
  return moved.ok ? moved.said : `${moved.code}: ${moved.message}`;
});

const machineRule = (flock: FlockChat, asked: string | undefined) => {
  if (asked !== undefined) {
    const rule = asked.trim();
    return flock
      .setMachineRule(rule)
      .pipe(
        Effect.as(
          rule === "" ? "The Machine rule is cleared." : `The Machine rule is now: "${rule}"`,
        ),
      );
  }
  const saved = flock.machineRule()?.trim() ?? "";
  return Effect.succeed(
    saved === ""
      ? "There is no Machine rule: the human has not said which Machine work goes to."
      : `The Machine rule is: "${saved}"`,
  );
};

const runsSaid = ({ harness, model, effort }: Resolved) =>
  `${harness}/${model}${effort === null ? "" : ` at ${effort} effort`}`;

const chatHarness = (
  flock: FlockChat,
  change: { harness?: string; model?: string; effort?: string },
) =>
  Effect.gen(function* () {
    const setTo = (choices: ChatChoices) => {
      const set = flock.chatHarness();
      const offered = choices.harnesses.find(({ harness }) => harness === set.harness)?.offered;
      const runs =
        offered === undefined || offered.from === "reading" ? null : runsAsOffered(set, offered);
      const model =
        set.model !== undefined
          ? `model ${set.model}`
          : runs === null
            ? "with no model set"
            : `with no model set, so it runs as ${
                runs.model === DEFAULT_MODEL ? `${set.harness}'s own default model` : runs.model
              }`;
      const effort =
        set.effort !== undefined
          ? `at ${set.effort} effort`
          : runs === null
            ? "with no effort set"
            : runs.effort === null
              ? `with no effort, which ${runs.model} does not take`
              : `with no effort set, so it runs at ${runs.effort}`;
      return `${set.harness}, ${model}, ${effort}`;
    };
    if (change.harness === undefined && change.model === undefined && change.effort === undefined) {
      const choices = yield* flock.chatChoices;
      const set = flock.chatHarness().harness;
      return [
        `The Flock chat is set to ${setTo(choices)}.`,
        `The conversation is held on ${choices.heldOn}${
          choices.heldOn === set ? "" : `; the next message starts a new one on ${set}`
        }. ${
          choices.runsOn === null
            ? "No session is warm."
            : `Its session runs on ${runsSaid(choices.runsOn)} now.`
        }`,
        ...choices.harnesses.flatMap(({ harness, label, installed, offered }) => {
          if (!installed) return [];
          if (offered.from === "reading") return [`${harness}'s models are still being read.`];
          return [
            ...(offered.from !== "table"
              ? []
              : [
                  offered.why === undefined
                    ? `${label}'s models are from Collie's table.`
                    : `${label}'s list could not be read: ${offered.why.replace(/\.$/, "")}. Showing Collie's table.`,
                ]),
            offered.models.length === 0
              ? `${harness} offers no model by name.`
              : `${harness} offers ${offered.models
                  .map(
                    ({ id, efforts }) =>
                      `${id} (${efforts.length === 0 ? "no effort" : efforts.join(", ")})`,
                  )
                  .join(", ")}.`,
          ];
        }),
      ].join("\n");
    }
    const refused = yield* flock.setChatHarness(change);
    return refused === null
      ? `The Flock chat is now set to ${setTo(yield* flock.chatChoices)}. It applies with the next message.`
      : `${refused}. Nothing was changed.`;
  });

const projectLine = (project: HelleProject, me: string) => {
  const named = (member: { user_id: string; display_name?: string }) =>
    member.user_id === me
      ? `you (${member.display_name ?? me})`
      : (member.display_name ?? member.user_id);
  const slug = project.group ? `${project.group}/${project.slug}` : project.slug;
  const queue = project.queue ?? [];
  return `- ${slug}: ${project.holder ? `held by ${named(project.holder)}` : "free"}${
    queue.length === 0 ? "" : `; queued: ${queue.map(named).join(", ")}`
  }`;
};

const helle = (flock: FlockChat, asked: { claim?: string; release?: string }) =>
  Effect.gen(function* () {
    const creds = flock.helle === undefined ? null : yield* flock.helle;
    if (creds === null)
      return `Desktop holds no Helle token. To give it one, ${HELLE_TOKEN_STEPS}, and paste it in Desktop's Helle step.`;
    const done: string[] = [];
    if (asked.release !== undefined) {
      yield* releaseClaim(creds, asked.release);
      done.push(`Released ${asked.release} in Helle.`);
    }
    if (asked.claim !== undefined) {
      const claim = asked.claim;
      done.push(
        yield* claimProject(creds, claim).pipe(
          Effect.map(
            ({ position }) =>
              `Claimed ${claim} in Helle: ${
                position === 0 ? "you hold it" : `queued at position ${position}`
              }.`,
          ),
          Effect.catchTag("HelleError", ({ message }) => Effect.succeed(message)),
        ),
      );
    }
    if (done.length > 0) return done.join("\n");
    const me = yield* helleMe(creds);
    const projects = yield* helleProjects(creds);
    return projects.length === 0
      ? "Helle has no projects."
      : projects.map((project) => projectLine(project, me.user_id)).join("\n");
  }).pipe(Effect.catchTag("HelleError", ({ message }) => Effect.succeed(message)));

/** The handlers for one call, which take the input as it was sent once the Toolkit has decoded it. */
const handlersFor = (flock: FlockChat, sent: JsonObject) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<Crypto.Crypto | FileSystem.FileSystem>();
    const answer = <E>(effect: Effect.Effect<string, E, Crypto.Crypto | FileSystem.FileSystem>) =>
      effect.pipe(
        Effect.catch((cause) => Effect.succeed(`Collie could not answer: ${String(cause)}`)),
        Effect.provideContext(services),
      );
    return FlockTools.of({
      collie_herd: () => answer(herd(flock)),
      collie_run: (input) => answer(run(flock, input)),
      collie_workspaces: () => answer(workspaces(flock)),
      collie_schedules: () => answer(schedules(flock)),
      collie_receipts: (input) => answer(receipts(flock, input)),
      collie_news: () => answer(news(flock)),
      collie_hold: (input) => answer(hold(flock, input)),
      collie_do: () => answer(carryOut(flock, sent)),
      collie_propose: () => answer(propose(flock, sent)),
      collie_machine_rule: ({ rule }) => answer(machineRule(flock, rule)),
      collie_move_schedule: (input) => answer(moveScheduleBetween(flock, input)),
      collie_chat_harness: (change) => answer(chatHarness(flock, change)),
      collie_in_sync: ({ sync }) => answer(flock.inSync(sync)),
      collie_helle: (asked) => answer(helle(flock, asked)),
    });
  });

/** One call to a Flock tool, answered in a sentence, a refusal included. */
export const callFlockTool = Effect.fn("FlockTools.call")(
  function* (flock: FlockChat, name: string, input: JsonObject) {
    const toolkit = yield* FlockTools.pipe(
      Effect.provide(FlockTools.toLayer(handlersFor(flock, input))),
    );
    return yield* answerWith(toolkit, name, input);
  },
  Effect.catch((cause) => Effect.succeed(`Collie could not answer: ${String(cause)}`)),
);
