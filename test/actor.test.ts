// Who is acting: every operation on a Run is recorded with the front door its channel
// declared, and a request id sent again is the same operation, not a second one.

import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { readAudit } from "../src/audit";
import { cliOrigin } from "../src/commands/shared";
import { currentEnv } from "../src/env";
import { stopRun } from "../src/flows";
import { connect, frontDoor } from "../src/host";
import { runDir } from "../src/engine";
import { stopHost, until } from "./support/host";
import { collie, proves } from "./support/world";

/** What the Run's audit trail says was done, by whom, under which request. */
const audited = (state: string, runId: string) =>
  readAudit(runDir(state, runId)).pipe(
    Effect.map((lines) =>
      lines.map((line) => [line.operation, line.actor.origin, line.actor.requestId]),
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
          const door = yield* frontDoor(world.state);
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
          expect(lines.find((line) => line.operation === "hold")?.reason).toBe("lunch");
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
          expect(trail.map(([operation, origin]) => [operation, origin])).toEqual([
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
          const door = yield* frontDoor(world.state);
          yield* door.declare({ frontDoor: "desktop", from: { client: "mk-pc" } });
          const startable = yield* door.workflows({ project: world.project });
          expect(startable.find((one) => one.id === "offered")?.inputs).toEqual([
            expect.objectContaining({ name: "note", required: true }),
          ]);
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
          expect(offers.map((offer) => offer.id)).toContain("look-again");
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
          const door = yield* frontDoor(world.state);
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
          expect(trail.map(({ operation, actor }) => [operation, actor.said])).toEqual([
            ["start", "start the proof"],
            ["hold", "hold it"],
          ]);
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      ["proof.workflow.ts", "helper.ts", "notes.md"],
    ),
  120_000,
);
