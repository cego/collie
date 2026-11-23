import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Result, Schema, flow } from "effect";
import { registeredAt } from "./support/records";
import { exec } from "./support/command";
import { until } from "./support/host";
import { collie, proves, type World } from "./support/world";

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

const SUITE = `#!/bin/sh
i=1
while [ $i -le 5000 ]; do
  if [ $i -eq 1000 ]; then
    echo "test/a.test.ts:"
    echo "(fail) adds one [1.00ms]"
    echo "(fail) adds two [1.00ms]"
    echo "test/b.test.ts:"
    echo "(fail) subtracts > from zero [2.00ms]"
  fi
  echo "line $i"
  i=$((i + 1))
done
echo " 3 fail"
exit 1
`;

const attendedRun = (world: World) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const outputs = `${world.home}/outputs.json`;
    yield* fs.writeFileString(outputs, "[null]");
    yield* fs.writeFileString(`${world.project}/thing.txt`, "one\n");
    yield* exec(["git", "add", "-A"], { cwd: world.project });
    yield* exec(
      ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "one"],
      { cwd: world.project },
    );
    const started = yield* collie(world, ["run", "start", "attended", "--input", "work=it"], {
      FAKE_HERDR_OUTPUTS: outputs,
    });
    const { runId } = yield* Schema.decodeUnknownEffect(Schema.Struct({ runId: Schema.String }))(
      started.envelope.data,
    );
    const agent = Option.getOrThrow(
      Arr.findFirst(
        yield* until(
          () => registeredAt(world.state),
          (all) => Arr.some(all, (entry) => entry.runId === runId),
        ),
        (entry) => entry.runId === runId,
      ),
    );
    const suite = `${world.home}/suite.sh`;
    yield* fs.writeFileString(suite, SUITE);
    yield* fs.chmod(suite, 0o755);
    return { runId, agent: agent.agent, suite };
  }).pipe(Effect.orDie);

test("verify from a terminal that is no agent's streams every line the command printed", () =>
  proves(
    "collie-verify-stream-",
    (world) =>
      Effect.gen(function* () {
        const { runId, suite } = yield* attendedRun(world);
        let streamed = "";
        const said = yield* collie(
          world,
          ["verify", "--run", runId, "--cwd", world.project, "--name", "suite", "--", suite],
          { HERDR_PANE_ID: "not-an-agent" },
          (text) => Effect.sync(() => void (streamed += text)),
        );
        expect(said.exit).toBe(1);
        const lines = new Set(Str.split(streamed, "\n"));
        expect(
          Arr.every(
            Arr.makeBy(5000, (i) => `line ${i + 1}`),
            (one) => lines.has(one),
          ),
        ).toBe(true);
      }),
    ["attended.workflow.ts"],
  ));

const Answer = Schema.Struct({
  verification: Schema.Struct({
    exit: Schema.Int,
    result: Schema.String,
    tail: Schema.Struct({ stdout: Schema.String, stderr: Schema.String }),
  }),
  failed: Schema.Array(Schema.String),
  more: Schema.Int,
  log: Schema.String,
  bounded: Schema.String,
});

test("verify from an agent's pane answers the failure, its tests, the tail and the log, not the stream", () =>
  proves(
    "collie-verify-agent-",
    (world) =>
      Effect.gen(function* () {
        const { runId, agent, suite } = yield* attendedRun(world);
        let streamed = "";
        const said = yield* collie(
          world,
          ["verify", "--cwd", world.project, "--name", "suite", "--", suite],
          { COLLIE_AGENT: agent },
          (text) => Effect.sync(() => void (streamed += text)),
        );
        expect(said.exit).toBe(1);
        const answer = yield* Schema.decodeUnknownEffect(Answer)(said.envelope.data);
        expect(answer.verification.exit).toBe(1);
        expect(answer.verification.result).toBe("fail");
        expect(answer.failed).toEqual([
          "test/a.test.ts > adds one",
          "test/a.test.ts > adds two",
          "test/b.test.ts > subtracts > from zero",
        ]);
        expect(answer.more).toBe(0);
        expect(answer.verification.tail.stdout).toContain("line 5000");
        expect(answer.log).toMatch(/^evidence:verify\/.+\.log$/);
        expect(answer.bounded).toContain(`collie run read ${runId} ${answer.log}`);
        // WARNING: both lines sit far before the 4 KB tail.
        const everything = `${streamed}${encode(said.envelope)}`;
        expect(everything).not.toContain("line 1000");
        expect(everything).not.toContain("line 2500");
      }),
    ["attended.workflow.ts"],
  ));
