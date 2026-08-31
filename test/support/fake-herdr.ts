#!/usr/bin/env bun
// The fake herdr as a CLI, for the processes a test actually spawns — a detached
// driver has to exec something. In-process tests skip this wrapper (and a bun
// startup per call) and call the same core directly; see recorder.ts.

import { fakeHerdr } from "./fake-herdr-core";

const { code, stdout, stderr } = fakeHerdr(process.argv.slice(2));
if (stderr) process.stderr.write(stderr);
if (stdout) process.stdout.write(stdout);
process.exit(code);
