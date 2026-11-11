// The claim a start of a merge request makes when its workflow follows merge requests: one
// Run per merge request and forge login (ADR-0017), whichever door asked.

import * as Str from "effect/String";
import { Effect, Schema } from "effect";
import { mrId, parseMrTarget } from "./board-model";
import { configValue, readConfig } from "./config";
import { forgeOf } from "./forge/forge";
import { shell } from "./mr";

/** The request a start of `target` is claimed under, or null where it follows nothing. */
export const followRequest = Effect.fn("FollowThrough.request")(function* (opts: {
  readonly workflow: string;
  /** The setting the workflow declares it follows under. */
  readonly setting: string | undefined;
  readonly target: string | null;
  readonly userDir: string;
  readonly cwd: string;
}) {
  if (opts.setting === undefined || opts.target === null) return null;
  const config = yield* readConfig(opts.userDir).pipe(Effect.orElseSucceed(() => ({})));
  const on = configValue(config, opts.setting);
  if (
    !Schema.is(Schema.Union([Schema.Boolean, Schema.String]))(on) ||
    Str.trim(String(on)) !== "true"
  )
    return null;
  const ref = parseMrTarget(opts.target);
  const mr = mrId(opts.target);
  if (ref === null || mr === null) return null;
  const login = yield* forgeOf(ref).login(opts.cwd, shell, ref.project);
  if (login === null) return null;
  return { request: `${opts.workflow}-follow:${mr}:${login}`, mr };
});
