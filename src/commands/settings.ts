// Collie's settings on this Machine: what each is, and setting one through the host, so an
// agent can do what the TUI's and Desktop's Settings do.

import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { readConfig, configValue } from "../config";
import { setSharedSetting } from "../lifecycle";
import { parseSetting, SETTINGS } from "../settings";
import { err } from "../operations";
import { mutation } from "../envelope";
import { nowIso } from "../time";
import { answering, cliDoor, requestIdFlag } from "./shared";

const list = Command.make("list", {}, () =>
  answering((env) =>
    Effect.gen(function* () {
      const raw = yield* readConfig(env.userDir);
      const settings = SETTINGS.map(({ key, kind, choices, fallback }) => ({
        key,
        kind,
        choices,
        fallback,
        value: configValue(raw, key) ?? null,
      }));
      return {
        ok: true,
        data: { settings },
        human: settings
          .map(({ key, value, fallback }) =>
            [key, value === null ? `(default ${fallback || "unset"})` : String(value)].join("\t"),
          )
          .join("\n"),
      };
    }),
  ),
).pipe(Command.withDescription("Every setting, as this Machine has it, with its default"));

const set = Command.make(
  "set",
  {
    key: Argument.String("key").pipe(Argument.withDescription("The setting, as `list` names it")),
    value: Argument.String("value").pipe(
      Argument.withDescription("Its new value as typed; empty unsets it"),
    ),
    requestId: requestIdFlag,
  },
  ({ key, value, requestId }) =>
    answering((env) =>
      Effect.gen(function* () {
        const parsed = parseSetting(key, value);
        if ("refused" in parsed) return err("invalid_input", parsed.refused);
        return yield* mutation(env, "settings-set", requestId, (id) =>
          Effect.gen(function* () {
            const done = yield* setSharedSetting(env, {
              door: yield* cliDoor(env),
              key,
              value: parsed.value,
              at: yield* nowIso(),
              request: id,
            });
            if (!done.ok) return done;
            return {
              ok: true,
              data: done.value,
              human: `${key} is now ${value.trim() || "unset"}; a Desktop gives it to every Machine`,
            };
          }),
        );
      }),
    ),
).pipe(Command.withDescription("Set one setting; the latest edit of it wins across the Flock"));

export const settings = Command.make("settings").pipe(
  Command.withDescription("Collie's settings, which a Desktop shares with every Machine"),
  Command.withSubcommands([list, set]),
);
