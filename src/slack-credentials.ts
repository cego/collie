import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Option from "effect/Option";
import { Effect, FileSystem } from "effect";
import type { PluginEnv } from "./env";
import type { ConnectionReading } from "./connection-model";
import { slackApi } from "./slack";
import { isString } from "./schema";

export const SLACK_FIX =
  "Connect Slack in Desktop Settings › Connections, or give SLACK_BOT_TOKEN on collie onboard --secrets-stdin";
export const slackEnvPath = (env: Pick<PluginEnv, "home" | "raw">) =>
  `${env.raw.XDG_CONFIG_HOME || `${env.home}/.config`}/collie/slack.env`;

export const slackToken = (env: Pick<PluginEnv, "home" | "raw">) =>
  Effect.gen(function* () {
    if (env.raw.SLACK_BOT_TOKEN) return env.raw.SLACK_BOT_TOKEN;
    const fs = yield* FileSystem.FileSystem;
    const file = slackEnvPath(env);
    if (!(yield* fs.exists(file))) return null;
    const text = yield* fs
      .readFileString(file)
      .pipe(Effect.mapError(() => "Slack's credential file could not be read"));
    return (
      Option.getOrUndefined(
        Option.flatMap(Option.fromNullishOr(/^SLACK_BOT_TOKEN=(.+)$/m.exec(text)), (present) =>
          Option.map(Option.fromNullishOr(present[1]), (present_) => Str.trim(present_)),
        ),
      ) || null
    );
  });

export const writeSlackToken = (env: Pick<PluginEnv, "home" | "raw">, token: string | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = slackEnvPath(env);
    if (token === null) return yield* fs.remove(file, { force: true });
    if (!/^xoxb-[^\s]+$/.test(token))
      return yield* Effect.fail("Paste the xoxb- Bot User OAuth Token from OAuth & Permissions");
    const dir = pipe_(
      file,
      Str.slice(
        0,
        Option.getOrElse(pipe_(file, Str.lastIndexOf("/")), () => -1),
      ),
    );
    yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
    yield* fs.remove(`${file}.new`, { force: true });
    yield* fs.writeFileString(`${file}.new`, `SLACK_BOT_TOKEN=${token}\n`, { mode: 0o600 });
    yield* fs.rename(`${file}.new`, file);
  });

export const probeSlack = (
  env: PluginEnv,
  api = slackApi,
): Effect.Effect<ConnectionReading, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const token = yield* slackToken(env);
    if (token === null)
      return {
        state: "absent",
        detail: "No Slack bot token on this Machine",
        fix: SLACK_FIX,
      } satisfies ConnectionReading;
    const identity = yield* api(token).auth();
    return {
      state: "ok",
      account: identity.team,
      detail: `Posts as ${identity.user} in ${identity.team}`,
    } satisfies ConnectionReading;
  }).pipe(
    Effect.catch((reason) =>
      Effect.succeed<ConnectionReading>({
        state: "broken",
        detail: isString(reason) ? reason : "Slack's credential file could not be read",
        fix: SLACK_FIX,
      }),
    ),
  );

export const slackChoicesOnMachine = (env: PluginEnv) =>
  Effect.gen(function* () {
    const token = yield* slackToken(env);
    if (token === null) return yield* Effect.fail("Connect Slack in Settings › Connections");
    const api = slackApi(token);
    const identity = yield* api.auth();
    const channels = yield* api.channels();
    const people = yield* api.people();
    return { identity, channels, people };
  });
