// A module that declares its Steps and a path, taking one of several shapes so a test can
// read its Flow at each: an agent, a question and an agent; a list; rounds; a Step off the
// path; a new forecast; a stop, a crash or a park inside a Step; a durable timer.
//
// A Step that waits on a gate goes on once the file `<gates>/<name>` exists.

import { Host, Run, agentWork, ask, defineWorkflow, forecast, step } from "collie";
import { Effect, FileSystem, Schedule, Schema } from "effect";
import * as DurableClock from "effect/workflow/DurableClock";
import * as Workflow from "effect/workflow/Workflow";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";

const build = step({ id: "build", title: "Build it", kind: "agent", role: "implementer" });
const decide = step({ id: "decide", title: "Decide", kind: "question" });
const ship = step({ id: "ship", title: "Ship it", kind: "agent", produces: "merge-request" });
const slice = step({ id: "slice", title: "Build a slice", kind: "agent" });
const review = step({ id: "review", title: "Review", kind: "agent", produces: "review" });
const extra = step({ id: "extra", title: "Look again", kind: "check" });
const polish = step({ id: "polish", title: "Polish", kind: "agent" });
const wrap = step({ id: "wrap", title: "Wrap up", kind: "check" });
const nap = step({ id: "nap", title: "Wait an hour", kind: "check" });

const Verdict = Schema.Struct({ verdict: Schema.String });

const gate = (gates: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.exists(`${gates}/${name}`).pipe(
      Effect.orElseSucceed(() => false),
      Effect.repeat({ until: (open) => open, schedule: Schedule.spaced("100 millis") }),
    );
  });

const agent = (operation: string) =>
  agentWork({
    operation,
    role: "implementer",
    instructions: `Do ${operation}.`,
    input: {},
    output: Verdict,
  });

const PATHS = {
  declared: [build, decide, ship],
  items: [slice],
  rounds: [review],
  offpath: [build, ship],
  reforecast: [build, decide, ship],
  stop: [build, ship, wrap],
  crash: [build, ship],
  parks: [build],
  timer: [nap],
};

const Mode = Schema.Literals([
  "declared",
  "items",
  "rounds",
  "offpath",
  "reforecast",
  "stop",
  "crash",
  "parks",
  "timer",
]);

export default defineWorkflow({
  id: "stepped",
  title: "Take declared Steps",
  description: "Declares its Steps and a path, in the shape its mode names.",
  input: Schema.Struct({ mode: Mode, gates: Schema.String }),
  hints: { mode: "goal" },
  output: Schema.String,
  // The longest path: each mode forecasts its own before its first Step.
  path: [build, decide, ship],
  run: ({ input }) =>
    Effect.gen(function* () {
      const { gates } = input;
      yield* forecast(PATHS[input.mode]);
      switch (input.mode) {
        case "declared":
          yield* build(agent("build"));
          yield* decide(ask({ name: "go", prompt: "Ship it?", options: ["yes", "no"] }));
          yield* ship(agent("ship"));
          yield* agent("tidy");
          break;
        case "items": {
          const items = ["a", "b", "c"];
          yield* Effect.forEach(items, (item) => slice(gate(gates, item), { item, items }));
          break;
        }
        case "rounds":
          for (const round of [1, 2]) yield* review(Effect.void, { round, of: 2 });
          break;
        case "offpath":
          yield* build(Effect.void);
          yield* extra(Effect.void);
          yield* ship(Effect.void);
          break;
        case "reforecast":
          yield* build(Effect.void);
          yield* forecast([build, polish]);
          yield* gate(gates, "polish");
          yield* polish(Effect.void);
          break;
        case "stop":
          yield* build(Effect.void);
          yield* ship(gate(gates, "ship"));
          yield* wrap(Effect.void);
          break;
        case "crash":
          yield* build(gate(gates, "build"));
          yield* ship(Effect.void);
          break;
        case "parks":
          yield* build(
            Effect.gen(function* () {
              const open = yield* (yield* FileSystem.FileSystem)
                .exists(`${gates}/build`)
                .pipe(Effect.orElseSucceed(() => false));
              if (open) return;
              yield* (yield* Host).parked((yield* Run).id, "the gate is shut");
              return yield* Workflow.suspend(yield* WorkflowInstance);
            }),
          );
          break;
        case "timer":
          yield* nap(DurableClock.sleep({ name: "nap", duration: "1 hour" }));
          break;
      }
      return input.mode;
    }),
});
