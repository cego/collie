// What an agent on core is told it is: `collie` run in its terminal, with nothing but the
// environment it was launched with, finds that agent and its Run, with no herdr pane to ask.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { expect, test } from "bun:test";
import { Config, Effect, FileSystem, Schema } from "effect";
import { connect } from "../src/host";
import { readAudit } from "../src/audit";
import { runDir } from "../src/engine";
import { suiteEnv } from "./support/effect";
import { serveFakeHc } from "./support/fake-hc";
import { until } from "./support/host";
import { collie, collieCommand, proves } from "./support/world";

const Logged = Schema.fromJsonString(
  Schema.Struct({
    cmd: Schema.String,
    params: Schema.optionalKey(
      Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      }),
    ),
  }),
);

test(
  "collie in an agent's core terminal, with only its launch environment, acts as that agent of its Run",
  () =>
    proves(
      "collie-core-cli-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const log = yield* Config.String("FAKE_HERDR_LOG");
          const outputs = `${world.home}/outputs.json`;
          yield* fs.writeFileString(outputs, `[{ "verdict": "done" }]`);
          yield* fs.writeFileString(
            `${world.config}/config.json`,
            `{ "terminal_backend": "core" }`,
          );
          const core = yield* serveFakeHc(
            `${world.home}/hc.sock`,
            log,
            yield* Effect.scope,
            outputs,
          );
          const start = yield* collie(world, ["run", "start", "attended", "--input", "work=x"], {
            FAKE_HERDR_OUTPUTS: outputs,
            HC_SOCKET: core.socketPath,
          });
          const { runId } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(start.envelope.data);
          const host = yield* connect(world.state);
          yield* until(
            () => host.run({ runId }),
            (view) => Arr.some(view?.waiting ?? [], (one) => one.answer === null),
          );
          const launch = Option.getOrThrow(
            Arr.findFirst(
              Arr.filterMap(Str.split(yield* fs.readFileString(log), "\n"), (line) =>
                Schema.decodeResult(Logged)(line),
              ),
              (call) => call.cmd === "terminal.run",
            ),
          );
          const agent = launch.params?.name ?? "";
          const launchEnv = launch.params?.env ?? {};

          // The terminal's environment: core's own, which gives PATH and HOME, and the launch's.
          const command = yield* collieCommand;
          const child = Bun.spawn(
            [
              ...command,
              "--json",
              "run",
              "steer",
              runId,
              "from its terminal",
              "--request-id",
              "from-terminal",
            ],
            {
              cwd: world.project,
              env: {
                PATH: yield* Config.String("PATH"),
                HOME: world.home,
                ...(yield* suiteEnv),
                ...launchEnv,
              },
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          const said = yield* Effect.promise(() => new Response(child.stdout).text());
          expect(yield* Effect.promise(() => child.exited)).toBe(0);
          expect(said).toContain('"ok":true');
          const trail = yield* readAudit(runDir(world.state, runId));
          expect(
            Option.getOrUndefined(Arr.findFirst(trail, (line) => line.request === "from-terminal"))
              ?.actor,
          ).toMatchObject({ origin: "agent", from: { run: runId, agent } });
          expect(pipe(agent, Str.startsWith(runId))).toBe(true);
        }).pipe(Effect.orDie),
      ["attended.workflow.ts"],
    ),
  180_000,
);
