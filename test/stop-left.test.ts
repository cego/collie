import { expect, test } from "bun:test";
import { Effect } from "effect";
import { act } from "../desktop/src/bun/machine";
import type { Door } from "../desktop/src/bun/machine";
import { ActionFailed } from "../desktop/src/shared/flock";
import { controlled } from "../src/lifecycle";
import type { Controlled } from "../src/board-model";

const LEFT =
  "build-r1 is not stopped: acknowledged, its server is still up after 30s — thread t-1 turn u-1; server ws://127.0.0.1:4000 pid 42";

const answer = (over: { closed?: ReadonlyArray<string> } = {}) => ({
  runId: "r-1",
  control: "stop",
  set: true,
  applied: true,
  detail: "",
  left: [LEFT],
  ...over,
});

const answering = (done: typeof Controlled.Type) => {
  // WARNING: `Control` never asks to discard the reply, so it is the value.
  const fake: Partial<Door> = { control: () => Effect.succeed(done as never) };
  // WARNING: Control calls only control, so the partial door is the whole door.
  const desktop = fake as Door;
  return { machine: { profile: "vm", name: "vm-mk" }, desktop };
};

for (const over of [{}, { closed: [] }]) {
  test(`Desktop's stop fails with the lifecycle's sentence when the host left an agent${over.closed ? ", on a finished Run" : ""}`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const done = answer(over);
        const lifecycle = controlled({ ok: true, value: done });
        expect(lifecycle.ok).toBe(false);
        const said = lifecycle.ok ? "" : lifecycle.error.message;
        expect(said).toContain(LEFT);
        const failed = yield* act(answering(done), "stop-1", {
          _tag: "Control",
          runId: "r-1",
          control: "stop",
          set: true,
        }).pipe(Effect.flip);
        expect(failed).toEqual(
          new ActionFailed({ request: "stop-1", reason: said, refused: true }),
        );
      }),
    ));
}

test("a stop that left nothing still says Stopped", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const said = yield* act(answering({ ...answer(), left: [] }), "stop-2", {
        _tag: "Control",
        runId: "r-1",
        control: "stop",
        set: true,
      });
      expect(said).toBe("Stopped r-1");
    }),
  ));
