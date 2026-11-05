// What the human typed, read from each harness's sessions and Collie's records on this
// computer, for a chat to draft their Standing direction from. Never a tool: the host answers
// a Read only on Desktop's own door, after the human's click there.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Database } from "bun:sqlite";
import { Effect, FileSystem, Result, Schema, flow } from "effect";
import {
  type OwnMessage,
  type OwnSource,
  type OwnStore,
  type OwnWords,
  withinCaps,
} from "./own-words-model";
import { redact } from "./redact";
import { epochMs, isoAt } from "./time";
import { isJsonObject, isString, type JsonObject } from "./schema";

type Json = Schema.Json;
const isJsonArray = Schema.is(Schema.Array(Schema.Json));

export interface OwnPlaces {
  readonly home: string;
  readonly stateDir: string;
}

/** Where harnesses keep the human's sessions, under their home: only Read opens them. */
export const SESSION_STORES = [
  ".claude/projects",
  ".claude/history.jsonl",
  ".codex/sessions",
  ".codex/history.jsonl",
  ".pi/agent/sessions",
  ".local/share/opencode",
];

/** Why a chat's file tool may not go there. */
export const SESSIONS_CLOSED =
  "holds the human's sessions, which only their click on Desktop's \"Read my messages\" reads";

/**
 * The session store a file tool's call reaches: one its arguments name, or one below where its
 * search starts. Pi's extension carries this function's source, so it uses nothing around it.
 */
/* oxlint-disable effecttsgo/prefer-effect-array, effecttsgo/prefer-effect-string -- Pi runs this source without Effect. */
export function sessionStoreReached(
  stores: ReadonlyArray<string>,
  home: string,
  said: ReadonlyArray<string>,
  root: string | null,
): string | undefined {
  const top = root === null ? null : root.replace(/\/+$/, "");
  return stores.find(
    (store) =>
      said.some((one) => one.includes(store)) ||
      (top !== null && `${home}/${store}`.startsWith(`${top}/`)),
  );
}
/* oxlint-enable effecttsgo/prefer-effect-array, effecttsgo/prefer-effect-string */

const DAYS = 90;
const MOST_IN_ONE = 1000;
const DELIVERY = "collie-delivery:";

interface Said {
  readonly at: string;
  readonly text: string;
}

/** One session as its store has it: the human's candidate messages, and whether Collie sent any. */
interface Session {
  readonly ids: ReadonlyArray<string>;
  readonly cwd: string | null;
  readonly said: ReadonlyArray<Said>;
  readonly delivered: boolean;
}

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
/** Each line's record, or why the file is not one the reader knows; an unended last line is still being written. */
const recordsOf = (
  text: string,
  types?: ReadonlySet<string>,
): ReadonlyArray<JsonObject> | string => {
  const records: Array<JsonObject> = [];
  const lines = Str.split(text, "\n");
  for (const [index, line] of Arr.map(Arr.dropRight(lines, 1), (line, i) => [i, line] as const)) {
    if (Str.trim(line) === "") continue;
    const record = pipe(decodeLine(line), Option.filter(isJsonObject), Option.getOrUndefined);
    const type = record?.["type"];
    if (record === undefined || (types !== undefined && !(isString(type) && types.has(type))))
      return record === undefined
        ? `line ${index + 1} is not a record`
        : `line ${index + 1} is of type ${String(type)}, which it does not know`;
    records.push(record);
  }
  return records;
};

/** The record types each harness writes to a session, as of the versions read here. */
const CLAUDE_TYPES = new Set([
  "user",
  "assistant",
  "system",
  "attachment",
  "progress",
  "summary",
  "file-history-snapshot",
  "file-history-delta",
  "last-prompt",
  "continued-in",
  "content-replacement",
  "api-request-shape",
  "api-request-blob",
  "api-request",
  "fork-context-ref",
  "frame-link",
  "custom-title",
  "ended-by-model",
  "ai-title",
  "tag",
  "relocated",
  "agent-name",
  "agent-color",
  "agent-setting",
  "pr-link",
  "artifact-comment-monitor",
  "artifact-autoreact-ledger",
  "bridge-session",
  "history-suppression",
  "attribution-snapshot",
  "mode",
  "permission-mode",
  "isolation-latch",
  "dev-mods",
  "memory-mode",
  "atis-latch",
  "worktree-state",
  "cost-state",
  "queue-operation",
  "observer-ref",
  "marble-origami-commit",
  "marble-origami-snapshot",
  "speculation-accept",
]);
const CODEX_TYPES = new Set([
  "session_meta",
  "response_item",
  "event_msg",
  "turn_context",
  "compacted",
]);
const PI_TYPES = new Set([
  "session",
  "message",
  "model_change",
  "thinking_level_change",
  "usage",
  "compaction",
  "context_edit",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);
const objectAt = (value: Json | undefined, key: string): JsonObject | undefined => {
  const found = isJsonObject(value) ? value[key] : undefined;
  return isJsonObject(found) ? found : undefined;
};
const stringAt = (value: Json | undefined, key: string) => {
  const found = isJsonObject(value) ? value[key] : undefined;
  return isString(found) ? found : undefined;
};

/** Text the harness or a hook put where the human types. */
const injected = (text: string) =>
  /^<[a-z][\w-]*>/.test(text) ||
  pipe(text, Str.startsWith("Caveat: ")) ||
  pipe(text, Str.startsWith("[Request interrupted")) ||
  pipe(text, Str.startsWith("# AGENTS.md instructions"));

const withoutReminders = (text: string) =>
  Str.trim(pipe(text, Str.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")));

/** The text of a turn of text and images: a list with anything else in it is a tool's. */
const typedText = (content: Json | undefined, kind: string) => {
  if (isString(content)) return content;
  if (!isJsonArray(content)) return undefined;
  const types = Arr.map(content, (block) => stringAt(block, "type"));
  if (!Arr.every(types, (type) => type === kind || type === "image")) return undefined;
  const texts = Arr.filter(
    Arr.map(content, (block) => stringAt(block, "text")),
    isString,
  );
  return texts.length === 0 ? undefined : Arr.join(texts, "\n");
};

const claudeSession = (records: ReadonlyArray<JsonObject>, stem: string): Session => {
  let cwd: string | null = null;
  let delivered = false;
  const said: Array<Said> = [];
  for (const line of records) {
    if (line["type"] !== "user") continue;
    cwd = stringAt(line, "cwd") ?? cwd;
    const raw = typedText(objectAt(line, "message")?.["content"], "text");
    if (raw === undefined) continue;
    delivered ||= pipe(raw, Str.includes(DELIVERY));
    const kind = stringAt(objectAt(line, "origin"), "kind");
    if (
      line["isMeta"] === true ||
      line["isCompactSummary"] === true ||
      line["isVisibleInTranscriptOnly"] === true ||
      line["isSidechain"] === true ||
      (kind !== undefined && kind !== "human")
    )
      continue;
    const typed = withoutReminders(raw);
    const at = stringAt(line, "timestamp");
    if (typed !== "" && !injected(typed) && at !== undefined) said.push({ at, text: typed });
  }
  return { ids: [stem], cwd, said, delivered };
};

const codexSession = (records: ReadonlyArray<JsonObject>): Session => {
  let ids: ReadonlyArray<string> = [];
  let cwd: string | null = null;
  let spawned = false;
  let delivered = false;
  const said: Array<Said> = [];
  for (const line of records) {
    const payload = objectAt(line, "payload");
    if (line["type"] === "session_meta") {
      ids = Arr.filter([stringAt(payload, "id"), stringAt(payload, "session_id")], isString);
      cwd = stringAt(payload, "cwd") ?? cwd;
      // A subagent's user turns are its parent model's words.
      spawned = objectAt(payload, "source")?.["subagent"] !== undefined;
      continue;
    }
    if (line["type"] !== "response_item") continue;
    if (stringAt(payload, "type") !== "message" || stringAt(payload, "role") !== "user") continue;
    const at = stringAt(line, "timestamp");
    const content = payload?.["content"];
    for (const block of isJsonArray(content) ? content : []) {
      const raw = stringAt(block, "type") === "input_text" ? stringAt(block, "text") : undefined;
      if (raw === undefined) continue;
      delivered ||= pipe(raw, Str.includes(DELIVERY));
      const typed = Str.trim(raw);
      if (typed !== "" && !injected(typed) && at !== undefined) said.push({ at, text: typed });
    }
  }
  return { ids, cwd, said: spawned ? [] : said, delivered };
};

const piSession = (records: ReadonlyArray<JsonObject>): Session => {
  let ids: ReadonlyArray<string> = [];
  let cwd: string | null = null;
  let delivered = false;
  const said: Array<Said> = [];
  for (const line of records) {
    if (line["type"] === "session") {
      ids = Arr.filter([stringAt(line, "id")], isString);
      cwd = stringAt(line, "cwd") ?? cwd;
      continue;
    }
    const message = objectAt(line, "message");
    if (line["type"] !== "message" || stringAt(message, "role") !== "user") continue;
    const raw = typedText(message?.["content"], "text");
    if (raw === undefined) continue;
    delivered ||= pipe(raw, Str.includes(DELIVERY));
    const typed = Str.trim(raw);
    const at = stringAt(line, "timestamp");
    if (typed !== "" && !injected(typed) && at !== undefined) said.push({ at, text: typed });
  }
  return { ids, cwd, said, delivered };
};

const OpenCodeRow = Schema.Struct({
  session: Schema.String,
  parent: Schema.NullOr(Schema.String),
  directory: Schema.String,
  at: Schema.Finite,
  part: Schema.String,
});
const decodeRows = flow(Schema.decodeUnknownResult(Schema.Array(OpenCodeRow)), Result.getOrThrow);
const decodeSessions = flow(
  Schema.decodeUnknownResult(Schema.Array(Schema.Struct({ session: Schema.String }))),
  Result.getOrThrow,
);
const decodePlacings = flow(
  Schema.decodeUnknownResult(
    Schema.Array(Schema.Struct({ run: Schema.String, placing: Schema.String })),
  ),
  Result.getOrThrow,
);
const decodeCount = flow(
  Schema.decodeUnknownResult(Schema.Struct({ n: Schema.Finite })),
  Result.getOrThrow,
);

/** OpenCode's SQLite store, read-only; any table or column it lacks makes it unreadable. */
const openCodeStore = (file: string, since: number | null) =>
  Effect.try({
    try: () => {
      const db = new Database(file, { readonly: true });
      try {
        const count = decodeCount(db.query("SELECT count(*) AS n FROM session").get()).n;
        if (since === null) return { count, sessions: [] };
        // A token marks the whole session, however old the message that carries it.
        const collies = new Set(
          Arr.map(
            decodeSessions(
              db
                .query(
                  `SELECT DISTINCT m.session_id AS session
                   FROM part p JOIN message m ON m.id = p.message_id
                   WHERE json_extract(m.data, '$.role') = 'user'
                     AND instr(json_extract(p.data, '$.text'), ?) > 0`,
                )
                .all(DELIVERY),
            ),
            (row) => row.session,
          ),
        );
        const rows = decodeRows(
          db
            .query(
              `SELECT s.id AS session, s.parent_id AS parent, s.directory AS directory,
                      m.time_created AS at, p.data AS part
               FROM part p JOIN message m ON m.id = p.message_id JOIN session s ON s.id = m.session_id
               WHERE json_extract(m.data, '$.role') = 'user' AND m.time_created >= ?
               ORDER BY m.time_created, p.id`,
            )
            .all(since),
        );
        const sessions = Arr.map(
          Rec.values(Arr.groupBy(rows, (row) => row.session)),
          (parts): Session => {
            const said: Array<Said> = [];
            for (const row of parts) {
              const part = pipe(decodeLine(row.part), Option.getOrUndefined);
              const raw = stringAt(part, "type") === "text" ? stringAt(part, "text") : undefined;
              if (raw === undefined) continue;
              const typed = Str.trim(raw);
              if (isJsonObject(part) && part["synthetic"] === true) continue;
              if (typed !== "" && !injected(typed)) said.push({ at: isoAt(row.at), text: typed });
            }
            const first = parts[0]!;
            // A child session's user turns are the model's own.
            return {
              ids: [first.session],
              cwd: first.directory,
              said: first.parent === null ? said : [],
              delivered: collies.has(first.session),
            };
          },
        );
        return { count, sessions };
      } finally {
        db.close();
      }
    },
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  });

/** A harness's session files, and how each is read. */
interface FileStore {
  readonly source: OwnSource;
  readonly root: string;
  readonly isSession: (relative: string) => boolean;
  readonly types: ReadonlySet<string>;
  readonly read: (records: ReadonlyArray<JsonObject>, relative: string) => Session;
}

const fileStores = (home: string): ReadonlyArray<FileStore> => [
  {
    source: "claude-code",
    root: `${home}/.claude/projects`,
    // A session's own subagents are kept in a folder beside it, as sidechains.
    isSession: (relative) => /^[^/]+\/[^/]+\.jsonl$/.test(relative),
    types: CLAUDE_TYPES,
    read: (records, relative) =>
      claudeSession(
        records,
        pipe(relative, Str.split("/"), Arr.lastNonEmpty, Str.replace(/\.jsonl$/, "")),
      ),
  },
  {
    source: "codex",
    root: `${home}/.codex/sessions`,
    isSession: (relative) => /(^|\/)rollout-[^/]*\.jsonl$/.test(relative),
    types: CODEX_TYPES,
    read: codexSession,
  },
  {
    source: "pi",
    root: `${home}/.pi/agent/sessions`,
    isSession: (relative) => /^[^/]+\/[^/]+\.jsonl$/.test(relative),
    types: PI_TYPES,
    read: piSession,
  },
];

const openCodeFile = (home: string) => `${home}/.local/share/opencode/opencode.db`;

/** Every session Collie recorded launching a Run's agent in, by id or path. */
const recordedAgentSessions = Effect.fn("OwnWords.recordedAgentSessions")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const dir = `${stateDir}/agents`;
  const names = yield* fs
    .readDirectory(dir, { recursive: true })
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const sessions = new Set<string>();
  for (const name of Arr.filter(names, Str.endsWith(".launch.json"))) {
    const text = yield* fs.readFileString(`${dir}/${name}`).pipe(Effect.orElseSucceed(() => ""));
    const value = stringAt(
      objectAt(pipe(decodeLine(text), Option.getOrUndefined), "agentSession"),
      "value",
    );
    if (value !== undefined) sessions.add(value);
  }
  return sessions;
});

const HUMAN_DOORS = new Set(["desktop", "cli-tty", "board"]);

/** A human's entry: through a human door, or a chat's carrying the words they said. */
const isHuman = (line: JsonObject) => {
  const actor = objectAt(line, "actor");
  const origin = stringAt(actor, "origin");
  return origin === "chat" ? stringAt(actor, "said") !== undefined : HUMAN_DOORS.has(origin ?? "");
};

/** The words each Run was started with through a human door, as the host's store keeps them. */
const startedWords = Effect.fn("OwnWords.startedWords")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = `${stateDir}/host.db`;
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))))
    return new Map<string, string>();
  return yield* Effect.try({
    try: () => {
      const db = new Database(file, { readonly: true });
      try {
        const started = new Map<string, string>();
        for (const { run, placing } of decodePlacings(
          db.query("SELECT run, placing FROM collie_runs WHERE placing IS NOT NULL").all(),
        )) {
          const by = objectAt(pipe(decodeLine(placing), Option.getOrUndefined), "started");
          const words = stringAt(by, "words");
          if (words !== undefined && stringAt(by, "door") !== "chat") started.set(run, words);
        }
        return started;
      } finally {
        db.close();
      }
    },
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  });
});

/** What a human's entry says they typed, where it holds their words. */
const typedIn = (line: JsonObject, started: ReadonlyMap<string, string>, run: string) => {
  const asked = objectAt(line, "asked");
  return (
    stringAt(objectAt(line, "actor"), "said") ??
    (line["operation"] === "start"
      ? started.get(run)
      : line["operation"] === "answer"
        ? stringAt(objectAt(line, "result"), "value")
        : (stringAt(asked, "text") ?? stringAt(asked, "reason") ?? stringAt(asked, "note")))
  );
};

/** The sessions of a store it could not read, and why the first could not. */
class Unread {
  private count = 0;
  private first: string | undefined;
  add(which: string, why: string) {
    this.count += 1;
    this.first ??= `${which}: ${why}`;
  }
  said(): Pick<OwnStore, "unread" | "why"> {
    return this.first === undefined ? {} : { unread: this.count, why: this.first };
  }
}

/**
 * How many human entries Collie's records hold, and, when `reading`, the words they hold, each
 * under the Run it was said to.
 */
const collieWords = Effect.fn("OwnWords.collie")(function* (stateDir: string, reading: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const dir = `${stateDir}/runs`;
  const runs = yield* fs.readDirectory(dir);
  const started = reading ? yield* startedWords(stateDir) : new Map<string, string>();
  const words: Array<OwnMessage> = [];
  const unread = new Unread();
  let entries = 0;
  for (const run of runs) {
    const read = yield* fs.readFileString(`${dir}/${run}/operations.jsonl`).pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(String(error)),
      ),
      Effect.result,
    );
    if (read._tag === "Failure") {
      unread.add(run, read.failure);
      continue;
    }
    const records = recordsOf(read.success);
    if (isString(records)) {
      unread.add(run, records);
      continue;
    }
    const lines = Arr.filter(records, isHuman);
    entries += lines.length;
    if (!reading) continue;
    const seen = new Set<string>();
    for (const line of lines) {
      const text = typedIn(line, started, run);
      const at = stringAt(line, "at");
      const typed = text === undefined ? "" : Str.trim(text);
      if (typed === "" || at === undefined || seen.has(typed)) continue;
      seen.add(typed);
      words.push({ source: "collie", at, cwd: null, text: typed, run });
    }
  }
  return { entries, words, unread: unread.said() };
});

interface Gathered {
  readonly stores: ReadonlyArray<OwnStore>;
  readonly messages: ReadonlyArray<OwnMessage>;
  readonly skipped: number;
}

const notThere = (source: OwnSource, where: string): OwnStore => ({
  source,
  where,
  found: "missing",
  sessions: 0,
});

/** Each store, read for messages said `since` where it is given, or only counted where not. */
const gather = Effect.fn("OwnWords.gather")(function* (places: OwnPlaces, since: number | null) {
  const fs = yield* FileSystem.FileSystem;
  const recorded =
    since === null ? new Set<string>() : yield* recordedAgentSessions(places.stateDir);
  const stores: Array<OwnStore> = [];
  const messages: Array<OwnMessage> = [];
  let skipped = 0;
  const take = (source: OwnSource, session: Session, ids: ReadonlyArray<string>) => {
    if (session.delivered || Arr.some(ids, (id) => recorded.has(id))) {
      skipped += 1;
      return;
    }
    for (const { at, text } of session.said)
      if (since === null || epochMs(at) >= since)
        messages.push({ source, at, cwd: session.cwd, text });
  };

  for (const store of fileStores(places.home)) {
    if (!(yield* fs.exists(store.root).pipe(Effect.orElseSucceed(() => false)))) {
      stores.push(notThere(store.source, store.root));
      continue;
    }
    const listed = yield* fs.readDirectory(store.root, { recursive: true }).pipe(Effect.result);
    if (listed._tag === "Failure") {
      stores.push({
        ...notThere(store.source, store.root),
        found: "unreadable",
        why: String(listed.failure),
      });
      continue;
    }
    const files = Arr.filter(listed.success, store.isSession);
    const unread = new Unread();
    for (const relative of since === null ? [] : files) {
      const path = `${store.root}/${relative}`;
      // ponytail: a whole file is read at once; stream it if sessions outgrow memory.
      const modified = yield* fs.stat(path).pipe(
        Effect.map((info) => Option.getOrUndefined(info.mtime)),
        Effect.orElseSucceed(() => undefined),
      );
      if (modified !== undefined && since !== null && modified.getTime() < since) continue;
      const text = yield* fs.readFileString(path).pipe(Effect.result);
      const records =
        text._tag === "Failure" ? String(text.failure) : recordsOf(text.success, store.types);
      if (isString(records)) {
        unread.add(relative, records);
        continue;
      }
      const session = store.read(records, relative);
      take(store.source, session, [...session.ids, path]);
    }
    stores.push({
      source: store.source,
      where: store.root,
      found: "read",
      sessions: files.length,
      ...unread.said(),
    });
  }

  const openCode = openCodeFile(places.home);
  if (!(yield* fs.exists(openCode).pipe(Effect.orElseSucceed(() => false))))
    stores.push(notThere("opencode", openCode));
  else {
    const read = yield* openCodeStore(openCode, since).pipe(Effect.result);
    if (read._tag === "Failure")
      stores.push({ ...notThere("opencode", openCode), found: "unreadable", why: read.failure });
    else {
      stores.push({
        source: "opencode",
        where: openCode,
        found: "read",
        sessions: read.success.count,
      });
      for (const session of read.success.sessions) take("opencode", session, session.ids);
    }
  }

  const runs = `${places.stateDir}/runs`;
  const collie = yield* collieWords(places.stateDir, since !== null).pipe(Effect.result);
  if (collie._tag === "Failure")
    stores.push(
      (yield* fs.exists(runs).pipe(Effect.orElseSucceed(() => false)))
        ? { ...notThere("collie", runs), found: "unreadable", why: String(collie.failure) }
        : notThere("collie", runs),
    );
  else {
    stores.push({
      source: "collie",
      where: runs,
      found: "read",
      sessions: collie.success.entries,
      ...collie.success.unread,
    });
    for (const one of collie.success.words)
      if (since === null || epochMs(one.at) >= since) messages.push(one);
  }
  return { stores, messages, skipped } satisfies Gathered;
});

/** Where the human's words are and how many sessions hold them; no text. */
export const ownInventory = Effect.fn("OwnWords.inventory")(function* (places: OwnPlaces) {
  const { stores } = yield* gather(places, null);
  return { stores };
});

/** The human's typed messages, newest first, within the caps, saying what was left out. */
export const readOwnWords = Effect.fn("OwnWords.read")(function* (
  places: OwnPlaces,
  /** Epoch milliseconds. */
  now: number,
) {
  const since = now - DAYS * 24 * 60 * 60 * 1000;
  const gathered = yield* gather(places, since);
  const cutOnes = new Set<OwnMessage>();
  const { kept, leftOut } = withinCaps(
    Arr.map(gathered.messages, (message) => {
      const clean = redact(message.text);
      const one = { ...message, text: pipe(clean, Str.slice(0, MOST_IN_ONE)) };
      if (one.text !== clean) cutOnes.add(one);
      return one;
    }),
  );
  return {
    messages: kept,
    stores: gathered.stores,
    skipped: gathered.skipped,
    leftOut,
    cut: Arr.filter(kept, (one) => cutOnes.has(one)).length,
  } satisfies OwnWords;
});
