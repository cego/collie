// Who is acting: every operation on a Run is recorded with the front door its channel
// declared, and a request id sent again is the same operation, not a second one.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema, flow, Result } from "effect";
import { readAudit } from "../src/audit";
import { cliOrigin } from "../src/commands/shared";
import { currentEnv } from "../src/env";
import { stopRun } from "../src/flows";
import { connect, frontDoor, socketOf } from "../src/host";
import { foundationLayer, runDir } from "../src/engine";
import { Host } from "../src/sdk";
import { everyRegistered } from "../src/registry";
import { readSeen } from "../src/seen";
import { stopHost, until } from "./support/host";
import { collie, proves } from "./support/world";

const asJson = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

/** Who the Run's agents are told started it, read once its host has stopped. */
const startedOf = (state: string, runId: string) =>
  Effect.gen(function* () {
    return (yield* (yield* Host).place(runId)).authority.started;
  }).pipe(Effect.provide(foundationLayer({ dir: state })), Effect.scoped);

/** What the Run's audit trail says was done, by whom, under which request. */
const audited = (state: string, runId: string) =>
  readAudit(runDir(state, runId)).pipe(
    Effect.map((lines) =>
      Arr.map(lines, (line) => [line.operation, line.actor.origin, line.actor.requestId]),
    ),
  );

test(
  "every operation on a board channel is recorded as the board's, and a retried request is one operation",
  () =>
    proves(
      "collie-actor-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const host = yield* connect(world.state);
          const door = yield* frontDoor(socketOf(world.state));
          yield* door.declare({ frontDoor: "board" });
          // A channel is the front door it first said it was.
          expect((yield* door.declare({ frontDoor: "cli-tty" }).pipe(Effect.flip)).reason).toBe(
            "this channel is already board",
          );

          const started = yield* door.start({
            project: world.project,
            id: "proof",
            request: "start-1",
            input: { note: "who" },
          });
          const runId = started.runId;
          yield* until(
            () => host.status({ runId }),
            (status) => status.status === "suspended",
          );
          const again = yield* door.start({
            project: world.project,
            id: "proof",
            request: "start-1",
            input: { note: "who" },
          });
          expect(again).toMatchObject({ runId, fresh: false });

          yield* door.control({ runId, control: "hold", set: true, request: "hold-1" });
          yield* door.control({ runId, control: "hold", set: false, request: "unhold-1" });
          // The first hold, sent again: the Run stays released.
          yield* door.control({ runId, control: "hold", set: true, request: "hold-1" });
          expect((yield* host.run({ runId }))?.controls).toEqual([]);

          yield* door.control({ runId, control: "stop", set: true, request: "stop-1" });
          yield* door.resume({ runId, request: "resume-1" });
          yield* door.answer({ runId, decision: "decision", value: "go", request: "answer-1" });
          yield* door.answer({ runId, decision: "decision", value: "go", request: "answer-1" });

          expect(yield* audited(world.state, runId)).toEqual([
            ["start", "board", "start-1"],
            ["hold", "board", "hold-1"],
            ["unhold", "board", "unhold-1"],
            ["stop", "board", "stop-1"],
            ["resume", "board", "resume-1"],
            ["answer", "board", "answer-1"],
          ]);
          expect(yield* fs.exists(`${runDir(world.state, runId)}/operations.jsonl`)).toBe(true);
          // A Run nobody has is refused, and nothing is audited for it, inside or outside.
          for (const unknown of ["r-nobody", "../../escaped"]) {
            const refused = yield* door
              .control({ runId: unknown, control: "hold", set: true, request: "hold-x" })
              .pipe(Effect.flip);
            expect(refused.reason).toBe(`no Run ${unknown}`);
            expect(
              (yield* door.resume({ runId: unknown, request: "r-x" }).pipe(Effect.flip)).reason,
            ).toBe(`no Run ${unknown}`);
            expect(yield* fs.exists(runDir(world.state, unknown))).toBe(false);
          }
          yield* stopHost(world.state);
          expect(yield* startedOf(world.state, runId)).toEqual({ door: "board", words: "who" });
        }).pipe(Effect.orDie),
      ["proof.workflow.ts", "helper.ts", "notes.md"],
    ),
  120_000,
);

test(
  "a hold from the command line carries its reason onto the record the board reads",
  () =>
    proves(
      "collie-actor-hold-",
      (world) =>
        Effect.gen(function* () {
          const host = yield* connect(world.state);
          const { runId } = yield* host.start({
            project: world.project,
            id: "proof",
            request: "start-1",
            input: { note: "why" },
          });
          yield* until(
            () => host.status({ runId }),
            (status) => status.status === "suspended",
          );
          const held = yield* collie(world, ["run", "hold", runId, "--reason", "lunch"]);
          expect(held.envelope.ok).toBe(true);
          const lines = yield* readAudit(runDir(world.state, runId));
          expect(
            Option.getOrUndefined(Arr.findFirst(lines, (line) => line.operation === "hold"))
              ?.reason,
          ).toBe("lunch");
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      ["proof.workflow.ts", "helper.ts", "notes.md"],
    ),
  120_000,
);

test(
  "a channel that declares nothing is never a human's, and an offer is recorded on the Run it came from",
  () =>
    proves(
      "collie-actor-offer-",
      (world) =>
        Effect.gen(function* () {
          const host = yield* connect(world.state);
          const started = yield* host.start({
            project: world.project,
            id: "offered",
            request: "start-offered",
            input: { note: "x" },
          });
          yield* until(
            () => host.status({ runId: started.runId }),
            (status) => status.status === "complete",
          );
          const child = yield* host.invoke({
            runId: started.runId,
            offer: "look-again",
            input: { note: "y" },
            request: "invoke-1",
          });
          expect(yield* audited(world.state, started.runId)).toEqual([
            ["start", "cli", "start-offered"],
            ["invoke", "cli", "invoke-1"],
          ]);
          yield* until(
            () => host.status({ runId: child.runId }),
            (status) => status.status === "complete",
          );
          yield* stopHost(world.state);
          expect(yield* startedOf(world.state, started.runId)).toBeNull();
        }).pipe(Effect.orDie),
      ["offered.workflow.ts", "graded.workflow.ts"],
    ),
  120_000,
);

test(
  "the board's own stop goes through the operation, and is recorded as the board's",
  () =>
    proves(
      "collie-actor-tui-",
      (world) =>
        Effect.gen(function* () {
          const started = yield* collie(world, ["run", "start", "proof", "--input", "note=x"]);
          expect(started.envelope.ok).toBe(true);
          const runId = yield* Schema.decodeUnknownEffect(Schema.Struct({ runId: Schema.String }))(
            started.envelope.data,
          ).pipe(Effect.map((data) => data.runId));
          const env = yield* currentEnv.pipe(Effect.orDie);
          expect(yield* stopRun(env, runId)).toMatch(/^Stop/);
          const trail = yield* audited(world.state, runId);
          yield* stopHost(world.state);
          expect(Arr.map(trail, ([operation, origin]) => [operation, origin])).toEqual([
            ["start", "cli"],
            ["stop", "board"],
          ]);
        }),
      ["proof.workflow.ts", "helper.ts", "notes.md"],
    ),
  120_000,
);

test("a terminal is a human's only in a pane herdr does not report as an agent's", () => {
  expect(cliOrigin({ terminal: false, pane: null, agentPanes: [] })).toBe("cli");
  expect(cliOrigin({ terminal: true, pane: null, agentPanes: [] })).toBe("cli-tty");
  expect(cliOrigin({ terminal: true, pane: "1-2", agentPanes: ["1-3"] })).toBe("cli-tty");
  expect(cliOrigin({ terminal: true, pane: "1-2", agentPanes: ["1-2"] })).toBe("cli");
  // herdr could not say, so nobody can show it is not an agent's.
  expect(cliOrigin({ terminal: true, pane: "1-2", agentPanes: null })).toBe("cli");
});

test(
  "a front door reads what a project can start and what a finished Run offers, from the host",
  () =>
    proves(
      "collie-actor-reads-",
      (world) =>
        Effect.gen(function* () {
          const host = yield* connect(world.state);
          const door = yield* frontDoor(socketOf(world.state));
          yield* door.declare({ frontDoor: "desktop", from: { client: "mk-pc" } });
          const startable = yield* door.workflows({ project: world.project });
          expect(
            Option.getOrUndefined(Arr.findFirst(startable, (one) => one.id === "offered"))?.inputs,
          ).toEqual([expect.objectContaining({ name: "note", required: true })]);
          const { runId } = yield* door.start({
            project: world.project,
            id: "offered",
            request: "start-1",
            input: {},
            text: { note: "typed" },
          });
          yield* until(
            () => host.status({ runId }),
            (status) => status.status === "complete",
          );
          const offers = yield* door.offers({ runId });
          expect(Arr.map(offers, (offer) => offer.id)).toContain("look-again");
          const refused = yield* door.offers({ runId: "r-nobody" }).pipe(Effect.flip);
          expect(refused._tag).toBe("HostRefused");
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      ["offered.workflow.ts", "graded.workflow.ts"],
    ),
  120_000,
);

test(
  "a chat channel says each turn's words again, and each operation is recorded with the words of its turn",
  () =>
    proves(
      "collie-actor-turns-",
      (world) =>
        Effect.gen(function* () {
          const host = yield* connect(world.state);
          const door = yield* frontDoor(socketOf(world.state));
          const conversation = "flock@mk-pc";
          yield* door.declare({ frontDoor: "chat", conversation, said: "start the proof" });
          const { runId } = yield* door.start({
            project: world.project,
            id: "proof",
            request: "start-1",
            input: { note: "turns" },
          });
          yield* until(
            () => host.status({ runId }),
            (status) => status.status === "suspended",
          );
          yield* door.declare({ frontDoor: "chat", conversation, said: "hold it" });
          yield* door.control({ runId, control: "hold", set: true, request: "hold-1" });

          const trail = yield* readAudit(runDir(world.state, runId));
          expect(Arr.map(trail, ({ operation, actor }) => [operation, actor.said])).toEqual([
            ["start", "start the proof"],
            ["hold", "hold it"],
          ]);
          yield* stopHost(world.state);
          // The human's own words that turn, never chat's input.
          expect(yield* startedOf(world.state, runId)).toEqual({
            door: "chat",
            words: "start the proof",
          });
        }).pipe(Effect.orDie),
      ["proof.workflow.ts", "helper.ts", "notes.md"],
    ),
  120_000,
);

test(
  "a chat's turn that carried files is recorded with their names beside the human's words",
  () =>
    proves(
      "collie-actor-files-",
      (world) =>
        Effect.gen(function* () {
          const host = yield* connect(world.state);
          const door = yield* frontDoor(socketOf(world.state));
          yield* door.declare({
            frontDoor: "chat",
            conversation: "flock@mk-pc",
            said: "start a proof for this",
            attachments: ["shot.png"],
          });
          const { runId } = yield* door.start({
            project: world.project,
            id: "proof",
            request: "start-1",
            input: { note: "files" },
          });
          yield* until(
            () => host.status({ runId }),
            (status) => status.status === "suspended",
          );

          const [line] = yield* readAudit(runDir(world.state, runId));
          expect(line?.actor).toMatchObject({
            origin: "chat",
            said: "start a proof for this",
            attachments: ["shot.png"],
          });
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      ["proof.workflow.ts", "helper.ts", "notes.md"],
    ),
  120_000,
);

test(
  "seen from the command line is the CLI's, and from an agent's collie_do the agent's",
  () =>
    proves(
      "collie-actor-seen-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputs = `${world.home}/outputs.json`;
          yield* fs.writeFileString(outputs, '[{"verdict":"done"}]');
          const attended = yield* collie(
            world,
            ["run", "start", "attended", "--input", "work=seen"],
            {
              FAKE_HERDR_OUTPUTS: outputs,
            },
          );
          const byAgent = (yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(attended.envelope.data).pipe(Effect.orDie)).runId;
          // Connected after the start, so the host is the one the CLI spawned with the Outputs.
          const host = yield* connect(world.state);
          yield* until(
            () => host.run({ runId: byAgent }),
            (view) => Arr.some(view?.waiting ?? [], (one) => one.answer === null),
          );
          const agent = Option.getOrUndefined(
            Arr.findFirst(yield* everyRegistered(world.state), (entry) => entry.runId === byAgent),
          )!;
          const { runId: byCli } = yield* host.start({
            project: world.project,
            id: "plain",
            request: "start-cli",
            input: { note: "seen" },
          });
          const asAgent = yield* collie(
            world,
            [
              "tools",
              "call",
              "collie_do",
              "--input",
              asJson({ actions: [{ kind: "seen", run: byAgent }] }),
            ],
            { COLLIE_RUN: byAgent, COLLIE_AGENT: agent.agent },
          );
          expect(asAgent.envelope.data).toMatchObject({
            text: expect.stringContaining("seen: applied"),
          });
          expect(
            (yield* collie(world, ["run", "seen", byCli, "--request-id", "seen-cli"])).envelope.ok,
          ).toBe(true);

          const seenBy = (runId: string) =>
            Effect.map(readSeen(runDir(world.state, runId)), (lines) =>
              Arr.map(lines, (one) => one.by),
            );
          expect(yield* seenBy(byAgent)).toEqual([expect.stringMatching(/^agent:/)]);
          expect(
            Option.getOrUndefined(
              Arr.findFirst(
                yield* readAudit(runDir(world.state, byAgent)),
                (line) => line.operation === "seen",
              ),
            )?.actor,
          ).toMatchObject({ origin: "agent", from: { run: byAgent, agent: agent.agent } });
          expect(yield* seenBy(byCli)).toEqual(["cli:seen-cli"]);
          expect(yield* audited(world.state, byCli)).toContainEqual(["seen", "cli", "seen-cli"]);
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      ["attended.workflow.ts", "plain.workflow.ts"],
    ),
  120_000,
);
