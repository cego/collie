import { Effect, FileSystem, Option, Schema } from "effect";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { mrId, mrTarget, readMrRef, type MrRef } from "./board-model";
import { slackApi, slackMessageRef } from "./slack";
import { epochMs } from "./time";

const Correlation = Schema.Union([
  Schema.Struct({ channel: Schema.String, ts: Schema.String }),
  Schema.Struct({ why: Schema.String }),
]);
const State = Schema.Struct({
  wanted: Schema.Array(Schema.String),
  message: Schema.optionalKey(Correlation),
});
const StateJson = Schema.fromJsonString(State);

export const mergeRequestsInSlack = (text: string) => {
  const found = new Map<string, MrRef>();
  for (const match of Str.matchAll(/https?:\/\/[^\s<>|)]+/g)(text)) {
    const ref = readMrRef(match[0]);
    const id = mrId(match[0]);
    if (ref !== null && id !== null) found.set(id, ref);
  }
  return [...found.values()];
};

export const targetFromSlack = (link: string, api: ReturnType<typeof slackApi>, target?: string) =>
  Effect.gen(function* () {
    const message = slackMessageRef(link);
    if (message === null) return yield* Effect.fail("not a Slack message permalink");
    const got = yield* api.message(message.channel, message.ts);
    const refs = mergeRequestsInSlack(got.text);
    const ref = refs[0];
    if (refs.length !== 1 || ref?.project == null)
      return yield* Effect.fail("the Slack message must link exactly one merge request");
    const resolved = mrTarget(ref.project, ref.iid);
    if (target !== undefined && mrId(target) !== mrId(resolved))
      return yield* Effect.fail("the Slack message does not link this merge request");
    return resolved;
  });

export const reconcileReviewSlack = (options: {
  readonly file: string;
  readonly url: string;
  readonly created: Effect.Effect<string, string>;
  readonly permalink?: string;
  readonly wanted: ReadonlyArray<string>;
  readonly api: Effect.Effect<ReturnType<typeof slackApi>, string, FileSystem.FileSystem>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const prior = yield* fs.readFileString(options.file).pipe(
      Effect.map((text) => Option.getOrUndefined(Schema.decodeOption(StateJson)(text))),
      Effect.orElseSucceed(() => undefined),
    );
    const state = { ...prior, wanted: [...new Set([...(prior?.wanted ?? []), ...options.wanted])] };
    const keep = () =>
      Effect.gen(function* () {
        const text = yield* Schema.encodeEffect(StateJson)(state).pipe(Effect.orDie);
        yield* fs.writeFileString(`${options.file}.new`, text);
        yield* fs.rename(`${options.file}.new`, options.file);
      }).pipe(Effect.orDie);
    yield* keep();
    return yield* Effect.gen(function* () {
      const api = yield* options.api;
      if (state.message === undefined) {
        if (options.permalink) {
          yield* targetFromSlack(options.permalink, api, options.url);
          state.message = slackMessageRef(options.permalink)!;
        } else {
          const created = yield* options.created;
          const matches = yield* api.search(`"${options.url}" after:${Str.slice(0, 10)(created)}`);
          const unique = new Map<string, { channel: string; ts: string }>();
          for (const one of matches) {
            if (
              (one.thread_ts !== undefined && one.thread_ts !== one.ts) ||
              Number(one.ts) * 1000 < epochMs(created)
            )
              continue;
            const message = yield* api.message(one.channel, one.ts).pipe(
              Effect.catchIf(
                (reason) => reason === "Slack message was not found",
                () => Effect.succeed(null),
              ),
            );
            if (
              message === null ||
              (message.thread_ts !== undefined && message.thread_ts !== message.ts)
            )
              continue;
            if (
              Arr.some(
                mergeRequestsInSlack(message.text),
                (ref) =>
                  ref.project !== null &&
                  mrId(mrTarget(ref.project, ref.iid)) === mrId(options.url),
              )
            )
              unique.set(`${one.channel}:${one.ts}`, { channel: one.channel, ts: one.ts });
          }
          state.message =
            unique.size === 1
              ? [...unique.values()][0]!
              : {
                  why:
                    unique.size === 0
                      ? "no Slack message found"
                      : `${unique.size} messages mention it`,
                };
        }
        yield* keep();
      }
      if ("why" in state.message) return state.message.why;
      yield* api.reconcile(state.message.channel, state.message.ts, state.wanted);
      return `Slack: ${Arr.join(
        Arr.map(state.wanted, (one) => `:${one}:`),
        " ",
      )}`;
    }).pipe(
      Effect.catch((reason) =>
        Effect.succeed(
          `Slack missing ${Arr.join(
            Arr.map(state.wanted, (one) => `:${one}:`),
            " ",
          )}: ${reason}; sign in again in Desktop Settings › Connections`,
        ),
      ),
    );
  });
