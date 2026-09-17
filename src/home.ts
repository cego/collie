// The Herd's Home: one Collie workspace per herdr session, and the rules for deciding
// which workspace that is.
//
// Ownership is the whole of this file's difficulty, and the rule is deliberately strict:
// a **record** Collie wrote, plus **proof** that the thing it names is still the thing it
// meant. A live token on the workspace is one proof; the recorded pane still carrying the
// recorded `terminal_id` is the other. A label is never proof — a label is what a human
// sees, and two workspaces can say the same thing.
//
// Everything uncertain is `ownership_unknown` and stops. Collie does not adopt a
// workspace because it looks right, and it does not create a second Home because a token
// expired: creating one where one already exists is how a Herd ends up with two boards
// disagreeing about the same Runs.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Clock, Data, Effect, FileSystem, Path, Schema } from "effect";
import { ensureLockDir, withLock } from "./lock";
import { herdDir, herdKey } from "./steering";
import { nowIso } from "./time";
import { BOARD_RATIO, CHAT_PANE_TOKEN } from "./chat";
import { Herdr, type PaneInfo, type WorkspaceInfo } from "./herdr";

/** The token a workspace carries to say it is this Herd's Home. Refreshed on every ensure. */
export const HOME_TOKEN = "collie_home";

/** Collie's state namespace is not a project directory. */
export const isHomeDirectory = Effect.fn("Home.isHomeDirectory")(function* (
  stateDir: string,
  cwd: string,
) {
  const path = yield* Path.Path;
  const relative = path.relative(path.join(stateDir, "herd"), cwd);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
});

/** A day. Long enough to survive a machine sleeping, short enough that a stale claim goes. */
export const TOKEN_TTL_MS = 86_400_000;

/** What a legacy per-workspace pane is marked with, so cleanup can find exactly those. */
export const LEGACY_PANE_TOKEN = "collie_pane";

const RecordSchema = Schema.Struct({
  workspaceId: Schema.String,
  tabId: Schema.NullOr(Schema.String),
  paneId: Schema.NullOr(Schema.String),
  terminalId: Schema.NullOr(Schema.String),
  /**
   * The native chat pane beside the board, in the same tab. Optional so a record written
   * before the Home had one still decodes: an old record read as unreadable would make
   * every existing installation an ownership question on upgrade.
   */
  chatPaneId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  chatTerminalId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  token: Schema.String,
  /**
   * `creating` is the window between deciding on a workspace and having a pane in it. It
   * is written *before* the pane is opened, so a crash in that window leaves something to
   * find rather than an orphan nobody can attribute.
   */
  state: Schema.Literals(["creating", "ready"]),
  /** Homes this Herd used to have, kept rather than deleted: they are how an orphan is named. */
  previous: Schema.Array(Schema.Struct({ workspaceId: Schema.String, archivedAt: Schema.String })),
});
export type HomeRecord = Schema.Schema.Type<typeof RecordSchema>;
const RecordJson = Schema.fromJsonString(RecordSchema);
const encodeRecord = Schema.encodeSync(RecordJson);

const ServerSchema = Schema.Struct({
  socket: Schema.String,
  version: Schema.String,
  protocol: Schema.Int,
  at: Schema.String,
});
const ServerJson = Schema.fromJsonString(ServerSchema);
const encodeServer = Schema.encodeSync(ServerJson);

export const homePath = Effect.fn("Home.path")(function* (stateDir: string, key: string) {
  const path = yield* Path.Path;
  return path.join(yield* herdDir(stateDir, key), "home.json");
});

export const serverPath = Effect.fn("Home.serverPath")(function* (stateDir: string, key: string) {
  const path = yield* Path.Path;
  return path.join(yield* herdDir(stateDir, key), "server.json");
});

/**
 * The Home record, or why there is none. A record that cannot be decoded is told apart
 * from one that was never written: read as absent, it makes a second Home beside the
 * first as soon as its token expires.
 */
export const readHome = Effect.fn("Home.read")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")));
  if (raw.trim() === "") return null;
  const decoded = Schema.decodeUnknownOption(RecordJson)(raw);
  return decoded._tag === "Some" ? decoded.value : UNREADABLE;
});

export const UNREADABLE = "unreadable";
export type ReadHome = HomeRecord | typeof UNREADABLE | null;

export const writeHome = Effect.fn("Home.write")(function* (file: string, record: HomeRecord) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  yield* fs.writeFileString(tmp, `${encodeRecord(record)}\n`);
  yield* fs.rename(tmp, file);
});

/**
 * What herdr this Herd is, recorded at every ensure. No start time and no pid: `status
 * server` exposes neither, so an epoch here would be invented — and liveness is always a
 * fresh look rather than a stored claim.
 */
export const writeServer = Effect.fn("Home.writeServer")(function* (
  file: string,
  server: { readonly socket: string; readonly version: string; readonly protocol: number },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const before = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")));
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, `${encodeServer({ ...server, at: yield* nowIso() })}\n`);
  const previous = Schema.decodeUnknownOption(ServerJson)(before);
  if (previous._tag === "None") return null;
  const moved =
    previous.value.version !== server.version || previous.value.protocol !== server.protocol;
  return moved
    ? `herdr moved from ${previous.value.version} (protocol ${previous.value.protocol}) to ${server.version} (protocol ${server.protocol})`
    : null;
});

/**
 * How long the shortcut's note about where it was pressed is worth reading. Short on
 * purpose: it exists so the board opens narrowed to the workspace the human came from,
 * and a note from an hour ago says nothing about the board in front of them now.
 */
export const ORIGIN_TTL_MS = 60_000;

const OriginSchema = Schema.Struct({
  /** The workspace the shortcut was pressed in, or null for one pressed in the Home. */
  workspaceId: Schema.NullOr(Schema.String),
  cwd: Schema.String,
  /** `all` when the shortcut was pressed inside the Home, which widens the board. */
  filter: Schema.NullOr(Schema.Literal("all")),
});
export type Origin = Schema.Schema.Type<typeof OriginSchema>;
const OriginJson = Schema.fromJsonString(
  Schema.Struct({ ...OriginSchema.fields, at: Schema.String }),
);
const encodeOrigin = Schema.encodeSync(OriginJson);
const decodeOrigin = Schema.decodeUnknownOption(OriginJson);

export const originPath = Effect.fn("Home.originPath")(function* (stateDir: string, key: string) {
  const path = yield* Path.Path;
  return path.join(yield* herdDir(stateDir, key), "origin.json");
});

export const writeOrigin = Effect.fn("Home.writeOrigin")(function* (file: string, origin: Origin) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, `${encodeOrigin({ ...origin, at: yield* nowIso() })}\n`);
});

/**
 * Where the board was opened from, or null when nothing recent says. Null rather than a
 * guess: a board with no origin has nothing to narrow to, and `g` says so by leaving the
 * filter where it is.
 */
export const readOrigin = Effect.fn("Home.readOrigin")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")));
  const decoded = decodeOrigin(raw);
  if (decoded._tag === "None") return null;
  const { at, ...origin } = decoded.value;
  const age = (yield* Clock.currentTimeMillis) - Date.parse(at);
  return Number.isFinite(age) && age <= ORIGIN_TTL_MS ? origin : null;
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/**
 * Whether the workspace this record names is still the Home it was written about.
 *
 * Two independent proofs, and either is enough. A live token is the ordinary one. The
 * recorded pane still carrying the recorded `terminal_id` is the other, and it is what
 * heals an expired token: the pane Collie opened is still there, so the claim was true
 * and the TTL merely lapsed.
 *
 * A live token with **no record** is not proof of anything: it is a previous Collie's
 * Home, or another state directory's, and adopting it silently would be one Herd taking
 * over another's board.
 */
export function ownershipProof(
  record: HomeRecord,
  workspaces: ReadonlyArray<WorkspaceInfo>,
  panes: ReadonlyArray<PaneInfo>,
  key: string,
): "token" | "pane" | null {
  const workspace = workspaces.find((entry) => entry.workspaceId === record.workspaceId);
  if (!workspace) return null;
  if (workspace.tokens[HOME_TOKEN] === key) return "token";
  if (record.paneId !== null && record.terminalId !== null) {
    const pane = panes.find(
      (entry) => entry.paneId === record.paneId && entry.workspaceId === record.workspaceId,
    );
    if (pane?.terminalId === record.terminalId) return "pane";
  }
  return null;
}

/** Workspaces carrying this Herd's token, whoever put it there. */
export function tokened(workspaces: ReadonlyArray<WorkspaceInfo>, key: string): WorkspaceInfo[] {
  return workspaces.filter((entry) => entry.tokens[HOME_TOKEN] === key);
}

export type Decision =
  /** Nothing to do but refresh what is already true. */
  | { readonly kind: "adopt"; readonly record: HomeRecord; readonly proof: "token" | "pane" }
  /**
   * A pane is gone but the workspace is still ours: reopen the ones that are missing and
   * nothing else. `missing` is which, so a live half-resized layout is left where the
   * human put it rather than rebuilt because the other half went.
   */
  | {
      readonly kind: "reopen";
      readonly record: HomeRecord;
      readonly missing: ReadonlyArray<"board" | "chat">;
    }
  /** Nothing owns this Herd's Home yet. `orphan` names a record left mid-create. */
  | { readonly kind: "create"; readonly orphan?: string }
  /** Somebody might. Collie stops and says who, rather than guessing. */
  | {
      readonly kind: "ownership_unknown";
      readonly why: string;
      readonly candidates: ReadonlyArray<string>;
    };

/**
 * Which of the five cases this is, decided from a record and one look at herdr. Pure, so
 * that the awkward ones — a crash mid-create, two tokened workspaces, an expired token on
 * a workspace whose pane is still there — are a table in a test rather than a walk
 * through a function that also opens things.
 */
/**
 * Which of the Home's two panes herdr no longer has. The board and native chat are one
 * tab's two halves, and either can be closed on its own: recovering the one that went is
 * what stops a missing chat pane costing the human the board's layout, or the other way
 * round.
 */
export function missingPanes(
  record: HomeRecord,
  panes: ReadonlyArray<PaneInfo>,
): Array<"board" | "chat"> {
  const there = (paneId: string | null | undefined) =>
    paneId !== null &&
    paneId !== undefined &&
    panes.some((entry) => entry.paneId === paneId && entry.workspaceId === record.workspaceId);
  const missing: Array<"board" | "chat"> = [];
  if (!there(record.paneId)) missing.push("board");
  if (!there(record.chatPaneId)) missing.push("chat");
  return missing;
}

export function decide(
  record: ReadHome,
  workspaces: ReadonlyArray<WorkspaceInfo>,
  panes: ReadonlyArray<PaneInfo>,
  key: string,
): Decision {
  const claimed = tokened(workspaces, key);
  const claimedIds = claimed.map((entry) => entry.workspaceId);
  const unknown = (why: string, candidates: ReadonlyArray<string>): Decision => ({
    kind: "ownership_unknown",
    why,
    candidates,
  });

  if (record === UNREADABLE)
    return unknown("this Herd's home.json cannot be read, so what it owns is unknown", claimedIds);

  if (record === null) {
    if (claimed.length === 0) return { kind: "create" };
    // A token nobody has a record for: a previous Collie's Home, or another state
    // directory's. Adopting it would be this Herd taking over somebody else's board.
    return unknown(
      "a workspace carries this Herd's token but nothing here has a record of it",
      claimedIds,
    );
  }

  /** Workspaces other than the recorded one that carry this Herd's token. */
  const elsewhere = claimed
    .filter((entry) => entry.workspaceId !== record.workspaceId)
    .map((entry) => entry.workspaceId);

  const live = workspaces.some((entry) => entry.workspaceId === record.workspaceId);
  // The recorded workspace is gone. Creating another is only right if nothing else claims
  // this Herd: a workspace still carrying the token is either one a human adopted or one
  // whose record is behind, and a second board is what SPEC §7.12 refuses to guess into.
  if (!live)
    return elsewhere.length === 0
      ? { kind: "create" }
      : unknown("the recorded workspace is gone but another carries this Herd's token", elsewhere);

  const proof = ownershipProof(record, workspaces, panes, key);
  if (proof !== null) {
    if (elsewhere.length > 0)
      return unknown("more than one workspace carries this Herd's token", [
        record.workspaceId,
        ...elsewhere,
      ]);
    const missing = missingPanes(record, panes);
    return missing.length === 0
      ? { kind: "adopt", record, proof }
      : { kind: "reopen", record, missing };
  }

  // A record left mid-create is an orphan candidate, not a Home: named, and a Home is
  // made anyway (SPEC §7.12 case 5), so a crash in that window does not need a human.
  // Unless something else claims the Herd — then the crash is not the only fact, and a
  // second board would be made beside a workspace that says it is already the one.
  if (record.state === "creating")
    return elsewhere.length === 0
      ? { kind: "create", orphan: record.workspaceId }
      : unknown("a mid-create record, and another workspace carries this Herd's token", [
          record.workspaceId,
          ...elsewhere,
        ]);

  return unknown(
    "the recorded workspace exists but carries neither this Herd's token nor its pane",
    [record.workspaceId],
  );
}

/** A record archived rather than deleted: it is how an orphan is later named. */
export function archived(record: HomeRecord, at: string): HomeRecord["previous"][number] {
  return { workspaceId: record.workspaceId, archivedAt: at };
}

// ---------------------------------------------------------------------------
// The runtime capability gate
// ---------------------------------------------------------------------------

/**
 * What the Home needs of the herdr that is actually installed. Distinct from the pinned
 * contract, which says what Collie was *built* against: a binary older than the pin runs
 * this code, and the only honest answer then is to refuse rather than to fall back to
 * owning a workspace by its label.
 */
export const REQUIRED_RUNTIME = [
  "workspace.report_metadata",
  "pane.report_metadata",
  "workspace.create",
  "WorkspaceInfo",
  "PaneInfo",
] as const;

export class CapabilityMissing extends Data.TaggedError("CapabilityMissing")<{
  missing: ReadonlyArray<string>;
}> {}

/**
 * Whether the installed binary has what the Home rests on. Checked against its own
 * printed schema, because that is the only thing that describes the binary in front of
 * us. There is no label-only path to fall back to, deliberately.
 */
export function missingRuntime(schema: string): string[] {
  const missing: string[] = REQUIRED_RUNTIME.filter((name) => !schema.includes(name));
  // On the type that carries them, not anywhere in the document: `tokens` on some
  // other type is nothing the ownership proof can read. Undecodable declares nothing.
  const decoded = decodeRuntime(schema);
  const apis = decoded._tag === "None" ? [] : Object.values(decoded.value.schemas);
  for (const [type, field] of REQUIRED_FIELDS)
    if (!apis.some((api) => field in (api.$defs?.[type]?.properties ?? {})))
      missing.push(`${type}.${field}`);
  return missing;
}

/**
 * The shape the gate reads: each API's `$defs`, and which properties each type declares.
 * Decoded rather than searched, so "the schema names `tokens`" cannot be answered by a
 * type that is not the one Collie reads it from.
 */
const RuntimeSchema = Schema.Struct({
  schemas: Schema.Record(
    Schema.String,
    Schema.Struct({
      $defs: Schema.optionalKey(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({}))),
          }),
        ),
      ),
    }),
  ),
});
const decodeRuntime = Schema.decodeUnknownOption(Schema.fromJsonString(RuntimeSchema));

/** The fields the ownership proof reads, and the type each has to be on. */
export const REQUIRED_FIELDS = [
  ["WorkspaceInfo", "tokens"],
  ["PaneInfo", "tokens"],
  ["PaneInfo", "terminal_id"],
] as const;

/** The Home's lock: held for a few file reads and one herdr round trip, never across work. */
export function withHomeLock<A, E, R>(file: string, effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    yield* ensureLockDir(file);
    return yield* withLock(`${file}.lock`, Effect.fail(new HomeBusy({ file })), effect);
  });
}

export class HomeBusy extends Data.TaggedError("HomeBusy")<{ file: string }> {}

// ---------------------------------------------------------------------------
// Ensuring it
// ---------------------------------------------------------------------------

/** Everything `ensureHome` needs of herdr, named so a test can supply it whole. */
export interface HomeDeps {
  readonly workspaces: HomeAnswer<ReadonlyArray<WorkspaceInfo>>;
  readonly panes: HomeAnswer<ReadonlyArray<PaneInfo>>;
  /** The new workspace's id, or `""` where herdr would not make one. */
  readonly createWorkspace: (opts: {
    readonly cwd: string;
    readonly label: string;
  }) => HomeAnswer<string>;
  /**
   * The board pane. `beside` a live chat pane, it is split into that pane's tab and put
   * on its left, so a reopened board rejoins the Home rather than opening a tab of its own.
   */
  readonly openPane: (
    workspaceId: string,
    cwd: string,
    beside?: string | null,
  ) => HomeAnswer<{ readonly tabId: string | null; readonly paneId: string | null }>;
  readonly markWorkspace: (
    workspaceId: string,
    tokens: Readonly<Record<string, string>>,
  ) => HomeAnswer<void>;
  /**
   * The native chat pane, made by splitting the board's. `""` where herdr would not make
   * one — a Home with a board and no chat is a Home a human can still work from.
   */
  readonly splitPane: (opts: {
    readonly paneId: string;
    readonly ratio: number;
    readonly cwd: string;
  }) => HomeAnswer<string>;
  readonly markPane: (paneId: string, tokens: Readonly<Record<string, string>>) => HomeAnswer<void>;
  /** Only ever the shell herdr puts in a workspace Collie has just made. */
  readonly closePane: (paneId: string) => HomeAnswer<void>;
  readonly log: (line: string) => HomeAnswer<void>;
}

/**
 * One answer from herdr, which cannot fail: every case this file decides is a case the
 * ownership rules already name, so a call that will not answer is "nothing there" rather
 * than an error path of its own. Bun's services because the real boundary shells out; a
 * test's fake needs none and satisfies this all the same.
 */
type HomeAnswer<A> = Effect.Effect<A, never, BunServices>;

function ready(record: HomeRecord): Ensured {
  return { kind: "ready", record };
}

export type Ensured =
  | { readonly kind: "ready"; readonly record: HomeRecord }
  /**
   * Collie's workspace, made and tokened, with no pane opened in it yet: herdr refused
   * the pane. Nothing for a human to settle — the record stays `creating`, the token
   * says whose the workspace is, and the next ensure reopens the pane (§7.12 case 5).
   */
  | { readonly kind: "incomplete"; readonly why: string; readonly record: HomeRecord }
  | {
      readonly kind: "ownership_unknown";
      readonly why: string;
      readonly candidates: ReadonlyArray<string>;
    };

/**
 * The Herd's Home, found or made, under a lock held for milliseconds.
 *
 * The two things this must never do: create a second Home because a token expired, and
 * adopt somebody else's because it looks like one. Both fall out of `decide` — an expired
 * token on a workspace whose pane is still there is proof, and a token nobody has a
 * record for is a stop.
 *
 * The record is written **before** the pane is opened. A crash in that window then leaves
 * something attributable rather than a workspace nobody can explain.
 */
export const ensureHome = Effect.fn("Home.ensure")(function* (
  stateDir: string,
  key: string,
  namespaceDir: string,
  deps: HomeDeps,
) {
  const file = yield* homePath(stateDir, key);
  return yield* withHomeLock(
    file,
    Effect.gen(function* () {
      const record = yield* readHome(file);
      const workspaces = yield* deps.workspaces;
      const panes = yield* deps.panes;
      const decision = decide(record, workspaces, panes, key);
      const at = yield* nowIso();

      if (decision.kind === "ownership_unknown") {
        yield* deps.log(`home: ${decision.why} (${decision.candidates.join(", ")})`);
        return decision;
      }

      if (decision.kind === "adopt") {
        // Refreshing the token is how an expired one is healed: the pane proved the
        // claim was true, so the claim is simply restated rather than re-decided.
        yield* deps.markWorkspace(decision.record.workspaceId, { [HOME_TOKEN]: key });
        if (decision.record.paneId !== null)
          yield* deps.markPane(decision.record.paneId, { [HOME_TOKEN]: key });
        return ready(decision.record);
      }

      if (decision.kind === "reopen") {
        // Only what went. A live board whose chat pane was closed keeps the board and
        // the width the human dragged it to; reopening the Home is not a rebuild.
        let next = decision.record;
        if (decision.missing.includes("board")) {
          const beside = decision.missing.includes("chat") ? null : next.chatPaneId;
          const opened = yield* deps.openPane(next.workspaceId, namespaceDir, beside);
          // Re-read: `panes` predates this pane, and a null terminalId loses ownership
          // proof (ii) as soon as the token expires.
          const pane = (yield* deps.panes).find((entry) => entry.paneId === opened.paneId);
          next = {
            ...next,
            tabId: opened.tabId,
            paneId: opened.paneId,
            terminalId: pane?.terminalId ?? null,
          };
        }
        if (decision.missing.includes("chat")) next = yield* withChat(next, namespaceDir, deps);
        next = { ...next, state: "ready" };
        yield* writeHome(file, next);
        yield* deps.markWorkspace(next.workspaceId, { [HOME_TOKEN]: key });
        if (next.paneId !== null) yield* deps.markPane(next.paneId, { [HOME_TOKEN]: key });
        yield* deps.log(
          `home: reopened the ${decision.missing.join(" and ")} pane in ${next.workspaceId}`,
        );
        return ready(next);
      }

      if (decision.orphan !== undefined)
        yield* deps.log(`home: ${decision.orphan} was left mid-create and is an orphan candidate`);
      const workspaceId = yield* deps.createWorkspace({ cwd: namespaceDir, label: "🐕 Collie" });
      // No id is no workspace. Writing a `ready` record for `""` would make every later
      // ensure decide `create` again — one more workspace attempt per launch — and send
      // callers to focus a workspace that does not exist. Nothing is written: the record
      // on disk stays whatever it was, and a human is told what to do about it.
      if (workspaceId === "") {
        const why = "herdr would not create this Herd's Home workspace";
        yield* deps.log(`home: ${why}`);
        return { kind: "ownership_unknown", why, candidates: [] } satisfies Ensured;
      }
      // Written before the pane exists, so a crash between the two leaves a record that
      // names the workspace rather than an orphan nobody can attribute.
      const creating: HomeRecord = {
        workspaceId,
        tabId: null,
        paneId: null,
        terminalId: null,
        createdAt: at,
        token: key,
        state: "creating",
        previous:
          record === null || record === UNREADABLE
            ? []
            : [...record.previous, archived(record, at)],
      };
      yield* writeHome(file, creating);
      // The workspace is this Herd's from here on, whatever happens to the pane: the
      // token is what lets a later ensure adopt a record left `creating` rather than
      // list the workspace as an orphan and make a second one beside it.
      yield* deps.markWorkspace(workspaceId, { [HOME_TOKEN]: key });
      // What herdr put in the workspace when it made it, noted before Collie's own pane
      // exists. A normal Home is one tab, and the shell that comes with a new workspace
      // is a second one nobody asked for — closed below, once there is something to
      // close it in favour of. Only these: a tab a human makes later is theirs.
      const generated = (yield* deps.panes)
        .filter((entry) => entry.workspaceId === workspaceId)
        .map((entry) => entry.paneId);

      const opened = yield* deps.openPane(workspaceId, namespaceDir);
      // No pane is not a Home. Written `ready` with null ids it would send every question
      // to a tab that is not there, and the next ensure — finding neither token proof
      // it can refresh nor a pane — would make it a human's to reconcile, for a workspace
      // Collie itself made a moment ago.
      if (opened.paneId === null) {
        const why = `herdr would not open the Home's pane in ${workspaceId}; the next launch tries again`;
        yield* deps.log(`home: ${why}`);
        return { kind: "incomplete", why, record: creating } satisfies Ensured;
      }
      const after = yield* deps.panes;
      const pane = after.find((entry) => entry.paneId === opened.paneId);
      const settled: HomeRecord = yield* withChat(
        {
          ...creating,
          tabId: opened.tabId,
          paneId: opened.paneId,
          terminalId: pane?.terminalId ?? null,
          state: "ready",
        },
        namespaceDir,
        deps,
      );
      yield* writeHome(file, settled);
      yield* deps.markPane(opened.paneId, { [HOME_TOKEN]: key });
      for (const paneId of generated) yield* deps.closePane(paneId);
      yield* deps.log(`home: created ${workspaceId}`);
      return ready(settled);
    }),
  );
});

/**
 * The board's pane split, with native chat on the right. The board keeps `BOARD_RATIO`,
 * which is herdr's own meaning for the number: the share the pane being split keeps.
 *
 * A split herdr refuses leaves the record's chat ids null. That is a Home with a board
 * and no conversation — reported, retried next launch, and never a reason to have no
 * control plane.
 */
const withChat = Effect.fn("Home.withChat")(function* (
  record: HomeRecord,
  namespaceDir: string,
  deps: HomeDeps,
) {
  if (record.paneId === null) return record;
  const paneId = yield* deps.splitPane({
    paneId: record.paneId,
    ratio: BOARD_RATIO,
    cwd: namespaceDir,
  });
  if (paneId === "") {
    yield* deps.log("home: herdr would not split the board for native chat");
    return { ...record, chatPaneId: null, chatTerminalId: null };
  }
  const pane = (yield* deps.panes).find((entry) => entry.paneId === paneId);
  // Both tokens: the Home's, so ownership proof reads it, and chat's, so recovery can
  // tell which of the tab's two panes went.
  yield* deps.markPane(paneId, { [HOME_TOKEN]: record.token, [CHAT_PANE_TOKEN]: record.token });
  return { ...record, chatPaneId: paneId, chatTerminalId: pane?.terminalId ?? null };
});

/**
 * Panes a `home cleanup` may close: a legacy per-workspace Collie pane, alone in its tab.
 * Anything else is listed and left — closing a pane somebody is sharing a tab with is not
 * cleanup, it is taking their window away.
 */
export interface Cleanup {
  /** Safe to close: a legacy pane alone in its tab. */
  readonly close: ReadonlyArray<string>;
  /** Named only: closing a pane somebody shares a tab with is not cleanup. */
  readonly listed: ReadonlyArray<string>;
}

export function closable(panes: ReadonlyArray<PaneInfo>): Cleanup {
  const legacy = panes.filter((pane) => pane.tokens[LEGACY_PANE_TOKEN] === "legacy");
  const close: string[] = [];
  const listed: string[] = [];
  for (const pane of legacy) {
    const alone = panes.filter((other) => other.tabId === pane.tabId).length === 1;
    (alone ? close : listed).push(pane.paneId);
  }
  return { close, listed };
}

// ---------------------------------------------------------------------------
// Ensuring it against the real herdr
// ---------------------------------------------------------------------------

/**
 * The Herd's Home against the herdr that is actually installed: the runtime gate, the
 * server record, then `ensureHome` under its lock. `null` is a herdr this build cannot
 * own a Home with, already logged — there is deliberately no label-only path to fall
 * back to (SPEC §7.12).
 *
 * Here rather than beside either front door, because the board opens the Home and every
 * Driver needs the same one to put a question in: two copies of this would be two
 * answers to "which workspace is ours".
 */
export const ensureHomeFor = Effect.fn("Home.ensureFor")(function* (
  herdr: Herdr,
  env: { stateDir: string; socketPath: string | null },
  log: (line: string) => HomeAnswer<void>,
) {
  // The socket names the Herd, and `HERDR_SOCKET_PATH` is not always injected — a CLI
  // launch often has none. herdr's own status is what says where its server is
  // listening, which is the probe SPEC §7.12 names; neither is `herdr_unreachable`, and
  // there is deliberately no cwd fallback.
  const key = yield* herdKey(env.socketPath, () =>
    herdr.serverInfo().pipe(
      Effect.map((server) => (server.socket === "" ? null : server.socket)),
      Effect.catch(() => Effect.succeed(null)),
    ),
  );
  const schema = yield* herdr.apiSchema().pipe(Effect.catch(() => Effect.succeed("")));
  const missing = missingRuntime(schema);
  if (missing.length > 0) {
    yield* log(`herdr_capability_missing:${missing.join(",")}`);
    return null;
  }
  const moved = yield* writeServer(
    yield* serverPath(env.stateDir, key),
    yield* herdr
      .serverInfo()
      .pipe(
        Effect.catch(() =>
          Effect.succeed({ socket: env.socketPath ?? "", version: "unknown", protocol: 0 }),
        ),
      ),
  );
  if (moved !== null) yield* log(moved);
  return yield* ensureHome(
    env.stateDir,
    key,
    yield* herdDir(env.stateDir, key),
    homeDeps(herdr, log),
  );
});

/** What `ensureHome` needs of herdr. A failed call is "nothing there", never a crash. */
export function homeDeps(herdr: Herdr, log: (line: string) => HomeAnswer<void>): HomeDeps {
  const nothing = <A>(value: A) => Effect.catch(() => Effect.succeed(value));
  return {
    workspaces: herdr.workspaceList().pipe(nothing<ReadonlyArray<WorkspaceInfo>>([])),
    panes: herdr.paneList().pipe(nothing<ReadonlyArray<PaneInfo>>([])),
    createWorkspace: (opts) => herdr.workspaceCreate(opts).pipe(nothing("")),
    openPane: (workspaceId, cwd, beside = null) =>
      Effect.gen(function* () {
        const opened =
          beside === null
            ? yield* herdr.pluginPaneOpen({
                entrypoint: "workspace",
                placement: "tab",
                focus: false,
                workspaceId,
                cwd,
                env: { COLLIE_CWD: cwd },
              })
            : // No workspace: herdr refuses a split that names one, the target pane says
              // where.
              yield* herdr.pluginPaneOpen({
                entrypoint: "workspace",
                placement: "split",
                targetPaneId: beside,
                direction: "right",
                focus: false,
                cwd,
                env: { COLLIE_CWD: cwd },
              });
        // Split to the right of the chat, then swapped and widened: the board is the
        // Home's left pane at four sevenths, as it was made the first time.
        if (beside !== null && opened.paneId !== null) {
          yield* herdr.paneSwap(opened.paneId, beside).pipe(nothing(undefined));
          yield* herdr.paneResize(opened.paneId, "right", 4 / 7 - 1 / 2).pipe(nothing(undefined));
        }
        return opened;
      }).pipe(
        nothing<{ tabId: string | null; paneId: string | null }>({ tabId: null, paneId: null }),
      ),
    splitPane: (opts) =>
      herdr
        .paneSplit({
          paneId: opts.paneId,
          direction: "right",
          ratio: opts.ratio,
          cwd: opts.cwd,
          focus: false,
        })
        .pipe(nothing("")),
    markWorkspace: (workspaceId, tokens) =>
      herdr.workspaceReportMetadata(workspaceId, tokens, TOKEN_TTL_MS).pipe(nothing(undefined)),
    markPane: (paneId, tokens) =>
      herdr.paneReportMetadata(paneId, tokens, TOKEN_TTL_MS).pipe(nothing(undefined)),
    closePane: (paneId) => herdr.paneClose(paneId).pipe(nothing(undefined)),
    log,
  };
}
