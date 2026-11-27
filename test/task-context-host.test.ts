import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { frontDoor, socketOf } from "../src/host";
import { pinOf } from "../src/task-context";
import { collie, proves } from "./support/world";
import { recordsAt } from "./support/records";
import { FIRST_SPEC, SECOND_RATIONALE, SECOND_SPEC } from "./task-context.fixture";

const plantPlan = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${dir}/issues`, { recursive: true });
    yield* fs.writeFileString(
      `${dir}/SPEC.md`,
      "# Handle duplicate refunds\n\n## Objective\n\nRefund once, even at the same time.\n\n## Done when\n\nTwo refunds leave one refund.\n",
    );
    yield* fs.writeFileString(
      `${dir}/issues/03-concurrent.md`,
      "# Refund two concurrent requests\n\n**Blocked by:** none\n**Repo:** .\n\n## Acceptance criteria\n\n- [ ] Two requests arriving together refund once.\n\n## After merge\n\n- Watch the refund ledger.\n",
    );
    yield* fs.writeFileString(
      `${dir}/issues/04-retry.md`,
      "# Refund a retry once\n\n**Blocked by:** 03\n**Repo:** .\n\n## Acceptance criteria\n\n- [ ] A retried request refunds once.\n",
    );
  });

test("a comment on a queued Task is still its Activity when the first Run starts, and that Run's hand-over names it", () =>
  proves(
    "collie-task-context-",
    (world) =>
      Effect.gen(function* () {
        yield* collie(world, ["board"]);
        const door = yield* frontDoor(socketOf(world.state)).pipe(Effect.orDie);
        const [made] = yield* door.act({
          actions: [{ kind: "create_task" as const, instruction: "Refund duplicate charges" }],
          request: "create-1",
        });
        const task = made?.task ?? "";
        expect(task).not.toBe("");

        const [posted] = yield* door.act({
          actions: [
            {
              kind: "task_post" as const,
              task,
              text: "Refund the duplicate, not the original.",
            },
          ],
          request: "post-1",
        });
        expect(posted?.state).toBe("applied");

        const queued = yield* door.taskContext({ task });
        expect(Arr.map(queued?.activity.posts ?? [], (one) => one.text)).toEqual([
          "Refund the duplicate, not the original.",
        ]);
        expect(queued?.activity.posts[0]?.actor.kind).toBe("human");
        expect(queued?.revisions).toEqual([]);
        expect(queued?.instruction).toBe("Refund duplicate charges");

        const [edited] = yield* door.act({
          actions: [
            {
              kind: "task_edit_spec" as const,
              task,
              text: FIRST_SPEC,
              base_revision: 0,
              rationale: "From the operator's one sentence.",
            },
          ],
          request: "edit-1",
        });
        expect(edited?.state).toBe("applied");

        const stale = yield* door.act({
          actions: [
            {
              kind: "task_edit_spec" as const,
              task,
              text: SECOND_SPEC,
              base_revision: 0,
              rationale: SECOND_RATIONALE,
            },
          ],
          request: "edit-2",
        });
        expect(stale[0]?.state).toBe("failed");
        expect(stale[0]?.note).toContain("revision 1");

        const compared = yield* door.taskContext({ task });
        expect(compared?.current?.objective).toBe("Refund a duplicate charge once per order.");
        expect(Arr.map(compared?.current?.tickets ?? [], (one) => one.id)).toEqual(["1", "2"]);
        expect(Arr.map(compared?.activity.posts ?? [], (one) => one.kind)).toContain("amended");

        const started = yield* door.start({
          project: world.project,
          id: "plain",
          request: "start-1",
          input: { note: "refund" },
          task,
        });
        expect(started.runId).not.toBe("");

        const after = yield* door.taskContext({ task });
        expect(Arr.map(after?.activity.posts ?? [], (one) => one.kind)).toContain("run_started");
        expect(Arr.map(after?.activity.posts ?? [], (one) => one.text)).toContain(
          "Refund the duplicate, not the original.",
        );

        const pin = yield* Effect.provide(pinOf(started.runId), recordsAt(world.state));
        expect(pin?.revision).toBe(1);
        expect(pin?.briefing).toContain("Refund the duplicate, not the original.");
        expect(pin?.briefing).toContain(
          "A repeated refund request leaves the order refunded once.",
        );

        const plan = `${world.state}/runs/${started.runId}/plan`;
        yield* plantPlan(plan);
        const [adopted] = yield* door.act({
          actions: [
            {
              kind: "task_adopt_plan" as const,
              task,
              run: started.runId,
              rationale: "Two refunds can arrive at once.",
            },
          ],
          request: "adopt-1",
        });
        expect(adopted?.state).toBe("applied");

        const two = yield* door.taskContext({ task, compare: { from: 1, to: 2 } });
        expect(two?.current?.revision).toBe(2);
        expect(Arr.map(two?.current?.tickets ?? [], (one) => one.id)).toEqual(["3", "4"]);
        expect(Arr.map(two?.revisions[0]?.tickets ?? [], (one) => one.id)).toEqual(["1", "2"]);
        expect(Arr.map(two?.comparison?.addedTickets ?? [], (one) => one.id)).toEqual(["3", "4"]);
        expect(two?.comparison?.addedTickets[1]?.blockedBy).toEqual(["3"]);
        expect(two?.comparison?.rationale).toBe("Two refunds can arrive at once.");

        const second = yield* door.start({
          project: world.project,
          id: "plain",
          request: "start-2",
          input: { note: "again" },
          task,
        });
        const secondPin = yield* Effect.provide(pinOf(second.runId), recordsAt(world.state));
        expect(secondPin?.revision).toBe(2);
        expect(secondPin?.revision).not.toBe(pin?.revision);
        expect(
          (yield* Effect.provide(pinOf(started.runId), recordsAt(world.state)))?.briefing,
        ).toBe(pin?.briefing);
      }),
    ["plain.workflow.ts"],
  ));
