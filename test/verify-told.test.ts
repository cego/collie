// An agent that ends its turn on a background `collie verify` is told when it ends, by a
// real host over a fake herdr, and nobody else is (ADR-draft-an-agent-is-told-when-its-verify-ends).

import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { connect } from "../src/host";
import { resetExecutors } from "../src/executors";
import { Launched } from "../src/launches";
import { everyRegistered } from "../src/registry";
import { deliveriesOf } from "../src/steering";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { root, stopHost, until } from "./support/host";
import { collie, proves } from "./support/world";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeLaunched = Schema.decodeUnknownSync(Schema.fromJsonString(Launched));
const decodeCall = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ argv: Schema.Array(Schema.String) })),
);
const Ran = Schema.Struct({
  verification: Schema.Struct({ id: Schema.String, log: Schema.optionalKey(Schema.String) }),
  ran: Schema.Boolean,
});

test(
  "a settled agent being collected from is told its verify ended, and no one else is",
  () =>
    proves(
      "collie-verify-told-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputs = `${world.home}/outputs.json`;
          const status = `${world.home}/agent-status`;
          yield* fs.writeFileString(outputs, encode([null])).pipe(Effect.orDie);
          yield* fs.writeFileString(`${world.project}/thing.txt`, "one\n").pipe(Effect.orDie);
          yield* exec(["git", "add", "-A"], { cwd: world.project });
          yield* exec(
            ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "one"],
            { cwd: world.project },
          );
          const set = {
            FAKE_HERDR_OUTPUTS: outputs,
            FAKE_HERDR_AGENT_STATUS_FILE: status,
            HERDR_PLUGIN_STATE_DIR: world.state,
            COLLIE_USER_DIR: world.config,
          };
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const before = Object.fromEntries(Object.keys(set).map((key) => [key, Bun.env[key]]));
              Object.assign(Bun.env, set);
              return before;
            }),
            (before) =>
              Effect.sync(() => {
                for (const [key, value] of Object.entries(before))
                  if (value === undefined) delete Bun.env[key];
                  else Bun.env[key] = value;
              }),
          );
          resetExecutors();
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const { runId } = yield* client
            .start({
              project: world.project,
              id: "attended",
              request: "start",
              input: { work: "it" },
            })
            .pipe(Effect.orDie);
          const launched = decodeLaunched(
            yield* until(
              () =>
                fs
                  .readFileString(`${world.state}/agents/${runId}/build.launch.json`)
                  .pipe(Effect.orElseSucceed(() => "")),
              (one) => one !== "",
            ),
          );
          const pane = (yield* everyRegistered(world.state)).find(
            (entry) => entry.runId === runId,
          )!.paneId;
          const asked = (
            name: string,
            executable: string,
            extra: Record<string, string>,
            expecting: ReadonlyArray<string> = [],
          ) =>
            collie(
              world,
              [
                "verify",
                "--run",
                runId,
                "--cwd",
                world.project,
                "--name",
                name,
                ...expecting,
                "--",
                executable,
              ],
              extra,
            );
          const verify = (name: string, executable: string, extra: Record<string, string>) =>
            asked(name, executable, extra).pipe(
              Effect.map((ran) => Schema.decodeUnknownSync(Ran)(ran.envelope.data)),
            );
          const grant = (name: string, executable: string) =>
            client
              .grant({
                runId,
                name,
                command: { executable, argv: [], cwd: "." },
                request: `grant-${name}`,
              })
              .pipe(Effect.orDie);
          const asAgent = { HERDR_PANE_ID: pane };
          const told = () =>
            deliveriesOf(world.state, runId).pipe(
              Effect.map((all) =>
                all.filter((one) => one.delivery.cause.ref.startsWith("verify-")),
              ),
            );

          yield* verify("from-cli", "/bin/false", { HERDR_PANE_ID: "not-an-agent" });
          yield* fs.writeFileString(status, "working").pipe(Effect.orDie);
          yield* verify("while-working", "/bin/false", asAgent);
          yield* fs.writeFileString(status, "blocked").pipe(Effect.orDie);
          yield* verify("while-blocked", "/bin/false", asAgent);
          expect(yield* told()).toEqual([]);

          yield* fs.writeFileString(status, "idle").pipe(Effect.orDie);
          const ran = yield* verify("unit", "/bin/true", asAgent);
          expect(ran.ran).toBe(true);
          const [one, ...more] = yield* told();
          expect(more).toEqual([]);
          expect(one!.delivery).toMatchObject({
            agent: launched.agent,
            mode: "boundary",
            cause: { kind: "steer", ref: `verify-${ran.verification.id}` },
          });
          const head = (yield* exec(["git", "rev-parse", "HEAD"], { cwd: world.project })).stdout;
          const said = (yield* fs.readFileString(Bun.env.FAKE_HERDR_LOG ?? "").pipe(Effect.orDie))
            .split("\n")
            .filter((line) => line !== "")
            .flatMap((line) => decodeCall(line).argv)
            .find((words) => words.includes("Your collie verify"));
          for (const part of ['"unit"', "pass (exit 0)", head.trim(), ran.verification.log!])
            expect(said).toContain(part);

          // Once it is one of the Run's Checks, it is answered from its record, never run,
          // for an agent as for a human, whatever it expects.
          yield* grant("unit", "/bin/true");
          const asHuman = { HERDR_PANE_ID: "not-an-agent" };
          const again = yield* verify("unit", "/bin/true", asAgent);
          expect(again).toEqual({ ...ran, ran: false });
          for (const [extra, expecting] of [
            [asHuman, []],
            [asAgent, ["--expect", "fail"]],
            [asHuman, ["--expect", "fail"]],
          ] as const)
            expect(
              Schema.decodeUnknownSync(Ran)(
                (yield* asked("unit", "/bin/true", extra, expecting)).envelope.data,
              ),
            ).toEqual(again);
          yield* grant("gate-only", "/bin/echo");
          for (const [extra, expecting] of [
            [asAgent, []],
            [asHuman, []],
            [asAgent, ["--expect", "fail"]],
            [asHuman, ["--expect", "fail"]],
          ] as const) {
            const refused = yield* asked("gate-only", "/bin/echo", extra, expecting);
            expect(refused.envelope.error?.code).toBe("invalid_state");
            expect(refused.envelope.error?.message).toContain("gate");
          }
          expect(yield* told()).toHaveLength(1);

          yield* fs
            .writeFileString(launched.output, encode({ verdict: "built" }))
            .pipe(Effect.orDie);
          yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => (view?.waiting ?? []).some((one) => one.answer === null),
          );
          yield* verify("after-output", "/bin/false", asAgent);
          expect(yield* told()).toHaveLength(1);
        }).pipe(Effect.ensuring(stopHost(world.state))),
      ["attended.workflow.ts"],
    ),
  120_000,
);

test("the implementer, and every step prompt that has an agent use collie verify, say it may end its turn on one", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const line =
        "A `collie verify` you started in the background is reported to you when it ends, so you may end your turn waiting on it. Never end a turn waiting on any other background job.";
      const flat = (text: string) => text.replace(/\s+/g, " ");
      expect(flat(yield* fs.readFileString(`${root}personas/implementer.md`))).toContain(line);
      for (const workflow of ["implement", "review"]) {
        // A dotted section, such as `source.linear`, is spliced into a step's prompt, not one.
        const steps = (yield* fs.readFileString(`${root}workflows/${workflow}.md`))
          .split(/^## /m)
          .slice(1)
          .filter((step) => !/^\S+\./.test(step));
        const verifying = steps.filter((step) => step.includes("collie verify"));
        expect(verifying.length).toBeGreaterThan(0);
        for (const step of verifying) expect(flat(step)).toContain(line);
      }
    }),
  ));
