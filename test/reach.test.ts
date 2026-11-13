// How far a launch went, as Settings shows it: nowhere, since the launch itself is where it is chosen.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { writeConfigValue } from "../src/config";
import { currentEnv } from "../src/env";
import { reachKey } from "../src/reach";
import { buildMachineOwn, buildSettings } from "../src/views";
import { proves } from "./support/world";

const isReach = ({ key }: { readonly key: string }) => pipe(key, Str.startsWith("launch_reach."));

test(
  "a saved reach has no row in Settings, among its remembered values or the Machine's own",
  () =>
    proves(
      "collie-reach-settings-",
      (world) =>
        Effect.gen(function* () {
          yield* writeConfigValue(world.config, reachKey("plan", "projects-root"), "implement");
          yield* writeConfigValue(
            world.config,
            reachKey("implement", "gitlab.example.com/group/app"),
            "finish",
          );
          yield* writeConfigValue(world.config, "gitlab.assignee", "mk");
          const env = { ...(yield* currentEnv), userDir: world.config };

          const settings = yield* buildSettings(env);
          expect(settings.remembered).toContainEqual({ key: "gitlab.assignee", value: "mk" });
          expect(Arr.filter(settings.remembered, isReach)).toEqual([]);

          const own = yield* buildMachineOwn(env);
          expect(own.remembered).toContainEqual({ key: "gitlab.assignee", value: "mk" });
          expect(Arr.filter(own.remembered, isReach)).toEqual([]);
        }),
      [],
    ),
  60_000,
);
