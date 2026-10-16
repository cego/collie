#!/usr/bin/env bun
// The fake herdr as a CLI, for the processes a test actually spawns — a detached
// driver has to exec something. In-process tests skip this wrapper (and a bun
// startup per call) and call the same core directly; see recorder.ts.

import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, Layer, Schedule } from "effect";
import { recordStart } from "../../src/starts";
import { fakeHerdr } from "./fake-herdr-core";

await Effect.runPromise(
  recordStart("herdr", Bun.argv.slice(2)).pipe(Effect.provide(BunFileSystem.layer)),
);

// A `pane list` waits while this file exists, so a test can hold an action mid-way.
const hold = Bun.env.FAKE_HERDR_HOLD_PANE_LIST;
const paneHeld =
  hold !== undefined && Bun.argv[2] === "pane" && Bun.argv[3] === "list"
    ? Effect.promise(() => Bun.file(hold).exists()).pipe(
        Effect.repeat({ while: (exists) => exists, schedule: Schedule.spaced("50 millis") }),
      )
    : Effect.void;

// A `workspace list` waits while this file exists, once as many calls as it holds have passed.
const lists = Bun.env.FAKE_HERDR_HOLD_WORKSPACE_LIST;
const passing =
  lists !== undefined &&
  Bun.argv[2] === "workspace" &&
  Bun.argv[3] === "list" &&
  (await Bun.file(lists).exists())
    ? Number(await Bun.file(lists).text())
    : null;
if (lists !== undefined && passing !== null && passing > 0)
  await Bun.write(lists, String(passing - 1));
const listHeld =
  lists !== undefined && passing === 0
    ? Effect.promise(() => Bun.file(lists).exists()).pipe(
        Effect.repeat({ while: (exists) => exists, schedule: Schedule.spaced("50 millis") }),
      )
    : Effect.void;
const held = paneHeld.pipe(Effect.andThen(listHeld));

// A `workspace list` fails while this file exists, as a herdr that does not answer.
const down = Bun.env.FAKE_HERDR_DOWN;
const unanswered =
  down !== undefined &&
  Bun.argv[2] === "workspace" &&
  Bun.argv[3] === "list" &&
  (await Bun.file(down).exists());

const { code, stdout, stderr } = unanswered
  ? { code: 1, stdout: "", stderr: "herdr is not running\n" }
  : await Effect.runPromise(
      held.pipe(
        Effect.andThen(fakeHerdr(Bun.argv.slice(2))),
        Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
      ),
    );
if (stderr) await Bun.write(Bun.stderr, stderr);
if (stdout) await Bun.write(Bun.stdout, stdout);
globalThis.process.exitCode = code;
