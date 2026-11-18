// What a Run's agents spent, request by request, as each harness recorded it (pure).
//
// Every harness keeps its own record of a session: Claude a transcript, Codex a rollout of
// events, Pi a session file, OpenCode what Collie's reporter writes of its events. Each is
// read here into the same rows. A row is one provider request, known by its request or
// message id, so a streamed record written several times, a resumed session that copies
// its history and a second read of the same lines all fold into one: each field keeps the
// largest value any copy reported. A category a harness does not report is null —
// unavailable — and never 0.
//
// Usage is data (invariant 8): nothing here is a budget.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Option, Order, Schema } from "effect";
import { epochMs } from "./time";
import type { Metric } from "./metrics";

/** A figure as the harness reported it, or null where it reports nothing of the kind. */
export const Count = Schema.NullOr(Schema.Finite);
export type Count = typeof Count.Type;

/** Output includes reasoning; uncached input excludes cache reads and cache creation. */
const CategoryFields = {
  input: Count,
  cacheRead: Count,
  cacheCreation: Count,
  output: Count,
  reasoning: Count,
};
type Categories = { readonly [K in keyof typeof CategoryFields]: Count };

/** A session's first request, by component, in characters; null where it cannot be separated. */
export const Startup = Schema.Struct({
  system: Count,
  persona: Count,
  project: Count,
  tools: Count,
  skills: Count,
});
export type Startup = typeof Startup.Type;

export const Happening = Schema.Literals(["compaction", "tool", "reminder", "repair"]);
export type Happening = typeof Happening.Type;

const Keys = {
  key: Schema.String,
  at: Schema.String,
  agent: Schema.String,
  /** The harness's own session: with the agent, which incarnation of it this was. */
  session: Schema.String,
  /** The session a sub-agent's work belongs to; null for the agent's own. */
  parent: Schema.NullOr(Schema.String),
  step: Schema.String,
};

/** One row of the ledger, as a `usage` metric line carries it. */
export const UsageEntry = Schema.Union([
  Schema.Struct({
    what: Schema.Literal("request"),
    ...Keys,
    harness: Schema.String,
    model: Schema.NullOr(Schema.String),
    effort: Schema.NullOr(Schema.String),
    head: Schema.NullOr(Schema.String),
    ...CategoryFields,
  }),
  Schema.Struct({ what: Happening, ...Keys, chars: Count }),
  Schema.Struct({
    what: Schema.Literal("session"),
    agent: Schema.String,
    session: Schema.String,
    harness: Schema.String,
    recovery: Schema.Boolean,
    startup: Startup,
  }),
]);
export type UsageEntry = typeof UsageEntry.Type;
type RequestEntry = Extract<UsageEntry, { what: "request" }>;
type HappeningEntry = Extract<UsageEntry, { what: Happening }>;
type SessionEntry = Extract<UsageEntry, { what: "session" }>;

export const Format = Schema.Literals(["claude", "codex", "pi", "opencode"]);
export type Format = typeof Format.Type;

/** A file a harness keeps a conversation in; `parent` is set for a sub-agent's. */
export const Source = Schema.Struct({
  path: Schema.String,
  format: Format,
  parent: Schema.NullOr(Schema.String),
});
export type Source = typeof Source.Type;

export interface Request extends Categories {
  readonly key: string;
  readonly at: number;
  readonly session: string;
  readonly parent: string | null;
  readonly model: string | null;
}

export interface Event {
  readonly what: Happening;
  readonly key: string;
  readonly at: number;
  readonly session: string;
  readonly parent: string | null;
  readonly chars: Count;
}

export interface Reading {
  readonly requests: ReadonlyArray<Request>;
  readonly events: ReadonlyArray<Event>;
  /** What each session's records show of its start-up, by session. */
  readonly startup: ReadonlyArray<{ readonly session: string; readonly startup: Partial<Startup> }>;
}

/** How Collie opens the reminder it sends a turn that ended without its Output. */
export const REMINDER_OPENING = "Your turn ended without writing your Output.";
/** How Collie opens the repair it sends an Output it could not use. */
export const REPAIR_OPENING = "Your Output file is not usable:";

const retryOf = (text: string): Happening | null =>
  Str.includes(REMINDER_OPENING)(text)
    ? "reminder"
    : Str.includes(REPAIR_OPENING)(text)
      ? "repair"
      : null;

const lines = (text: string) => Arr.filter(Str.split(text, "\n"), (line) => Str.trim(line) !== "");

const TextBlock = Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) });
const decodeText = Schema.decodeUnknownOption(
  Schema.Union([Schema.String, Schema.Array(TextBlock)]),
);

/** The characters of a content value: a string, or the text of each block. */
const charsOf = (content: Schema.Json): number | null =>
  Option.match(decodeText(content), {
    onNone: () => null,
    onSome: (text) =>
      Str.isString(text)
        ? text.length
        : Arr.reduce(text, 0, (sum, block) => sum + (block.text?.length ?? 0)),
  });

const textOf = (content: Schema.Json): string =>
  Option.match(decodeText(content), {
    onNone: () => "",
    onSome: (text) =>
      Str.isString(text)
        ? text
        : Arr.join(
            Arr.map(text, (block) => block.text ?? ""),
            "\n",
          ),
  });

const stemOf = (path: string) => Str.replace(/\.jsonl$/, "")(Str.split(path, "/").at(-1) ?? path);

const msOf = (iso: string | undefined) => (iso === undefined ? Number.NaN : epochMs(iso));

const ClaudeLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.String,
      subtype: Schema.optionalKey(Schema.String),
      uuid: Schema.optionalKey(Schema.String),
      sessionId: Schema.optionalKey(Schema.String),
      agentId: Schema.optionalKey(Schema.String),
      requestId: Schema.optionalKey(Schema.String),
      timestamp: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(
        Schema.Struct({
          id: Schema.optionalKey(Schema.String),
          model: Schema.optionalKey(Schema.String),
          content: Schema.optionalKey(Schema.Json),
          usage: Schema.optionalKey(
            Schema.Struct({
              input_tokens: Schema.optionalKey(Count),
              cache_creation_input_tokens: Schema.optionalKey(Count),
              cache_read_input_tokens: Schema.optionalKey(Count),
              output_tokens: Schema.optionalKey(Count),
              output_tokens_details: Schema.optionalKey(
                Schema.NullOr(Schema.Struct({ thinking_tokens: Schema.optionalKey(Count) })),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
);

const ToolResults = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      type: Schema.String,
      tool_use_id: Schema.optionalKey(Schema.String),
      content: Schema.optionalKey(Schema.Json),
    }),
  ),
);

/** A Claude transcript: the agent's own, or a sub-agent's file beside it. */
function readClaude(text: string, source: Source): Reading {
  const requests: Request[] = [];
  const events: Event[] = [];
  for (const line of lines(text)) {
    const decoded = ClaudeLine(line);
    if (Option.isNone(decoded)) continue;
    const one = decoded.value;
    const session =
      source.parent === null
        ? (one.sessionId ?? stemOf(source.path))
        : (one.agentId ?? stemOf(source.path));
    const at = msOf(one.timestamp);
    // A sub-agent's lines name the session that spawned it.
    const parent = source.parent === null ? null : (one.sessionId ?? source.parent);
    const usage = one.message?.usage;
    if (one.type === "assistant" && usage !== undefined && one.message?.model !== "<synthetic>") {
      requests.push({
        key: one.message?.id ?? one.requestId ?? one.uuid ?? line,
        at,
        session,
        parent,
        model: one.message?.model ?? null,
        input: usage.input_tokens ?? null,
        cacheRead: usage.cache_read_input_tokens ?? null,
        cacheCreation: usage.cache_creation_input_tokens ?? null,
        output: usage.output_tokens ?? null,
        reasoning: usage.output_tokens_details?.thinking_tokens ?? null,
      });
      continue;
    }
    const base = { at, session, parent };
    if (one.type === "system" && one.subtype === "compact_boundary") {
      events.push({ ...base, what: "compaction", key: one.uuid ?? line, chars: null });
      continue;
    }
    if (one.type !== "user") continue;
    const content = one.message?.content;
    const results = Option.getOrElse(ToolResults(content), () => []);
    for (const result of results) {
      if (result.type !== "tool_result") continue;
      events.push({
        ...base,
        what: "tool",
        key: result.tool_use_id ?? line,
        chars: charsOf(result.content ?? ""),
      });
    }
    const retry = retryOf(textOf(content ?? ""));
    if (retry !== null) events.push({ ...base, what: retry, key: one.uuid ?? line, chars: null });
  }
  return { requests, events, startup: [] };
}

const CodexLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      timestamp: Schema.optionalKey(Schema.String),
      type: Schema.String,
      payload: Schema.optionalKey(
        Schema.Struct({
          type: Schema.optionalKey(Schema.String),
          id: Schema.optionalKey(Schema.String),
          role: Schema.optionalKey(Schema.String),
          thread_id: Schema.optionalKey(Schema.String),
          session_id: Schema.optionalKey(Schema.String),
          response_id: Schema.optionalKey(Schema.String),
          call_id: Schema.optionalKey(Schema.String),
          model: Schema.optionalKey(Schema.String),
          base_instructions: Schema.optionalKey(
            Schema.NullOr(Schema.Union([Schema.String, Schema.Struct({ text: Schema.String })])),
          ),
          content: Schema.optionalKey(Schema.Json),
          output: Schema.optionalKey(Schema.Json),
          usage: Schema.optionalKey(
            Schema.Struct({
              input_tokens: Schema.Finite,
              cached_input_tokens: Schema.optionalKey(Schema.Finite),
              cache_write_input_tokens: Schema.optionalKey(Schema.Finite),
              output_tokens: Schema.Finite,
              reasoning_output_tokens: Schema.optionalKey(Schema.Finite),
            }),
          ),
        }),
      ),
    }),
  ),
);

const PROJECT_INSTRUCTIONS = "# AGENTS.md instructions";

const InputText = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })),
);

/**
 * A Codex rollout. Its `input_tokens` include the cached ones, and its output includes
 * reasoning; the system prompt, tool definitions and AGENTS.md are records of their own.
 */
function readCodex(text: string, source: Source): Reading {
  const requests: Request[] = [];
  const events: Event[] = [];
  const startup = new Map<string, Partial<Startup>>();
  let session = stemOf(source.path);
  const started = (patch: Partial<Startup>) =>
    startup.set(session, { ...startup.get(session), ...patch });
  for (const line of lines(text)) {
    const decoded = CodexLine(line);
    if (Option.isNone(decoded)) continue;
    const one = decoded.value;
    const payload = one.payload;
    const at = msOf(one.timestamp);
    if (one.type === "session_meta") {
      session = payload?.id ?? session;
      const base = payload?.base_instructions;
      if (base !== undefined && base !== null)
        started({ system: Str.isString(base) ? base.length : base.text.length });
      continue;
    }
    const base = { at, session, parent: source.parent };
    if (one.type === "compacted") {
      events.push({
        ...base,
        what: "compaction",
        key: `compacted:${one.timestamp ?? line}`,
        chars: null,
      });
      continue;
    }
    if (one.type === "token_usage_record" && payload?.usage !== undefined) {
      const usage = payload.usage;
      const cached = usage.cached_input_tokens ?? 0;
      const written = usage.cache_write_input_tokens ?? null;
      requests.push({
        key: payload.response_id ?? line,
        at,
        session: payload.thread_id ?? payload.session_id ?? session,
        parent: source.parent,
        model: payload.model ?? null,
        input: usage.input_tokens - cached - (written ?? 0),
        cacheRead: usage.cached_input_tokens ?? null,
        cacheCreation: written,
        output: usage.output_tokens,
        reasoning: usage.reasoning_output_tokens ?? null,
      });
      continue;
    }
    if (one.type !== "response_item" || payload === undefined) continue;
    if (payload.type === "additional_tools") {
      started({ tools: line.length });
    } else if (
      payload.type === "function_call_output" ||
      payload.type === "custom_tool_call_output"
    ) {
      events.push({
        ...base,
        what: "tool",
        key: payload.call_id ?? line,
        chars: Str.isString(payload.output) ? payload.output.length : line.length,
      });
    } else if (payload.type === "message" && payload.role === "user") {
      const said = Arr.join(
        Arr.map(
          Option.getOrElse(InputText(payload.content), () => []),
          (part) => part.text ?? "",
        ),
        "\n",
      );
      if (Str.startsWith(PROJECT_INSTRUCTIONS)(said)) started({ project: said.length });
      const retry = retryOf(said);
      if (retry !== null)
        events.push({
          ...base,
          what: retry,
          key: payload.id ?? `${one.timestamp}:${retry}`,
          chars: null,
        });
    }
  }
  return {
    requests,
    events,
    startup: Arr.map([...startup], ([one, found]) => ({ session: one, startup: found })),
  };
}

const PiLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.String,
      id: Schema.optionalKey(Schema.String),
      timestamp: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(
        Schema.Struct({
          role: Schema.String,
          model: Schema.optionalKey(Schema.String),
          responseId: Schema.optionalKey(Schema.String),
          toolCallId: Schema.optionalKey(Schema.String),
          content: Schema.optionalKey(Schema.Json),
          usage: Schema.optionalKey(
            Schema.Struct({
              input: Schema.Finite,
              output: Schema.Finite,
              cacheRead: Schema.optionalKey(Schema.Finite),
              cacheWrite: Schema.optionalKey(Schema.Finite),
              reasoning: Schema.optionalKey(Schema.Finite),
            }),
          ),
        }),
      ),
    }),
  ),
);

/**
 * A Pi session file, one per session. Its input excludes both caches, and its output
 * includes reasoning. A resumed or forked session copies entries, which keep their
 * response id.
 */
function readPi(text: string, source: Source): Reading {
  const requests: Request[] = [];
  const events: Event[] = [];
  const session = stemOf(source.path);
  for (const line of lines(text)) {
    const decoded = PiLine(line);
    if (Option.isNone(decoded)) continue;
    const one = decoded.value;
    const base = { at: msOf(one.timestamp), session, parent: source.parent };
    if (one.type === "compaction") {
      events.push({ ...base, what: "compaction", key: one.id ?? line, chars: null });
      continue;
    }
    const message = one.message;
    if (one.type !== "message" || message === undefined) continue;
    if (message.role === "assistant" && message.usage !== undefined) {
      const usage = message.usage;
      requests.push({
        ...base,
        key: message.responseId ?? one.id ?? line,
        model: message.model ?? null,
        input: usage.input,
        cacheRead: usage.cacheRead ?? null,
        cacheCreation: usage.cacheWrite ?? null,
        output: usage.output,
        reasoning: usage.reasoning ?? null,
      });
    } else if (message.role === "toolResult") {
      events.push({
        ...base,
        what: "tool",
        key: message.toolCallId ?? one.id ?? line,
        chars: charsOf(message.content ?? ""),
      });
    } else if (message.role === "user") {
      const retry = retryOf(textOf(message.content ?? ""));
      if (retry !== null) events.push({ ...base, what: retry, key: one.id ?? line, chars: null });
    }
  }
  return { requests, events, startup: [] };
}

const OpenCodeLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.String,
      parent: Schema.optionalKey(Schema.NullOr(Schema.String)),
      role: Schema.optionalKey(Schema.String),
      /** A completed tool part's output, in characters. */
      chars: Schema.optionalKey(Schema.Finite),
      info: Schema.optionalKey(
        Schema.Struct({
          id: Schema.String,
          sessionID: Schema.String,
          role: Schema.String,
          modelID: Schema.optionalKey(Schema.NullOr(Schema.String)),
          mode: Schema.optionalKey(Schema.NullOr(Schema.String)),
          summary: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
          time: Schema.optionalKey(Schema.Struct({ created: Schema.optionalKey(Schema.Finite) })),
          tokens: Schema.optionalKey(
            Schema.NullOr(
              Schema.Struct({
                input: Schema.Finite,
                output: Schema.Finite,
                reasoning: Schema.optionalKey(Schema.Finite),
                cache: Schema.optionalKey(
                  Schema.Struct({ read: Schema.Finite, write: Schema.Finite }),
                ),
              }),
            ),
          ),
        }),
      ),
      part: Schema.optionalKey(
        Schema.Struct({
          id: Schema.String,
          sessionID: Schema.String,
          type: Schema.String,
          callID: Schema.optionalKey(Schema.String),
          text: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
);

/**
 * What Collie's OpenCode reporter wrote of the server's events. OpenCode's output leaves
 * reasoning out, so output here is the two added; a sub-agent's session names its parent.
 */
function readOpenCode(text: string): Reading {
  const requests: Request[] = [];
  const events: Event[] = [];
  for (const line of lines(text)) {
    const decoded = OpenCodeLine(line);
    if (Option.isNone(decoded)) continue;
    const one = decoded.value;
    const parent = one.parent ?? null;
    const info = one.info;
    if (one.type === "message" && info !== undefined && info.role === "assistant") {
      const base = { at: info.time?.created ?? Number.NaN, session: info.sessionID, parent };
      if (info.summary === true || info.mode === "compaction")
        events.push({ ...base, what: "compaction", key: info.id, chars: null });
      const tokens = info.tokens;
      if (tokens === undefined || tokens === null) continue;
      const reasoning = tokens.reasoning ?? null;
      requests.push({
        ...base,
        key: info.id,
        model: info.modelID ?? null,
        input: tokens.input,
        cacheRead: tokens.cache?.read ?? null,
        cacheCreation: tokens.cache?.write ?? null,
        output: tokens.output + (reasoning ?? 0),
        reasoning,
      });
      continue;
    }
    const part = one.part;
    if (one.type !== "part" || part === undefined) continue;
    const base = { at: Number.NaN, session: part.sessionID, parent };
    if (part.type === "tool")
      events.push({ ...base, what: "tool", key: part.callID ?? part.id, chars: one.chars ?? null });
    else if (part.type === "text" && one.role === "user") {
      const retry = retryOf(part.text ?? "");
      if (retry !== null) events.push({ ...base, what: retry, key: part.id, chars: null });
    }
  }
  return { requests, events, startup: [] };
}

/** One source's new lines, read by its harness's own reader. */
export const readSource = (source: Source, text: string): Reading => {
  switch (source.format) {
    case "claude":
      return readClaude(text, source);
    case "codex":
      return readCodex(text, source);
    case "pi":
      return readPi(text, source);
    case "opencode":
      return readOpenCode(text);
  }
};

/** Null only where neither reported anything. */
const plus = (a: Count, b: Count): Count => (a === null ? b : b === null ? a : a + b);
const larger = (a: Count, b: Count): Count => (a === null ? b : b === null ? a : Math.max(a, b));

/** One request's context: everything it was sent, cached or not. */
export const contextOf = (one: Categories): Count =>
  plus(plus(one.input, one.cacheRead), one.cacheCreation);

/** The largest each field any copy of a request reported, keeping where it was first seen. */
const mergeRequest = (kept: RequestEntry, more: RequestEntry): RequestEntry => ({
  ...kept,
  input: larger(kept.input, more.input),
  cacheRead: larger(kept.cacheRead, more.cacheRead),
  cacheCreation: larger(kept.cacheCreation, more.cacheCreation),
  output: larger(kept.output, more.output),
  reasoning: larger(kept.reasoning, more.reasoning),
  model: kept.model ?? more.model,
});

export interface Ledger {
  readonly requests: ReadonlyMap<string, RequestEntry>;
  readonly happenings: ReadonlyMap<string, HappeningEntry>;
  readonly sessions: ReadonlyMap<string, SessionEntry>;
}

export const happeningKey = (one: { readonly what: string; readonly key: string }) =>
  `${one.what}:${one.key}`;
export const sessionKey = (one: { readonly agent: string; readonly session: string }) =>
  `${one.agent}\u0000${one.session}`;

/** The ledger as its rows fold: one request per id, one happening per id, one row per session. */
export function ledgerOf(entries: ReadonlyArray<UsageEntry>): Ledger {
  const requests = new Map<string, RequestEntry>();
  const happenings = new Map<string, HappeningEntry>();
  const sessions = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (entry.what === "request") {
      const kept = requests.get(entry.key);
      requests.set(entry.key, kept === undefined ? entry : mergeRequest(kept, entry));
    } else if (entry.what === "session") {
      const kept = sessions.get(sessionKey(entry));
      sessions.set(
        sessionKey(entry),
        kept === undefined ? entry : { ...kept, recovery: kept.recovery || entry.recovery },
      );
    } else {
      const kept = happenings.get(happeningKey(entry));
      happenings.set(
        happeningKey(entry),
        kept === undefined ? entry : { ...kept, chars: larger(kept.chars, entry.chars) },
      );
    }
  }
  return { requests, happenings, sessions };
}

/** Whether a newly read row adds anything to what the ledger already holds. */
export function adds(ledger: Ledger, entry: UsageEntry): boolean {
  if (entry.what === "session") {
    const kept = ledger.sessions.get(sessionKey(entry));
    return kept === undefined || (entry.recovery && !kept.recovery);
  }
  if (entry.what === "request") {
    const kept = ledger.requests.get(entry.key);
    if (kept === undefined) return true;
    const merged = mergeRequest(kept, entry);
    return Arr.some(
      ["input", "cacheRead", "cacheCreation", "output", "reasoning"] as const,
      (field) => merged[field] !== kept[field],
    );
  }
  const kept = ledger.happenings.get(happeningKey(entry));
  return kept === undefined || larger(kept.chars, entry.chars) !== kept.chars;
}

export interface Tally extends Categories {
  readonly requests: number;
}

const NO_COUNT: Count = null;

const NOTHING: Tally = {
  requests: 0,
  input: null,
  cacheRead: null,
  cacheCreation: null,
  output: null,
  reasoning: null,
};

const tally = (rows: ReadonlyArray<Categories>): Tally =>
  Arr.reduce(rows, NOTHING, (sum, one) => ({
    requests: sum.requests + 1,
    input: plus(sum.input, one.input),
    cacheRead: plus(sum.cacheRead, one.cacheRead),
    cacheCreation: plus(sum.cacheCreation, one.cacheCreation),
    output: plus(sum.output, one.output),
    reasoning: plus(sum.reasoning, one.reasoning),
  }));

const sum = (a: Tally, b: Tally): Tally => ({
  requests: a.requests + b.requests,
  input: plus(a.input, b.input),
  cacheRead: plus(a.cacheRead, b.cacheRead),
  cacheCreation: plus(a.cacheCreation, b.cacheCreation),
  output: plus(a.output, b.output),
  reasoning: plus(a.reasoning, b.reasoning),
});

/** A Run's usage with what its child Runs spent: each listed, and all added to its own. */
export const withChildren = (
  own: Usage,
  children: ReadonlyArray<{ readonly runId: string; readonly usage: Usage }>,
): Usage => ({
  ...own,
  children: Arr.map(children, ({ runId, usage }) => ({ runId, ...usage.totals })),
  withChildren: Arr.reduce(children, own.totals, (total, { usage }) => sum(total, usage.totals)),
});

/** Each value of `by` and what its requests spent, in the order first seen. */
const grouped = (rows: ReadonlyArray<RequestEntry>, by: (one: RequestEntry) => string) => {
  const groups = new Map<string, RequestEntry[]>();
  for (const one of rows) groups.set(by(one), [...(groups.get(by(one)) ?? []), one]);
  return Arr.map([...groups], ([value, members]) => [value, tally(members)] as const);
};

export interface SessionUsage extends Tally {
  readonly agent: string;
  readonly session: string;
  readonly harness: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  /** A Heal's session, or one whose first prompt was a repair. */
  readonly recovery: boolean;
  readonly initialContext: Count;
  readonly peakContext: Count;
  readonly compactions: number;
  readonly toolResultChars: number;
  readonly reminders: number;
  readonly repairs: number;
  readonly startup: Startup | null;
  readonly subagents: ReadonlyArray<{ readonly session: string } & Tally>;
}

export interface Usage {
  readonly totals: Tally;
  /** What recovery sessions spent. */
  readonly recovery: Tally;
  readonly steps: ReadonlyArray<{ readonly step: string } & Tally>;
  readonly heads: ReadonlyArray<{ readonly head: string } & Tally>;
  readonly sessions: ReadonlyArray<SessionUsage>;
  /** Each review round, with the context of the Run's last request before it started. */
  readonly rounds: ReadonlyArray<{
    readonly round: string;
    readonly at: string;
    readonly context: Count;
  }>;
  /** Each Run this one started, and those started under them, by what they spent. */
  readonly children?: ReadonlyArray<{ readonly runId: string } & Tally>;
  /** `totals` with every child Run's added. */
  readonly withChildren?: Tally;
}

const byTime = <A extends { readonly at: string }>(rows: ReadonlyArray<A>) =>
  Arr.sortWith(rows, (one) => epochMs(one.at), Order.Number);

/** A Run's usage as `run metrics` shows it, from its metric lines. */
export function usageOf(lines: ReadonlyArray<Metric>): Usage {
  const ledger = ledgerOf(Arr.getSomes(Arr.map(lines, (line) => Option.fromNullishOr(line.usage))));
  const requests = byTime([...ledger.requests.values()]);
  const happenings = [...ledger.happenings.values()];
  const own = Arr.filter(requests, (one) => one.parent === null);
  const keys = new Map<string, { readonly agent: string; readonly session: string }>();
  for (const one of own) keys.set(sessionKey(one), { agent: one.agent, session: one.session });
  for (const one of ledger.sessions.values()) keys.set(sessionKey(one), one);
  const sessions = Arr.map([...keys.values()], (at): SessionUsage => {
    const mine = Arr.filter(own, (one) => sessionKey(one) === sessionKey(at));
    const happened = Arr.filter(
      happenings,
      (one) => one.parent === null && sessionKey(one) === sessionKey(at),
    );
    const count = (what: Happening) => Arr.filter(happened, (one) => one.what === what).length;
    const first = mine[0];
    const recorded = ledger.sessions.get(sessionKey(at));
    const openedByRepair =
      first !== undefined &&
      Arr.some(happened, (one) => one.what === "repair" && epochMs(one.at) <= epochMs(first.at));
    const subs = Arr.filter(requests, (one) => one.parent === at.session && one.agent === at.agent);
    return {
      agent: at.agent,
      session: at.session,
      harness: first?.harness ?? recorded?.harness ?? null,
      model: first?.model ?? null,
      effort: first?.effort ?? null,
      recovery: (recorded?.recovery ?? false) || openedByRepair,
      ...tally(mine),
      initialContext: first === undefined ? null : contextOf(first),
      peakContext: Arr.reduce(mine, NO_COUNT, (peak, one) => larger(peak, contextOf(one))),
      compactions: count("compaction"),
      toolResultChars: Arr.reduce(
        Arr.filter(happened, (one) => one.what === "tool"),
        0,
        (sum, one) => sum + (one.chars ?? 0),
      ),
      reminders: count("reminder"),
      repairs: count("repair"),
      startup: recorded?.startup ?? null,
      subagents: Arr.map(
        grouped(subs, (one) => one.session),
        ([session, spent]) => ({
          session,
          ...spent,
        }),
      ),
    };
  });
  const recovering = new Set(
    Arr.map(
      Arr.filter(sessions, (one) => one.recovery),
      (one) => one.session,
    ),
  );
  const rounds = Arr.map(
    Arr.filter(lines, (line) => line.kind === "round"),
    (line) => {
      const before = Arr.filter(own, (one) => epochMs(one.at) <= epochMs(line.at)).at(-1);
      return {
        round: line.subject,
        at: line.at,
        context: before === undefined ? null : contextOf(before),
      };
    },
  );
  return {
    totals: tally(requests),
    recovery: tally(Arr.filter(requests, (one) => recovering.has(one.parent ?? one.session))),
    steps: Arr.map(
      grouped(requests, (one) => one.step),
      ([step, spent]) => ({ step, ...spent }),
    ),
    heads: Arr.map(
      grouped(
        Arr.filter(requests, (one) => one.head !== null),
        (one) => one.head ?? "",
      ),
      ([head, spent]) => ({ head, ...spent }),
    ),
    sessions,
    rounds,
  };
}

const said = (value: Count) => (value === null ? "unavailable" : String(value));

const tallyLine = (one: Tally) =>
  `${one.requests} requests: output ${said(one.output)} (reasoning ${said(one.reasoning)} of it), cache read ${said(one.cacheRead)}, cache creation ${said(one.cacheCreation)}, uncached input ${said(one.input)}`;

const startupLine = (startup: Startup) =>
  `start-up, in characters: system ${said(startup.system)}, persona ${said(startup.persona)}, project ${said(startup.project)}, tools ${said(startup.tools)}, skills ${said(startup.skills)}`;

/** A Run's usage in the words `run metrics` and `collie_run` both print. */
export function usageLines(usage: Usage): ReadonlyArray<string> {
  if (
    usage.totals.requests === 0 &&
    usage.sessions.length === 0 &&
    (usage.children ?? []).length === 0
  )
    return [`rounds: ${usage.rounds.length}`, "tokens: nothing recorded"];
  return [
    `rounds: ${usage.rounds.length}`,
    `tokens: ${tallyLine(usage.totals)}`,
    `  recovery: ${tallyLine(usage.recovery)}`,
    ...Arr.map(usage.steps, (one) => `  step ${one.step}: ${tallyLine(one)}`),
    ...Arr.flatMap(usage.sessions, (one) => [
      `  agent ${one.agent} session ${one.session}${one.recovery ? " (recovery)" : ""}: ${tallyLine(one)}`,
      `    context: first ${said(one.initialContext)}, peak ${said(one.peakContext)}; ${one.compactions} compactions, ${one.toolResultChars} characters of tool results, ${one.reminders} reminders, ${one.repairs} repairs`,
      ...(one.startup === null ? [] : [`    ${startupLine(one.startup)}`]),
      ...Arr.map(one.subagents, (sub) => `    sub-agent ${sub.session}: ${tallyLine(sub)}`),
    ]),
    ...Arr.map(usage.children ?? [], (child) => `  child Run ${child.runId}: ${tallyLine(child)}`),
    ...(usage.withChildren === undefined || (usage.children ?? []).length === 0
      ? []
      : [`tokens with child Runs: ${tallyLine(usage.withChildren)}`]),
  ];
}
