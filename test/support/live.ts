// A contract against an installed harness, rather than against a mock.

import { test } from "bun:test";

/**
 * The test, where that harness is on this machine, and skipped where it is not. What
 * these ask — does the installed Claude still take the flag the adapter passes — has no
 * answer on a runner with no Claude on it, and asserting one there fails on the harness's
 * absence rather than on the contract.
 */
export const onMachineWith = (harness: string) => (Bun.which(harness) === null ? test.skip : test);
