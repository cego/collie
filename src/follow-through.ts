import * as Str from "effect/String";
import { Effect, Schema } from "effect";
import { mrId, parseMrTarget } from "./board-model";
import { configValue, readConfig } from "./config";
import { forgeOf } from "./forge/forge";
import { shell } from "./mr";

export const followingOn = Effect.fn("FollowThrough.on")(function* (
  userDir: string,
  setting: string,
) {
  const config = yield* readConfig(userDir).pipe(Effect.orElseSucceed(() => ({})));
  const on = configValue(config, setting);
  return (
    Schema.is(Schema.Union([Schema.Boolean, Schema.String]))(on) && Str.trim(String(on)) === "true"
  );
});

export const followClaim = (mr: string, login: string) => `-follow:${mr}:${login}`;

export const followRequest = Effect.fn("FollowThrough.request")(function* (opts: {
  readonly workflow: string;
  readonly setting: string | undefined;
  readonly target: string | null;
  readonly userDir: string;
  readonly cwd: string;
}) {
  if (opts.setting === undefined || opts.target === null) return null;
  if (!(yield* followingOn(opts.userDir, opts.setting))) return null;
  const ref = parseMrTarget(opts.target);
  const mr = mrId(opts.target);
  if (ref === null || mr === null) return null;
  const login = yield* forgeOf(ref).login(opts.cwd, shell, ref.project);
  if (login === null)
    return yield* Effect.fail(
      `could not establish the forge login for ${mr}; follow-through was not started, try again when the forge is readable`,
    );
  return { request: `${opts.workflow}${followClaim(mr, login)}`, mr };
});
