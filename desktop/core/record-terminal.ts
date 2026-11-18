import { parseArgs } from "node:util";
import { Effect, Stream } from "effect";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { openTerminal } from "../../desktop/src/bun/terminal";
import { localRoute } from "../../desktop/src/bun/machine";
import type { PaneAt } from "../../src/board-model";

const { values: flags } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    core: { type: "string" },
    out: { type: "string" },
    cols: { type: "string", default: "100" },
    rows: { type: "string", default: "30" },
    type: { type: "string", multiple: true, default: [] },
    idle: { type: "string", default: "1500" },
  },
});
if (flags.out === undefined || flags.core === undefined) {
  console.error("usage: --out <file> --core <core terminal>");
  process.exit(2);
}
const out = flags.out;
const idle = Number(flags.idle);
const place = { session: null, workspace: "recording", tab: null };
const at: PaneAt = { ...place, pane: flags.core, core: flags.core };

let lastEvent = Date.now();
const lines: Array<string> = [];
const settled = Effect.promise(async () => {
  while (Date.now() - lastEvent < idle) await Bun.sleep(50);
});

BunRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const opened = yield* openTerminal(
        Effect.succeed(at),
        localRoute([], "local"),
        Number(flags.cols),
        Number(flags.rows),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(opened.events, (event) =>
          Effect.sync(() => {
            lastEvent = Date.now();
            lines.push(JSON.stringify(event));
          }),
        ),
      );
      yield* settled;
      for (const text of flags.type) {
        yield* opened.send({ type: "terminal.input", text });
        lastEvent = Date.now();
        yield* settled;
      }
      yield* Effect.promise(() => Bun.write(out, `${lines.join("\n")}\n`));
    }),
  ).pipe(Effect.provide(BunServices.layer)),
);
