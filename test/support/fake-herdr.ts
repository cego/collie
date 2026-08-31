#!/usr/bin/env bun
// The fake herdr as a CLI, for the processes a test actually spawns — a detached
// driver has to exec something. In-process tests skip this wrapper (and a bun
// startup per call) and call the same core directly; see recorder.ts.

import { fakeHerdr } from "./fake-herdr-core";
import { runEffect } from "./effect";

const { code, stdout, stderr } = await runEffect(fakeHerdr(Bun.argv.slice(2)));
if (stderr) await Bun.write(Bun.stderr, stderr);
if (stdout) await Bun.write(Bun.stdout, stdout);
globalThis.process.exitCode = code;
