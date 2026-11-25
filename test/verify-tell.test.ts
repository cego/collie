import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { AgentStatus } from "../src/herdr";
import { tellVerifyEnded } from "../src/verify-tell";
import type { Verification } from "../src/verify-model";
import { runEffect } from "./support/effect";

const verification: Verification = {
  id: "v1",
  run: "r1",
  name: "unit",
  executable: "/usr/bin/true",
  argv: [],
  cwd: "/repo",
  start: { head_sha: "abc", fingerprint: "t1" },
  end: { head_sha: "abc", fingerprint: "t1" },
  exit: 0,
  seconds: 1,
  tail: { stdout: "", stderr: "" },
  expect: "pass",
  result: "pass",
  at: "2026-09-11T10:00:00.000Z",
  by: "collie",
};

const ran = (status: AgentStatus) =>
  runEffect(
    Effect.gen(function* () {
      const pushed: Array<string> = [];
      yield* tellVerifyEnded(
        {
          collecting: {
            during: (_run, _agent, collection) => collection,
            has: () => Effect.succeed(true),
            duringVerify: (_run, _agent, verify) => verify,
            verifying: () =>
              Effect.succeed({ under: false, since: null, starts: [], ended: [], untold: [] }),
            markUntold: () => Effect.void,
          },
          status: () => Effect.succeed(status),
          steer: (tell) => Effect.sync(() => void pushed.push(tell.request)),
        },
        { run: "r1", agent: "build" },
        verification,
      );
      return pushed;
    }),
  );

test("an agent whose status cannot be read is told its verify ended", () =>
  ran("unknown").then((pushed) => expect(pushed).toEqual(["verify-v1"])));

test("a working agent is not told: the result is in its own turn", () =>
  ran("working").then((pushed) => expect(pushed).toEqual([])));

test("an idle agent is told", () =>
  ran("idle").then((pushed) => expect(pushed).toEqual(["verify-v1"])));
