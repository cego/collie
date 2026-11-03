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
const collieConfig = (env: Pick<PluginEnv, "home" | "raw">) =>
  `${env.raw.XDG_CONFIG_HOME || `${env.home}/.config`}/collie`;
export const slackEnvPath = (env: Pick<PluginEnv, "home" | "raw">) =>
  `${collieConfig(env)}/slack.env`;
export const slackUserEnvPath = (env: Pick<PluginEnv, "home" | "raw">) =>
  `${collieConfig(env)}/slack-user.env`;

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

export const SLACK_USER_FIX = "Open Desktop to renew Slack, or sign in again";
const SLACK_USER_ABSENT = {
  state: "absent",
  detail: "Not signed in to Slack as yourself on this Machine",
  fix: "Sign in to Slack as yourself in Desktop Settings › Connections",
} satisfies ConnectionReading;

const signedInAs = (env: Pick<PluginEnv, "home" | "raw">, api: typeof slackApi) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = slackUserEnvPath(env);
    const unreadable = () => "Slack's sign-in file could not be read";
    if (!(yield* fs.exists(file).pipe(Effect.mapError(unreadable))))
      return yield* Effect.fail<ConnectionReading>(SLACK_USER_ABSENT);
    const broken = (detail: string) =>
      Effect.fail<ConnectionReading>({ state: "broken", detail, fix: SLACK_USER_FIX });
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
      isString(reason) ? { state: "broken", detail: reason, fix: SLACK_USER_FIX } : reason,
    ),
  );

export const probeSlackUser = (
  env: Pick<PluginEnv, "home" | "raw">,
  api = slackApi,
): Effect.Effect<ConnectionReading, never, FileSystem.FileSystem> =>
  signedInAs(env, api).pipe(
    Effect.map(({ owner }): ConnectionReading => ({
      state: "ok",
      account: owner.team,
      detail: `Posts approval requests as ${owner.user} in ${owner.team}`,
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
