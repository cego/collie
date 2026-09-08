// OpenCode's local server, as a client. The agent's own ordinary TUI hosts that server
// on a loopback port Collie picked, so the endpoint lives exactly as long as the agent
// does — the agent is the process serving it.
//
// Checked against the installed 1.18.9, and three of the checks decided the design:
//
//   - Its servers isolate nothing. Every one answers `GET /session` with every session
//     in the project, and `/session/status` and `/api/session/active` are empty unless
//     a session is mid-turn, so nothing here can say which of a project's sessions is
//     this agent's. Collie creates the session itself and hands it over with
//     `--session`; see `createSession`.
//   - `serve` + `attach` would let Collie own the server for the agent's whole life,
//     but `attach` takes neither `--model` nor `--auto`, and a Collie-launched agent
//     may not lose its model or its unattended switch to buy a tidier topology.
//   - The v2 `POST /api/session/{id}/compact` answers 503 "Session compact is not
//     available yet" on this release. `POST /session/{id}/summarize` is the endpoint
//     that works, and it needs the model to summarize with.

import { Data, Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { reason } from "./naming";

export class OpenCodeError extends Data.TaggedError("OpenCodeError")<{
  readonly message: string;
}> {}

const failed = (message: string) => new OpenCodeError({ message });

/** How long one request may take. Summarizing is a model call, so it is not short. */
const READ_MS = 15_000;
const SUMMARIZE_MS = 5 * 60 * 1000;

const Session = Schema.Struct({
  id: Schema.String,
  directory: Schema.optionalKey(Schema.String),
});

/**
 * One message as the server reports it. `tokens` carries the accounting OpenCode's own
 * overflow predicate reads, and `mode` is what tells a compaction's own message from
 * the agent's — the one thing that makes a pre-compaction sample recognisably stale.
 */
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
          total: Schema.optionalKey(Schema.Number),
          input: Schema.Number,
          output: Schema.Number,
          reasoning: Schema.Number,
          cache: Schema.Struct({ read: Schema.Number, write: Schema.Number }),
        }),
      ),
    ),
  }),
});
const Messages = Schema.Array(Message);
export interface OpenCodeMessage extends Schema.Schema.Type<typeof Message> {}

/** The mode of the assistant message a compaction writes for itself. */
export const COMPACTION_MODE = "compaction";

/**
 * One response body against its schema. `send` has already parsed the transport into
 * JSON; this is where that JSON becomes the domain values the rest of the file reads.
 */
const decode = <S extends Schema.Top>(
  what: string,
  schema: S,
  value: Schema.Schema.Type<typeof Schema.Json>,
) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => failed(`${what}: ${String(cause)}`)),
  );

/**
 * One request, through Effect's own client. Non-2xx is a failure with the body in it:
 * a summarize that answered 503 is a request that did not happen, and a boundary has
 * to be able to say which of those it met.
 */
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
    const body = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")));
    return yield* Effect.fail(failed(`${what} answered ${response.status}: ${body.slice(0, 200)}`));
  }
  return yield* response.json.pipe(Effect.mapError((cause) => failed(`${what}: ${reason(cause)}`)));
}, Effect.provide(FetchHttpClient.layer));

/**
 * Creates the session this agent will work in, and returns its id.
 *
 * Collie creates it rather than finding it, because on 1.18.9 there is nothing to find
 * it by. Every server answers `GET /session` with every session in the project — two
 * servers on two ports in one directory list the same set, and `/session/status` and
 * `/api/session/active` are empty unless a session is mid-turn. So a port isolates
 * nothing, and two agents in one directory could not be told apart from the API. A
 * session Collie made and recorded is unambiguous, and `--session` is what hands it to
 * the agent's own TUI.
 */
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

/**
 * Checks that the recorded session is still there and still this agent's directory.
 * Cheap, and the difference between a stale record and a context Collie can vouch for.
 */
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
    return yield* Effect.fail(
      failed(`session ${session} is working in ${found.directory}, not ${cwd}`),
    );
  }
});

/** Every message on the bound session, oldest first, as the server orders them. */
export const messages = Effect.fn("OpenCode.messages")(function* (base: string, session: string) {
  const what = `GET /session/${session}/message`;
  return yield* decode(
    what,
    Messages,
    yield* send(what, HttpClientRequest.get(`${base}/session/${session}/message`)),
  );
});

/**
 * The current context, by the accounting OpenCode's own overflow predicate uses:
 * `tokens.total` where the provider reported one, and otherwise input plus output plus
 * both cache components. `reasoning` is deliberately not added — the native predicate
 * does not add it, and this is meant to be the same number it compares.
 */
export function contextTokens(message: OpenCodeMessage): number | null {
  const tokens = message.info.tokens;
  if (!tokens) return null;
  return tokens.total ?? tokens.input + tokens.output + tokens.cache.read + tokens.cache.write;
}

/**
 * The sample to threshold, or null where there is none to be had. Null after a
 * compaction on purpose: the newest assistant message is then the compaction's own,
 * whose tokens are the summarizing request's rather than the rebuilt context's, and
 * the agent's last real message describes a context that no longer exists. Rechecked
 * at the next boundary, once a real turn has measured the new one.
 *
 * A message still being written is skipped rather than treated as the answer: it has
 * measured nothing yet, and OpenCode's own overflow predicate runs on a turn that has
 * finished. A boundary lands the moment a step's output file appears, which is while
 * OpenCode is usually still closing its last message, so reading the newest message
 * alone made every OpenCode boundary an unavailable sample.
 */
export function currentContext(all: ReadonlyArray<OpenCodeMessage>): number | null {
  for (const message of [...all].reverse()) {
    if (message.info.role !== "assistant") continue;
    if (message.info.mode === COMPACTION_MODE) return null;
    if (!message.info.finish) continue;
    return contextTokens(message);
  }
  return null;
}

/** The model the session is working with, which is what summarizing has to be asked in. */
export function sessionModel(
  all: ReadonlyArray<OpenCodeMessage>,
): { providerID: string; modelID: string } | null {
  for (const message of [...all].reverse()) {
    const { providerID, modelID } = message.info;
    if (providerID && modelID) return { providerID, modelID };
  }
  return null;
}

/**
 * Asks the session to summarize itself. A 200 is not proof of compaction: the handler
 * returns a bare `true` after its own loop, and says nothing about what the loop did.
 * What became of it is read back off the session's messages.
 */
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

/**
 * What a compaction that was not there before has become. Its own message is the
 * evidence — a bare 200 and an idle session are not — and the documented error state
 * on that message is the terminal failure, including a context too large to compact.
 */
export function compactionAfter(
  all: ReadonlyArray<OpenCodeMessage>,
  before: ReadonlySet<string>,
): CompactionState {
  const mine = all
    .filter((message) => message.info.mode === COMPACTION_MODE && !before.has(message.info.id))
    .at(-1);
  if (!mine) return { kind: "none" };
  const { id, error, finish } = mine.info;
  if (error !== undefined && error !== null) {
    return { kind: "failed", id, reason: describe(error) };
  }
  if (finish === "error") return { kind: "failed", id, reason: "the compaction finished in error" };
  // Still being written: it has neither finished nor failed, so nothing is established.
  if (!finish) return { kind: "none" };
  return { kind: "done", id };
}

/** What every one of the documented message errors carries: a name and a message. */
const MessageError = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) })),
});
const decodeMessageError = Schema.decodeUnknownOption(MessageError);

/** What a message's error says, as a line a human can read off the Run. */
function describe(error: OpenCodeMessage["info"]["error"]): string {
  const named = decodeMessageError(error);
  if (named._tag === "None") return "the compaction reported an error";
  return named.value.data?.message ?? named.value.name ?? "the compaction reported an error";
}

/** Every compaction this session already has, by message id. */
export function compactionIds(all: ReadonlyArray<OpenCodeMessage>): string[] {
  return all
    .filter((message) => message.info.mode === COMPACTION_MODE)
    .map((message) => message.info.id);
}
