// WARNING: OpenCode's servers isolate nothing, so Collie creates the session and hands it over with --session.
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { Data, Effect, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { reason } from "./naming";

export class OpenCodeError extends Data.TaggedError("OpenCodeError")<{
  readonly message: string;
}> {}

const failed = (message: string) => new OpenCodeError({ message });

const READ_MS = 15_000;
const SUMMARIZE_MS = 5 * 60 * 1000;

const Session = Schema.Struct({
  id: Schema.String,
  directory: Schema.optionalKey(Schema.String),
});

const Message = Schema.Struct({
  info: Schema.Struct({
    id: Schema.String,
    role: Schema.String,
    mode: Schema.optionalKey(Schema.NullOr(Schema.String)),
    finish: Schema.optionalKey(Schema.NullOr(Schema.String)),
    providerID: Schema.optionalKey(Schema.NullOr(Schema.String)),
    modelID: Schema.optionalKey(Schema.NullOr(Schema.String)),
    error: Schema.optionalKey(Schema.Unknown),
    tokens: Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({
          total: Schema.optionalKey(Schema.Finite),
          input: Schema.Finite,
          output: Schema.Finite,
          reasoning: Schema.Finite,
          cache: Schema.Struct({ read: Schema.Finite, write: Schema.Finite }),
        }),
      ),
    ),
  }),
});
const Messages = Schema.Array(Message);
export interface OpenCodeMessage extends Schema.Schema.Type<typeof Message> {}

export const COMPACTION_MODE = "compaction";

const decode = <S extends Schema.Top>(
  what: string,
  schema: S,
  value: Schema.Schema.Type<typeof Schema.Json>,
) =>
  Schema.decodeEffect(schema)(value).pipe(
    Effect.mapError((cause) => failed(`${what}: ${String(cause)}`)),
  );

// WARNING: non-2xx fails with the body: a summarize that answered 503 is a request that did not happen.
const send = Effect.fn("OpenCode.send")(function* (
  what: string,
  request: HttpClientRequest.HttpClientRequest,
  timeoutMs = READ_MS,
) {
  const response = yield* HttpClient.execute(request).pipe(
    Effect.timeout(timeoutMs),
    Effect.mapError((cause) =>
      cause._tag === "TimeoutError"
        ? failed(`${what} was not answered within ${timeoutMs}ms`)
        : failed(`${what}: ${reason(cause)}`),
    ),
  );
  if (response.status < 200 || response.status >= 300) {
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* failed(`${what} answered ${response.status}: ${pipe_(body, Str.slice(0, 200))}`);
  }
  if (response.status === 204) {
    return null;
  }
  return yield* response.json.pipe(Effect.mapError((cause) => failed(`${what}: ${reason(cause)}`)));
}, Effect.provide(FetchHttpClient.layer));

// WARNING: created, not found: no server tells sessions apart by directory or port.
export const createSession = Effect.fn("OpenCode.createSession")(function* (base: string) {
  const created = yield* decode(
    "POST /session",
    Session,
    yield* send(
      "POST /session",
      HttpClientRequest.post(`${base}/session`).pipe(HttpClientRequest.bodyJsonUnsafe({})),
    ),
  );
  return created.id;
});

export const sessionIsHere = Effect.fn("OpenCode.sessionIsHere")(function* (
  base: string,
  session: string,
  cwd: string,
) {
  const what = `GET /session/${session}`;
  const found = yield* decode(
    what,
    Session,
    yield* send(what, HttpClientRequest.get(`${base}/session/${session}`)),
  );
  if (found.directory !== undefined && found.directory !== cwd) {
    return yield* failed(`session ${session} is working in ${found.directory}, not ${cwd}`);
  }
});

export const messages = Effect.fn("OpenCode.messages")(function* (base: string, session: string) {
  const what = `GET /session/${session}/message`;
  return yield* decode(
    what,
    Messages,
    yield* send(what, HttpClientRequest.get(`${base}/session/${session}/message`)),
  );
});

// WARNING: reasoning tokens are left out on purpose, as OpenCode's own overflow predicate leaves them out.
export function contextTokens(message: OpenCodeMessage) {
  const tokens = message.info.tokens;
  if (!tokens) {
    return null;
  }
  return tokens.total ?? tokens.input + tokens.output + tokens.cache.read + tokens.cache.write;
}

// WARNING: null after a compaction, and unfinished messages are skipped: the newest then measures nothing of the rebuilt context.
export function currentContext(all: ReadonlyArray<OpenCodeMessage>) {
  for (const message of [...all].reverse()) {
    if (message.info.role !== "assistant") {
      continue;
    }
    if (message.info.mode === COMPACTION_MODE) {
      return null;
    }
    if (!message.info.finish) {
      continue;
    }
    return contextTokens(message);
  }
  return null;
}

export function sessionModel(all: ReadonlyArray<OpenCodeMessage>) {
  for (const message of [...all].reverse()) {
    const { providerID, modelID } = message.info;
    if (providerID && modelID) {
      return { providerID, modelID };
    }
  }
  return null;
}

// WARNING: prompts go through the server: keys typed before the agent's TUI serves are lost.
export const promptAsync = Effect.fn("OpenCode.promptAsync")(function* (
  base: string,
  session: string,
  text: string,
) {
  const what = `POST /session/${session}/prompt_async`;
  yield* send(
    what,
    HttpClientRequest.post(`${base}/session/${session}/prompt_async`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ parts: [{ type: "text", text }] }),
    ),
  );
});

// WARNING: a 200 is not proof of compaction: the handler returns a bare true, so the outcome is read back off the messages.
export const summarize = Effect.fn("OpenCode.summarize")(function* (
  base: string,
  session: string,
  model: { providerID: string; modelID: string },
) {
  const what = `POST /session/${session}/summarize`;
  yield* send(
    what,
    HttpClientRequest.post(`${base}/session/${session}/summarize`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        providerID: model.providerID,
        modelID: model.modelID,
      }),
    ),
    SUMMARIZE_MS,
  );
});

export type CompactionState =
  | { readonly kind: "none" }
  | { readonly kind: "done"; readonly id: string }
  | { readonly kind: "failed"; readonly id: string; readonly reason: string };

export function compactionAfter(all: ReadonlyArray<OpenCodeMessage>, before: ReadonlySet<string>) {
  const mine = Arr.filter(
    all,
    (message) => message.info.mode === COMPACTION_MODE && !before.has(message.info.id),
  ).at(-1);
  if (!mine) {
    const returned: CompactionState = { kind: "none" };
    return returned;
  }
  const { id, error, finish } = mine.info;
  if (error !== undefined && error !== null) {
    const returned: CompactionState = { kind: "failed", id, reason: describe(error) };
    return returned;
  }
  if (finish === "error") {
    const returned: CompactionState = {
      kind: "failed",
      id,
      reason: "the compaction finished in error",
    };
    return returned;
  }
  if (!finish) {
    const returned: CompactionState = { kind: "none" };
    return returned;
  }
  const returned: CompactionState = { kind: "done", id };
  return returned;
}

const MessageError = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) })),
});
const decodeMessageError = Schema.decodeUnknownOption(MessageError);

function describe(error: OpenCodeMessage["info"]["error"]) {
  const named = decodeMessageError(error);
  if (named._tag === "None") {
    return "the compaction reported an error";
  }
  return named.value.data?.message ?? named.value.name ?? "the compaction reported an error";
}

export function compactionIds(all: ReadonlyArray<OpenCodeMessage>) {
  return Arr.map(
    Arr.filter(all, (message) => message.info.mode === COMPACTION_MODE),
    (message) => message.info.id,
  );
}
