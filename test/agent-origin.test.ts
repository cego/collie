import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema, flow, Result } from "effect";
import { machineName } from "../src/peers";
import { connect } from "../src/host";
import { readAudit } from "../src/audit";
import { runDir } from "../src/engine";
import { deliveriesOf, appendLine } from "../src/steering";
import { everyRegistered } from "../src/registry";
import { runEffect } from "./support/effect";
import { stopHost, until } from "./support/host";
import { type Side, twoMachines } from "./support/peers";

const encodeValue = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

/** An attended Run held at its question, and the agent its build step left in a pane. */
const attendedAgent = Effect.fn("attendedAgent")(function* (side: Side) {
  const fs = yield* FileSystem.FileSystem;
  const outputs = `${side.world.home}/outputs.json`;
  yield* fs.writeFileString(outputs, encodeValue([{ verdict: "done" }]));
  const start = yield* side.cli(["run", "start", "attended", "--input", "work=identity"], {
    FAKE_HERDR_OUTPUTS: outputs,
  });
  const { runId } = yield* Schema.decodeUnknownEffect(Schema.Struct({ runId: Schema.String }))(
    start.envelope.data,
  ).pipe(Effect.orDie);
  const host = yield* connect(side.world.state);
  yield* until(
    () => host.run({ runId }),
    (view) => Arr.some(view?.waiting ?? [], (one) => one.answer === null),
  );
  const agent = Option.getOrUndefined(
    Arr.findFirst(yield* everyRegistered(side.world.state), (entry) => entry.runId === runId),
  )!;
  return { runId, agent };
});

test(
  "collie verify in a Run's agent pane records against that Run, and needs --run anywhere else",
  () =>
    runEffect(
      twoMachines(
        "collie-verify-pane-",
        (first) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const { runId, agent } = yield* attendedAgent(first);
            const fromPane = yield* first.cli(["verify", "--name", "from-pane", "--", "true"], {
              HERDR_PANE_ID: agent.paneId,
            });
            expect(fromPane.envelope.ok).toBe(true);
            expect(
              yield* fs.readFileString(
                `${first.world.state}/evidence/${runId}/steering/verifications.jsonl`,
              ),
            ).toContain(`"name":"from-pane"`);

            const plain = yield* first.cli(["verify", "--", "true"], {
              HERDR_PANE_ID: "not-an-agent",
            });
            expect(plain.envelope.error).toMatchObject({
              code: "invalid_input",
              message: "verify needs --run outside a Run's agent pane.",
            });

            const named = yield* first.cli(["verify", "--run", "run-nobody", "--", "true"], {
              HERDR_PANE_ID: agent.paneId,
            });
            expect(named.envelope.error?.code).toBe("run_not_found");
          }),
        ["attended.workflow.ts"],
      ),
    ),
  180_000,
);

test(
  "a piped CLI command in an agent's pane records its Run and agent, and a plain pane remains CLI",
  () =>
    runEffect(
      twoMachines(
        "collie-agent-origin-",
        (first) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const { runId, agent } = yield* attendedAgent(first);
            const prompt = yield* fs.readFileString(
              `${first.world.state}/agents/${runId}/build.prompt.md`,
            );
            expect(prompt).toContain(`You are ${agent.agent} of ${runId} on ${machineName()}.`);
            const words = "my exact words\n  and spacing";
            expect(
              (yield* first.cli(["run", "steer", runId, words, "--request-id", "from-agent"], {
                HERDR_PANE_ID: agent.paneId,
              })).envelope,
            ).toMatchObject({ ok: true });
            expect(
              (yield* first.cli(
                ["run", "steer", runId, "from a plain pane", "--request-id", "from-cli"],
                { HERDR_PANE_ID: "not-an-agent" },
              )).envelope.ok,
            ).toBe(true);
            const trail = yield* readAudit(runDir(first.world.state, runId));
            expect(
              Option.getOrUndefined(Arr.findFirst(trail, (line) => line.request === "from-agent"))
                ?.actor,
            ).toMatchObject({
              origin: "agent",
              from: {
                run: runId,
                agent: agent.agent,
                machine: { installation: expect.any(String) },
              },
            });
            expect(
              Option.getOrUndefined(Arr.findFirst(trail, (line) => line.request === "from-cli"))
                ?.actor.origin,
            ).toBe("cli");
            expect(yield* fs.readFileString(first.herdrLog)).toContain(
              `From ${agent.agent} of ${runId} on `,
            );
            const atCap = Str.repeat(8 * 1024)("x");
            expect(
              (yield* first.cli(
                [
                  "run",
                  "steer",
                  runId,
                  atCap,
                  "--operation",
                  "build",
                  "--request-id",
                  "agent-at-cap",
                ],
                { HERDR_PANE_ID: agent.paneId },
              )).envelope.ok,
            ).toBe(true);
            const message = `${runDir(first.world.state, runId)}/attachments/message-${pipe(new Bun.CryptoHasher("sha256").update(atCap).digest("hex"), Str.slice(0, 8))}.md`;
            expect(yield* fs.readFileString(message)).toBe(atCap);
            const calls = Arr.map(
              Arr.filter(
                Str.split(yield* fs.readFileString(first.herdrLog), "\n"),
                (line) => line !== "",
              ),
              (line) =>
                flow(
                  Schema.decodeUnknownResult(Schema.Struct({ argv: Schema.Array(Schema.String) })),
                  Result.getOrThrow,
                )(JSON.parse(line)),
            );
            const sentWords = Arr.flatMap(calls, (call) => call.argv);
            const said = Option.getOrUndefined(
              Arr.findFirst(sentWords, (word) =>
                pipe(word, Str.includes(`Their message is in ${message}.`)),
              ),
            );
            expect(said).toContain(`From ${agent.agent} of ${runId} on `);
            expect(said).toContain("Read it whole and act on it as that agent's.");
            const humanAtCap = Str.repeat(8 * 1024)("y");
            expect(
              (yield* first.cli(
                [
                  "run",
                  "steer",
                  runId,
                  humanAtCap,
                  "--operation",
                  "build",
                  "--request-id",
                  "human-at-cap",
                ],
                { HERDR_PANE_ID: "not-an-agent" },
              )).envelope.ok,
            ).toBe(true);
            const humanMessage = `${runDir(first.world.state, runId)}/attachments/message-${pipe(new Bun.CryptoHasher("sha256").update(humanAtCap).digest("hex"), Str.slice(0, 8))}.md`;
            expect(yield* fs.readFileString(humanMessage)).toBe(humanAtCap);
            expect(yield* fs.readFileString(first.herdrLog)).toContain(
              `Their message is in ${humanMessage}. Read it whole and act on it as theirs.`,
            );
          }),
        ["attended.workflow.ts"],
      ),
    ),
  180_000,
);

test(
  "two paired hosts carry an agent conversation and resolve Native chat reads by Run",
  () =>
    runEffect(
      twoMachines(
        "collie-talk-",
        (first, second) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const startOn = (side: typeof first) =>
              Effect.gen(function* () {
                yield* fs.writeFileString(
                  `${Str.split(side.env.PATH!, ":")[0]}/claude`,
                  "#!/bin/sh\necho 2.1.300\n",
                  { mode: 0o755 },
                );
                const outputs = `${side.world.home}/outputs.json`;
                yield* fs.writeFileString(outputs, encodeValue([{ verdict: "done" }]));
                const start = yield* side.cli(
                  ["run", "start", "attended", "--input", "work=conversation"],
                  { FAKE_HERDR_OUTPUTS: outputs },
                );
                const { runId } = yield* Schema.decodeUnknownEffect(
                  Schema.Struct({ runId: Schema.String }),
                )(start.envelope.data).pipe(Effect.orDie);
                const host = yield* connect(side.world.state);
                yield* until(
                  () => host.run({ runId }),
                  (view) => Arr.some(view?.waiting ?? [], (one) => one.answer === null),
                );
                const entry = Option.getOrUndefined(
                  Arr.findFirst(
                    yield* everyRegistered(side.world.state),
                    (one) => one.runId === runId,
                  ),
                )!;
                return { runId, agent: entry.agent, pane: entry.paneId };
              });
            const here = yield* startOn(first);
            const there = yield* startOn(second);
            yield* first.lists([second]);
            expect((yield* first.cli(["--machine", "second", "board"])).envelope).toMatchObject({
              ok: true,
            });
            const words = "Can you explain this?\n  Keep these words.";
            const told = yield* first.cli(
              [
                "tools",
                "call",
                "collie_do",
                "--input",
                encodeValue({
                  actions: [{ kind: "deliver", run: there.runId, agent: there.agent, text: words }],
                }),
              ],
              { COLLIE_RUN: here.runId, COLLIE_AGENT: here.agent },
            );
            expect(
              (yield* Schema.decodeUnknownEffect(Schema.Struct({ text: Schema.String }))(
                told.envelope.data,
              ).pipe(Effect.orDie)).text,
            ).toContain("deliver: applied");
            const remote = yield* readAudit(runDir(second.world.state, there.runId));
            expect(
              Option.getOrUndefined(Arr.findFirst(remote, (one) => one.operation === "deliver"))
                ?.actor,
            ).toMatchObject({
              origin: "agent",
              from: { run: here.runId, agent: here.agent, machine: { name: machineName() } },
            });
            const log = yield* fs.readFileString(second.herdrLog);
            expect(log).toContain(`From ${here.agent} of ${here.runId} on ${machineName()}.`);
            const kept =
              /Their message is in (\S+)\. Read it whole and act on it as that agent's\./.exec(
                log,
              )?.[1];
            expect(yield* fs.readFileString(kept ?? "")).toBe(words);
            const replied = yield* second.cli(
              ["run", "steer", here.runId, "Here is the answer.", "--operation", here.agent],
              { HERDR_PANE_ID: there.pane },
            );
            expect(replied.envelope).toMatchObject({ ok: true });
            expect(yield* fs.readFileString(first.herdrLog)).toContain(
              `From ${there.agent} of ${there.runId} on second.`,
            );
            for (const tool of ["collie_run", "collie_receipts"]) {
              const read = yield* first.cli([
                "tools",
                "call",
                tool,
                "--input",
                encodeValue({ run: there.runId }),
              ]);
              expect(
                (yield* Schema.decodeUnknownEffect(Schema.Struct({ text: Schema.String }))(
                  read.envelope.data,
                ).pipe(Effect.orDie)).text,
              ).toContain(there.runId);
            }
            const delivered = Schema.Struct({
              deliveries: Schema.Array(
                Schema.Struct({ id: Schema.String, note: Schema.optionalKey(Schema.String) }),
              ),
            });
            for (const prefix of [[], ["--machine", "second"]]) {
              const listedReceipts = yield* first.cli([
                ...prefix,
                "run",
                "deliveries",
                there.runId,
              ]);
              expect(listedReceipts.envelope.ok).toBe(true);
              const rows = (yield* Schema.decodeUnknownEffect(delivered)(
                listedReceipts.envelope.data,
              ).pipe(Effect.orDie)).deliveries;
              expect(Arr.map(rows, (one) => one.id)).toEqual(
                Arr.map(
                  yield* deliveriesOf(second.world.state, there.runId),
                  (one) => one.delivery.id,
                ),
              );
              const source = (yield* deliveriesOf(second.world.state, there.runId)).at(-1)!;
              const id = `unknown-${prefix.length}`;
              yield* appendLine(source.file, { ...source.delivery, id, state: "unknown" });
              const settled = yield* first.cli([
                ...prefix,
                "run",
                "deliveries",
                there.runId,
                "--reconcile",
                id,
                "--as",
                "sent",
              ]);
              expect(settled.envelope.ok).toBe(true);
              expect(
                Option.getOrUndefined(
                  Arr.findFirst(
                    yield* deliveriesOf(second.world.state, there.runId),
                    (one) => one.delivery.id === id,
                  ),
                )?.delivery.note,
              ).toContain("reconciled as sent");
            }
            const listed = yield* first.cli(["run", "list"]);
            expect(listed.envelope.data).toMatchObject({
              runs: expect.arrayContaining([
                expect.objectContaining({ runId: here.runId, machine: machineName() }),
                expect.objectContaining({ runId: there.runId, machine: "second" }),
              ]),
              machines: expect.any(Array),
            });
            const forged = yield* first.cli([
              "tools",
              "call",
              "collie_do",
              "--input",
              encodeValue({ sender: "somebody", actions: [{ kind: "stop", run: there.runId }] }),
            ]);
            expect(
              (yield* Schema.decodeUnknownEffect(Schema.Struct({ text: Schema.String }))(
                forged.envelope.data,
              ).pipe(Effect.orDie)).text,
            ).toContain("refus");
            const stopped = yield* first.cli([
              "tools",
              "call",
              "collie_do",
              "--input",
              encodeValue({ actions: [{ kind: "stop", run: there.runId }] }),
            ]);
            expect(
              (yield* Schema.decodeUnknownEffect(Schema.Struct({ text: Schema.String }))(
                stopped.envelope.data,
              ).pipe(Effect.orDie)).text,
            ).toContain("stop: applied");
            const disposed = yield* first.cli([
              "tools",
              "call",
              "collie_do",
              "--input",
              encodeValue({
                actions: [{ kind: "disposition", run: there.runId, became: "abandoned" }],
              }),
            ]);
            expect(
              (yield* Schema.decodeUnknownEffect(Schema.Struct({ text: Schema.String }))(
                disposed.envelope.data,
              ).pipe(Effect.orDie)).text,
            ).toContain("disposition: applied");
            const beforeSsh = yield* fs.readFileString(first.sshLog);
            yield* stopHost(second.world.state);
            const away = yield* first.cli(["run", "list"]);
            expect(away.envelope.data).toMatchObject({
              machines: [expect.objectContaining({ machine: "second", state: "away" })],
            });
            // The host only asks whether an SSH connection is open; it never logs in.
            expect(
              Arr.filter(
                Str.split(
                  pipe(yield* fs.readFileString(first.sshLog), Str.slice(beforeSsh.length)),
                  "\n",
                ),
                (line) =>
                  pipe(line, Str.startsWith("login")) || pipe(line, Str.startsWith("master")),
              ),
            ).toEqual([]);
          }),
        ["attended.workflow.ts"],
      ),
    ),
  180_000,
);
