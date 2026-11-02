// Where the CLI finds hc and its core from the environment it was started with, as hc's
// own installer and `hc` itself would.

import { expect, test } from "bun:test";
import { ConfigProvider, Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { currentEnv } from "../src/env";
import { coreSocket } from "../src/hc";
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

test("the socket core's config.toml names is the core, under XDG_CONFIG_HOME; HC_SOCKET still wins", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-hc-where-" });
      yield* fs.makeDirectory(`${dir}/config/herdr-core`, { recursive: true });
      yield* fs.writeFileString(
        `${dir}/config/herdr-core/config.toml`,
        `wait_timeout = 60\nsocket = "${dir}/configured.sock"\n`,
      );
      const vars = { HOME: dir, XDG_CONFIG_HOME: `${dir}/config`, XDG_RUNTIME_DIR: `${dir}/run` };

      expect(yield* started(vars, (env) => coreSocket(env.raw))).toBe(`${dir}/configured.sock`);
      expect(
        yield* started({ ...vars, HC_SOCKET: `${dir}/env.sock` }, (env) => coreSocket(env.raw)),
      ).toBe(`${dir}/env.sock`);
      expect(
        yield* started({ ...vars, XDG_CONFIG_HOME: `${dir}/elsewhere` }, (env) =>
          coreSocket(env.raw),
        ),
      ).toBe(`${dir}/run/herdr-core/default.sock`);
    }),
  ));
