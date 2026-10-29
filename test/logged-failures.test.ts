// A failure that loses part of a Run's record is in the host log, and a Run that loses
// nothing leaves no Error there.

import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { HostReply, openHost, until, workspace } from "./support/host";

const suspended = (reply: typeof HostReply.Type) => reply.status === "suspended";
const complete = (reply: typeof HostReply.Type) => reply.status === "complete";

const errorLines = (log: string) => log.split("\n").filter((line) => line.includes("level=ERROR"));

test(
  "a Run that finishes cleanly leaves no Error-level line in the host log",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { wf, state } = yield* workspace("collie-logged-clean-");
        const host = yield* openHost(state);
        yield* host.ask({ op: "load", entry: `${wf}/echo.workflow.ts` });
        yield* host.ask({ op: "start", id: "echo", runId: "e1", input: { text: "hi", times: 1 } });
        yield* host.until({ op: "poll", id: "echo", runId: "e1" }, suspended);
        yield* host.ask({ op: "answer", id: "echo", runId: "e1", decision: "keep", value: "yes" });
        yield* host.until({ op: "poll", id: "echo", runId: "e1" }, complete);
        yield* host.stop;
        expect(errorLines(yield* fs.readFileString(`${state}/host.log`))).toEqual([]);
      }).pipe(Effect.scoped),
    ),
  120_000,
);

test(
  "a Run whose final card cannot be written still completes, and the host log says why",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { wf, state } = yield* workspace("collie-logged-card-");
        const host = yield* openHost(state);
        yield* host.ask({ op: "load", entry: `${wf}/echo.workflow.ts` });
        yield* host.ask({ op: "start", id: "echo", runId: "e1", input: { text: "hi", times: 1 } });
        yield* host.until({ op: "poll", id: "echo", runId: "e1" }, suspended);
        const [runId] = yield* fs.readDirectory(`${state}/runs`);
        const cards = `${state}/runs/${runId}/steering/cards.jsonl`;
        yield* fs.remove(cards, { force: true });
        yield* fs.makeDirectory(cards, { recursive: true });

        yield* host.ask({ op: "answer", id: "echo", runId: "e1", decision: "keep", value: "yes" });
        const done = yield* host.until({ op: "poll", id: "echo", runId: "e1" }, complete);
        expect(done.value).toBe("<hi>#1|yes");
        const logged = yield* until(
          () =>
            fs
              .readFileString(`${state}/host.log`)
              .pipe(Effect.map((log) => errorLines(log).filter((line) => line.includes(cards)))),
          (lines) => lines.length > 0,
        );
        expect(logged[0]).toContain("cause=");
        yield* host.stop;
      }).pipe(Effect.scoped),
    ),
  120_000,
);
