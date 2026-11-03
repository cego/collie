import * as Str from "effect/String";
import { Effect, FileSystem } from "effect";
import type { PluginEnv } from "./env";
import type { ConnectionReading } from "./connection-model";
import { slackApi } from "./slack";
import { isString } from "./schema";

const collieConfig = (env: Pick<PluginEnv, "home" | "raw">) =>
  `${env.raw.XDG_CONFIG_HOME || `${env.home}/.config`}/collie`;
/** An older Collie's bot token, which is never read: only its presence is. */
const slackBotEnvPath = (env: Pick<PluginEnv, "home" | "raw">) => `${collieConfig(env)}/slack.env`;
export const slackUserEnvPath = (env: Pick<PluginEnv, "home" | "raw">) =>
  `${collieConfig(env)}/slack-user.env`;

export const SLACK_FIX = "Open Desktop to renew Slack, or sign in again";
const SIGN_IN = "Sign in to Slack in Desktop Settings › Connections";
export const SLACK_BOT_RETIRED = "Collie no longer posts with a Slack bot token: sign in to Slack";

const signedInAs = (env: Pick<PluginEnv, "home" | "raw">, api: typeof slackApi) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = slackUserEnvPath(env);
    const unreadable = () => "Slack's sign-in file could not be read";
    if (!(yield* fs.exists(file).pipe(Effect.mapError(unreadable)))) {
      const bot =
        env.raw.SLACK_BOT_TOKEN !== undefined ||
        (yield* fs.exists(slackBotEnvPath(env)).pipe(Effect.mapError(unreadable)));
      return yield* Effect.fail<ConnectionReading>({
        state: "absent",
        detail: bot ? SLACK_BOT_RETIRED : "Not signed in to Slack on this Machine",
        fix: SIGN_IN,
      });
    }
    const broken = (detail: string) =>
      Effect.fail<ConnectionReading>({ state: "broken", detail, fix: SLACK_FIX });
    const text = yield* fs.readFileString(file).pipe(Effect.mapError(unreadable));
    const field = (name: string) =>
      Str.trim(new RegExp(`^${name}=(.+)$`, "m").exec(text)?.[1] ?? "");
    const [token, user, team] = [
      field("SLACK_USER_TOKEN"),
      field("SLACK_USER_ID"),
      field("SLACK_TEAM_ID"),
    ];
    if (!token || !user || !team) return yield* broken(`${file} lacks the token, user or team`);
    const owner = yield* api(token).tokenOwner();
    if (owner.bot_id !== undefined) return yield* broken("token is a bot's");
    if (owner.user_id !== user)
      return yield* broken(`token belongs to ${owner.user_id}, not ${user}`);
    if (owner.team_id !== team)
      return yield* broken(`token is for team ${owner.team_id}, not ${team}`);
    return { token, owner };
  }).pipe(
    Effect.mapError((reason): ConnectionReading =>
      isString(reason) ? { state: "broken", detail: reason, fix: SLACK_FIX } : reason,
    ),
  );

export const probeSlack = (
  env: Pick<PluginEnv, "home" | "raw">,
  api = slackApi,
): Effect.Effect<ConnectionReading, never, FileSystem.FileSystem> =>
  signedInAs(env, api).pipe(
    Effect.map(({ owner }): ConnectionReading => ({
      state: "ok",
      account: owner.team,
      detail: `Posts as ${owner.user} in ${owner.team}`,
    })),
    Effect.catch(Effect.succeed),
  );

/** The human's user token, only once Slack says it is theirs; otherwise why not. */
export const slackUserToken = (
  env: Pick<PluginEnv, "home" | "raw">,
  api = slackApi,
): Effect.Effect<string, string, FileSystem.FileSystem> =>
  signedInAs(env, api).pipe(
    Effect.map(({ token }) => token),
    Effect.mapError((reading) => reading.detail),
  );
