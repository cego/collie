// The Flock chat's tools: Collie's own Toolkit, answered by each Machine's host over the
// `chat` channel Desktop holds for it. Everything a tool says or takes is named
// `<machine>:<id>`; a bare id is taken where one Machine has it, and refused with the
// candidates where several do. The human's words go with each write as the channel's
// declaration, attached here and never by the model.

import {
  Cause,
  Clock,
  Crypto,
  Effect,
  Exit,
  FileSystem,
  Option,
  Result,
  Schema,
  Stream,
} from "effect";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import {
  type Declaration,
  type FLOCK_READS,
  HostRefused,
  NEWS_BATCH,
  type NewsBatch,
  type Significance,
  type TaskView,
} from "../../../src/board-model";
import { isString, type JsonObject } from "../../../src/schema";
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
import { carriedPaths } from "./carried";
import type { Door } from "./machine";

/** What the Flock chat asks of a Machine's host, over the channel the bridge declared `chat`. */
export const chatDoor = (door: Door) => ({
  act: (asked: Parameters<Door["act"]>[0]) => door.act(asked),
  board: () => door.board(),
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
});

export type ChatDoor = ReturnType<typeof chatDoor>;

/** A Machine as the Flock chat reaches it: the name it is called by, and its `chat` channel. */
export interface ChatMachine {
  readonly name: string;
  readonly door: ChatDoor;
  /** This computer, where Desktop runs. */
  readonly local?: boolean;
}

export interface FlockChat {
  readonly machines: () => ReadonlyArray<ChatMachine>;
  /** `flock@<this computer>`, which the host records each operation under. */
  readonly conversation: string;
  /** The human's message this turn, where there is one. */
  readonly said: () => string | undefined;
  /** Desktop's copies of the files the human's message this turn carried. */
  readonly attachments: () => ReadonlyArray<Staged> | undefined;
  /** What this session uploaded to each Machine: path there, and when, by sha256. */
  readonly uploaded: Map<string, Map<string, { readonly path: string; readonly at: number }>>;
  readonly machineRule: () => string | undefined;
  readonly setMachineRule: (rule: string) => Effect.Effect<void>;
  /** Each Machine's In sync standing; with a Machine's name, Sync now on it. */
  readonly inSync: (sync: string | undefined) => Effect.Effect<string>;
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
  InSyncTool,
);

export const FLOCK_TOOLS = Object.values(FlockTools.tools).map(describeTool);

const ANSWER_WITHIN = "10 seconds";

/** What a host's stream says first, within the time an answer gets. */
const firstOf = <A, E>(stream: Stream.Stream<A, E>) =>
  stream.pipe(Stream.runHead, Effect.timeout(ANSWER_WITHIN));

/** A Machine's board as its host has it now, or why it could not be read. */
export const boardOf = (machine: ChatMachine) =>
  firstOf(machine.door.board()).pipe(
    Effect.map((first) =>
      Option.isSome(first) && first.value._tag === "Snapshot" ? first.value : null,
    ),
    Effect.catch(() => Effect.succeed(null)),
  );

const boards = (flock: FlockChat) =>
  Effect.forEach(
    flock.machines(),
    (machine) => boardOf(machine).pipe(Effect.map((board) => ({ machine, board }))),
    { concurrency: "unbounded" },
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
  /** `ids` is null for a Machine whose board could not be read: it may have any id. */
  owners: ReadonlyArray<{
    readonly machine: ChatMachine;
    readonly ids: ReadonlySet<string> | null;
  }>,
  what: string,
): Result.Result<Placed, string> => {
  const colon = named.indexOf(":");
  const prefixed =
    colon > 0 ? owners.find(({ machine }) => machine.name === named.slice(0, colon)) : undefined;
  if (prefixed !== undefined)
    return Result.succeed({ machine: prefixed.machine, id: named.slice(colon + 1) });
  const having = owners.filter(({ ids }) => ids?.has(named) === true);
  const unread = owners.filter(({ ids }) => ids === null).map(({ machine }) => machine.name);
  if (colon > 0 && having.length === 0)
    return Result.fail(
      `No Machine "${named.slice(0, colon)}". Nothing was done; the Machines are ${owners
        .map(({ machine }) => machine.name)
        .join(", ")}.`,
    );
  const [only] = having;
  if (only !== undefined && having.length === 1 && unread.length > 0)
    return Result.fail(
      `${what} "${named}" is on ${only.machine.name}, and ${unread.join(", ")} could not be read to say whether it has one too. Nothing was done; name it as ${only.machine.name}:${named}.`,
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
  new Set(tasks.flatMap((task) => [task.run, ...task.runs]));

const proposalsOf = (tasks: ReadonlyArray<TaskView>) =>
  new Set(tasks.flatMap(({ decision }) => (decision?.kind === "proposal" ? [decision.id] : [])));

const owning = (known: Boards, ids: (tasks: ReadonlyArray<TaskView>) => ReadonlySet<string>) =>
  known.map(({ machine, board }) => ({
    machine,
    ids: board === null ? null : ids(board.tasks),
  }));

/** The board protocol a host must speak to keep each turn's words and settle only the News named. */
const FLOCK_PROTOCOL = 2;

/** Says, before a write, who is asking and what the human said that turn. */
const declareVoice = (flock: FlockChat, machine: ChatMachine) => {
  const said = flock.said();
  const files = flock.attachments()?.map(({ name }) => name) ?? [];
  let voice: Declaration = { frontDoor: "chat", conversation: flock.conversation };
  if (said !== undefined) voice = { ...voice, said };
  if (files.length > 0) voice = { ...voice, attachments: files };
  return machine.door.declare(voice);
};

/** `declareVoice`, refused where the host is too old to record the turn's words. */
export const speaking = (flock: FlockChat, machine: ChatMachine, known: Boards) => {
  const board = known.find((one) => one.machine === machine)?.board ?? null;
  const refused =
    board === null
      ? `its board could not be read, so Desktop cannot tell whether its Collie would record the human's words. Nothing was done on ${machine.name}.`
      : board.protocol < FLOCK_PROTOCOL
        ? `its Collie is older than Desktop's chat; upgrade Collie on ${machine.name}. Nothing was done there.`
        : null;
  return refused === null
    ? declareVoice(flock, machine)
    : Effect.fail(new HostRefused({ reason: refused }));
};

export const newRequest = Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4);

/** Why a host said no, in its own words. */
export const reasonOf = (error: { readonly message: string }) =>
  "reason" in error && isString(error.reason)
    ? error.reason
    : "detail" in error && isString(error.detail)
      ? error.detail
      : error.message;

const herd = Effect.fn("FlockTools.herd")(function* (flock: FlockChat) {
  const known = yield* boards(flock);
  const prefixed = known.flatMap(({ machine, board }) =>
    (board?.tasks ?? []).map((task) => ({ ...task, run: `${machine.name}:${task.run}` })),
  );
  const lost = known.flatMap(({ machine, board }) =>
    board === null ? [`- (${machine.name}'s board could not be read)`] : [],
  );
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
  const placed = place(input.run, owning(known, runsOf), "Run");
  return Result.isFailure(placed) ? placed.failure : yield* answer(placed.success);
});

/** A Machine's own answer to one of its reads, headed with its name. */
const readOn = (machine: ChatMachine, tool: (typeof FLOCK_READS)[number], input: JsonObject) =>
  machine.door.read({ tool, input }).pipe(
    Effect.timeout(ANSWER_WITHIN),
    Effect.map((text) => `## ${machine.name}\n\n${text}`),
    // A host without `read` answers with a defect, not a failure.
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.succeed(
            `## ${machine.name}\n\n${machine.name} did not answer; its Collie may be older than Desktop's; upgrade Collie on ${machine.name}.`,
          ),
    ),
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
  const known = yield* boards(flock);
  const told = yield* Effect.forEach(
    known,
    ({ machine, board }) =>
      Effect.forEach(board?.herds ?? [], (one) =>
        Effect.gen(function* () {
          yield* speaking(flock, machine, known);
          const { items } = yield* machine.door.news({
            herd: one.id,
            conversation: flock.conversation,
            as: "sent",
            request: yield* newRequest,
            keys: [],
          });
          return { machine: machine.name, herd: one.id, items };
        }),
      ).pipe(
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
    yield* declareVoice(flock, machine).pipe(Effect.timeout(ANSWER_WITHIN), Effect.ignoreCause);
    yield* machine.door
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
    const placed = place(input.run, owning(known, runsOf), "Run");
    if (Result.isFailure(placed)) return placed.failure;
    const { machine, id } = placed.success;
    yield* speaking(flock, machine, known);
    const done = yield* machine.door.control({
      runId: id,
      control: "hold",
      set: true,
      request: yield* newRequest,
      reason: input.reason ?? "asked in chat",
    });
    return done.detail || `Held ${machine.name}:${id}`;
  },
  Effect.catch((error) => Effect.succeed(`hold: failed — ${reasonOf(error)}`)),
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

interface Localized {
  /** Null for an action that names no Machine. */
  readonly machine: ChatMachine | null;
  /** The action under the Machine's own ids. */
  readonly action: JsonObject;
}

const placeOne = (action: JsonObject, known: Boards): Result.Result<Localized, string> => {
  const about = machineRef(action);
  if (about === null) return Result.succeed({ machine: null, action });
  const where =
    about.field === "run"
      ? place(about.name, owning(known, runsOf), "Run")
      : place(
          about.name,
          owning(known, () => new Set()),
          "workspace",
        );
  return Result.map(where, ({ machine, id }) => ({
    machine,
    action: { ...action, [about.field]: id },
  }));
};

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
      : placeOne(action, known);
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
    const done = yield* withFiles(flock, machine, known, local).pipe(
      Effect.tap(() => speaking(flock, machine, known)),
      Effect.flatMap((sent) => doOne(machine, kind, sent, step)),
      Effect.catch((error) => Effect.succeed({ state: "failed", note: reasonOf(error) })),
    );
    said.push(`${kind}: ${done.state}${done.note ? ` — ${done.note}` : ""}`);
    // What follows a failure was asked for on the assumption that it did not happen.
    if (done.state === "failed") break;
  }
  return said.join("\n");
});

/** The kinds of action that carry files to the work they start or steer. */
const CARRIES = new Set(["start", "followup", "deliver"]);

/** The action with the files it carries as paths on its Machine. */
const withFiles = (flock: FlockChat, machine: ChatMachine, known: Boards, action: JsonObject) => {
  if (!CARRIES.has(textAt(action, "kind"))) return Effect.succeed(action);
  const named = action["attachments"];
  const given = Array.isArray(named) ? named.filter(isString) : undefined;
  const board = known.find((one) => one.machine === machine)?.board ?? null;
  return carriedPaths(flock, machine, board, given).pipe(
    Effect.map((paths): JsonObject =>
      paths === undefined ? action : { ...action, attachments: paths },
    ),
  );
};

const doOne = (machine: ChatMachine, kind: string, action: JsonObject, request: string) => {
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
      const one = placeOne(action, known);
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
    const carrying = yield* Effect.forEach(placed, ({ action }) =>
      withFiles(flock, machine, known, action),
    );
    yield* speaking(flock, machine, known);
    const done = yield* machine.door.propose({
      herd: null,
      interpretation,
      actions: carrying,
      request,
    });
    return `Request: ${request}\n${done.human}`;
  },
  Effect.catch((error) =>
    Effect.succeed(`collie_propose could not carry it out: ${reasonOf(error)}`),
  ),
);

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
      collie_receipts: (input) => answer(receipts(flock, input)),
      collie_news: () => answer(news(flock)),
      collie_hold: (input) => answer(hold(flock, input)),
      collie_do: () => answer(carryOut(flock, sent)),
      collie_propose: () => answer(propose(flock, sent)),
      collie_machine_rule: ({ rule }) => answer(machineRule(flock, rule)),
      collie_in_sync: ({ sync }) => answer(flock.inSync(sync)),
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
