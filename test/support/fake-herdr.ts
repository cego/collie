#!/usr/bin/env bun
// The fake herdr as a CLI, for the processes a test actually spawns — a detached
// driver has to exec something. In-process tests skip this wrapper (and a bun
// startup per call) and call the same core directly; see recorder.ts.

import { Effect, Schedule } from "effect";
import { fakeHerdr } from "./fake-herdr-core";
import { runEffect } from "./effect";

// A `pane list` waits while this file exists, so a test can hold an action mid-way.
const hold = Bun.env.FAKE_HERDR_HOLD_PANE_LIST;
const held =
  hold !== undefined && Bun.argv[2] === "pane" && Bun.argv[3] === "list"
    ? Effect.promise(() => Bun.file(hold).exists()).pipe(
        Effect.repeat({ while: (exists) => exists, schedule: Schedule.spaced("50 millis") }),
      )
    : Effect.void;

const { code, stdout, stderr } = await runEffect(
  held.pipe(Effect.andThen(fakeHerdr(Bun.argv.slice(2)))),
);
if (stderr) await Bun.write(Bun.stderr, stderr);
if (stdout) await Bun.write(Bun.stdout, stdout);
globalThis.process.exitCode = code;
