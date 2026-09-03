import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { Rig } from "../support/recorder";
import { runEffect } from "../support/effect";
import { workspaceFlow } from "../../src/flows";
import { Herdr } from "../../src/herdr";
import { COLLIE_TAB } from "../../src/naming";

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* rig.startSocket();
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

/**
 * A pane that cannot render must still be readable. `bun test` has no terminal, which is
 * exactly the condition — so this is the fallback under its own reason rather than a
 * simulated one, and the renderer is never asked to start.
 */
test("with no terminal the tab prints the text board and ends", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const written: string[] = [];
      const write = process.stdout.write.bind(process.stdout);
      // SAFETY: the board writes one string and reads nothing back, so the overload
      // that takes an encoding or a callback is never the one reached here.
      process.stdout.write = ((chunk: string) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;

      const code = yield* Effect.ensuring(
        workspaceFlow(new Herdr(env), env),
        Effect.sync(() => {
          process.stdout.write = write;
        }),
      );

      expect(code).toBe(0);
      const board = written.join("");
      expect(board).toContain(`${COLLIE_TAB} — ${env.cwd.split("/").at(-1)}`);
      // The reason is on screen too: a pane that fell back says why it did.
      expect(board).toContain("no terminal on this pane");
      expect(board).toContain("p run a workflow");
    }),
  ));
