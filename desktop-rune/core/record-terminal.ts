// Records what Desktop's `terminal` stream sends for a pane, as NDJSON `TerminalEvent`s: the
// events `openTerminal` makes once the Run's pane is found, from herdr's controller for a herdr
// pane or core's attach for a core terminal, while typing each `--type` once the pane is idle.
//
//   bun desktop-rune/core/record-terminal.ts --pane <herdr pane> --out <file> --type 'ls\r'
//   bun desktop-rune/core/record-terminal.ts --core <core terminal> --out <file>

import { parseArgs } from "node:util";
import { Effect, Stream } from "effect";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { openTerminal } from "../../desktop/src/bun/terminal";
import { localRoute } from "../../desktop/src/bun/machine";
import type { PaneAt } from "../../src/board-model";

const { values: flags } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    pane: { type: "string" },
    core: { type: "string" },
    out: { type: "string" },
    cols: { type: "string", default: "100" },
    rows: { type: "string", default: "30" },
    type: { type: "string", multiple: true, default: [] },
    idle: { type: "string", default: "1500" },
  },
});
if (flags.out === undefined || (flags.pane === undefined) === (flags.core === undefined)) {
  console.error("usage: --out <file> and one of --pane <herdr pane> or --core <core terminal>");
  process.exit(2);
}
const out = flags.out;
const idle = Number(flags.idle);
const place = { session: null, workspace: "recording", tab: null };
// A core terminal is addressed by its core id in both fields.
const at: PaneAt =
  flags.core === undefined
    ? { ...place, pane: flags.pane! }
    : { ...place, pane: flags.core, core: flags.core };

let lastEvent = Date.now();
const lines: Array<string> = [];
/** Until nothing has come for `idle` ms. */
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
