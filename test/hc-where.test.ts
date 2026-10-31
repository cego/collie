// Where the CLI finds hc and its core from the environment it was started with, as hc's
// own installer and `hc` itself would.

import { expect, test } from "bun:test";
import { ConfigProvider, Effect } from "effect";
import { runEffect } from "./support/effect";
import { currentEnv } from "../src/env";
import { hcInstallDir } from "../src/hc-install";

const started = <A, E, R>(
  vars: Record<string, string>,
  body: (env: Effect.Success<typeof currentEnv>) => Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(currentEnv, body).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(vars))),
  );

test("HC_INSTALL_DIR moves where hc is installed and looked for", () =>
  runEffect(
    started({ HOME: "/home/h", HC_INSTALL_DIR: "/opt/hc/bin" }, (env) =>
      Effect.sync(() => hcInstallDir(env.raw, env.home)),
  ).pipe(Effect.map((dir) => expect(dir).toBe("/opt/hc/bin"))),
  ));
