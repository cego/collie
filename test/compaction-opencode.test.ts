// OpenCode's local server, as Collie's adapter reads and drives it. Two kinds of
// check: the API, against a stand-in server this test controls, so the accounting and
// the correlation can be put in states a real OpenCode will not produce on demand; and
// the contract, against the installed OpenCode's own OpenAPI document and CLI.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Path, Result } from "effect";
import { Rig } from "./support/recorder";
import { runEffect } from "./support/effect";
import { reason } from "../src/naming";
import { COMPACTION_PORTS, VERIFIED_VERSIONS, writeEvent } from "../src/compactors";
import { Unsubmitted } from "../src/compaction";
import type { AgentContext } from "../src/compaction";

let rig: Rig;
let fs: FileSystem.FileSystem;
let path: Path.Path;
let dir: string;

const opencode = COMPACTION_PORTS.opencode!;

/** One message on the stand-in session, in the shape the server reports. */
interface Line {
  id: string;
  role: "user" | "assistant";
  mode?: string;
  finish?: string;
  providerID?: string;
  modelID?: string;
  error?: { name: string; data: { message: string } };
  tokens?: {
    total?: number;
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
}

interface Fake {
  session: string;
  directory: string;
  messages: Line[];
  /** What summarizing appends, so a test can make one land, fail, or not happen. */
  onSummarize: (fake: Fake) => void;
  /** What the summarize endpoint answers with. */
  summarizeStatus: number;
  calls: string[];
}
let fake: Fake;

interface FakeServer {
  base: string;
  stop: () => void;
}
let server: FakeServer;

/** What the stand-in answers with: a session, its messages, or an error envelope. */
type Answer =
  | boolean
  | { id: string; directory: string }
  | { info: Line }[]
  | { _tag: string; message?: string };

/** The stand-in answers over HTTP, so `Response.json` is the shape it speaks. */
const json = (value: Answer, status = 200) => Response.json(value, { status });

/**
 * A stand-in OpenCode server. Not a claim about OpenCode: the shapes it answers with
 * are the ones the installed release's own OpenAPI document declares, which the
 * contract checks at the bottom of this file assert separately.
 */
function serve(): FakeServer {
  const listening = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      fake.calls.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/session" && request.method === "POST") {
        return json({ id: fake.session, directory: fake.directory });
      }
      if (url.pathname === `/session/${fake.session}` && request.method === "GET") {
        return json({ id: fake.session, directory: fake.directory });
      }
      if (url.pathname === `/session/${fake.session}/message` && request.method === "GET") {
        return json(fake.messages.map((info) => ({ info })));
      }
      if (url.pathname === `/session/${fake.session}/summarize` && request.method === "POST") {
        if (fake.summarizeStatus >= 300) {
          return json({ _tag: "ServiceUnavailableError", message: "not available yet" }, 503);
        }
        fake.onSummarize(fake);
        return json(true);
      }
      return json({ _tag: "SessionNotFoundError" }, 404);
    },
  });
  return {
    base: `http://127.0.0.1:${listening.port ?? 0}`,
    stop: () => {
      void listening.stop(true);
    },
  };
}

const ctx = (): AgentContext => ({
  agent: "build-r1",
  harness: "opencode",
  cwd: fake.directory,
  dir,
  endpoint: server.base,
  herdr: { agentPrompt: () => Effect.void },
});

/** As `install` leaves it: the session Collie created, recorded before the agent starts. */
const bind = () => writeEvent(dir, { session: fake.session, kind: "session" });

function why<A, E>(result: Result.Result<A, E>): string {
  return Result.isFailure(result) ? reason(result.failure) : "";
}

const assistant = (id: string, tokens: Line["tokens"], extra: Partial<Line> = {}): Line => ({
  id,
  role: "assistant",
  mode: "build",
  finish: "stop",
  providerID: "opencode",
  modelID: "grok-4.5",
  tokens,
  ...extra,
});

beforeAll(() => {
  server = serve();
});
afterAll(() => server.stop());

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      fs = yield* FileSystem.FileSystem;
      path = yield* Path.Path;
      rig = yield* Rig.make();
      dir = path.join(rig.root, "controls", "build-r1");
      yield* fs.makeDirectory(dir, { recursive: true });
      fake = {
        session: "ses_one",
        directory: rig.projectDir,
        messages: [],
        onSummarize: () => {},
        summarizeStatus: 200,
        calls: [],
      };
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

test("binding a session records it once, not twice", () =>
  runEffect(
    Effect.gen(function* () {
      // The launch writes the session it created, and the writer binds whatever
      // session an event names. Two lines saying the same thing is a file a human
      // reads twice for nothing.
      yield* bind();

      const lines = (yield* fs.readFileString(path.join(dir, "events.jsonl")))
        .split("\n")
        .filter((line) => line.trim() !== "");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`"kind":"session"`);
    }),
  ));

test("an agent with no session recorded is a failure, not a context of zero", () =>
  runEffect(
    Effect.gen(function* () {
      const failure = yield* opencode.usage(ctx()).pipe(Effect.result);
      expect(why(failure)).toContain("no OpenCode session recorded");
    }),
  ));

test("a session that has moved directory is not this agent's", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bind();
      fake.directory = "/somewhere/else";
      const failure = yield* opencode.usage({ ...ctx(), cwd: rig.projectDir }).pipe(Effect.result);
      expect(why(failure)).toContain("/somewhere/else");
    }),
  ));

test("a session with no assistant message yet has no context to measure", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bind();
      fake.messages = [{ id: "m1", role: "user" }];
      expect(yield* opencode.usage(ctx())).toBeNull();
    }),
  ));

test("the sample is the provider's own total where it reported one", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bind();
      fake.messages = [
        assistant("m1", {
          total: 21_015,
          input: 20_875,
          output: 1,
          reasoning: 11,
          cache: { read: 128, write: 0 },
        }),
      ];
      expect(yield* opencode.usage(ctx())).toBe(21_015);
    }),
  ));

test("without a total it is input, output and both cache halves — and not reasoning", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bind();
      // OpenCode's own overflow predicate does not add `reasoning`, and this is meant
      // to be the same number it compares — so 900 here would be the wrong answer.
      fake.messages = [
        assistant("m1", {
          input: 100,
          output: 200,
          reasoning: 500,
          cache: { read: 30, write: 40 },
        }),
      ];
      expect(yield* opencode.usage(ctx())).toBe(370);
    }),
  ));

test("a message still being written has nothing measured yet", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bind();
      fake.messages = [
        assistant(
          "m1",
          { total: 5, input: 5, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          { finish: undefined },
        ),
      ];
      expect(yield* opencode.usage(ctx())).toBeNull();
    }),
  ));

test("a turn still finishing does not hide the last turn that measured the context", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bind();
      // A boundary lands the moment a step's output appears, which is while OpenCode is
      // usually still closing its last message. The finished turn before it is the
      // context as of the last model response — the number OpenCode's own overflow
      // predicate compares — and not a stale reading of a context that has moved.
      fake.messages = [
        assistant("m1", {
          total: 91_446,
          input: 12_985,
          output: 220,
          reasoning: 33,
          cache: { read: 78_208, write: 0 },
        }),
        assistant(
          "m2",
          {
            total: 91_500,
            input: 289,
            output: 13,
            reasoning: 0,
            cache: { read: 91_136, write: 0 },
          },
          { finish: undefined },
        ),
      ];
      expect(yield* opencode.usage(ctx())).toBe(91_446);
    }),
  ));

test("a compaction still being written is not a context to threshold", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bind();
      fake.messages = [
        assistant("m1", {
          total: 400_000,
          input: 400_000,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        }),
        assistant(
          "c1",
          { total: 866, input: 800, output: 66, reasoning: 0, cache: { read: 0, write: 0 } },
          { mode: "compaction", finish: undefined },
        ),
      ];
      expect(yield* opencode.usage(ctx())).toBeNull();
    }),
  ));

test("after a compaction the last real message is stale, so there is no sample", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bind();
      fake.messages = [
        assistant("m1", {
          total: 400_000,
          input: 400_000,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        }),
        // The compaction's own message. Its tokens are the summarizing request's, and
        // the 400,000 above describes a context that no longer exists.
        assistant(
          "c1",
          { total: 866, input: 800, output: 66, reasoning: 0, cache: { read: 0, write: 0 } },
          { mode: "compaction" },
        ),
      ];
      expect(yield* opencode.usage(ctx())).toBeNull();
    }),
  ));

test("a summarize that broke may still have been accepted, so it is not unsubmitted", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bind();
      fake.messages = [
        assistant("m1", {
          total: 9,
          input: 9,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        }),
      ];
      fake.summarizeStatus = 503;
      const failure = yield* opencode.request(ctx(), "req-1").pipe(Effect.result);

      expect(why(failure)).toContain("503");
      // The client's own timeout fires while the server's summarize loop keeps going,
      // so the policy must not read this as a request that never left and send work.
      expect(Result.isFailure(failure) && failure.failure instanceof Unsubmitted).toBe(false);
    }),
  ));

test("a session with no endpoint recorded is a request that never left", () =>
  runEffect(
    Effect.gen(function* () {
      const failure = yield* opencode
        .request({ ...ctx(), endpoint: null }, "req-1")
        .pipe(Effect.result);

      expect(Result.isFailure(failure) && failure.failure instanceof Unsubmitted).toBe(true);
    }),
  ));

test("a session with no model yet cannot be asked to summarize", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bind();
      fake.messages = [{ id: "m1", role: "user" }];
      const failure = yield* opencode.request(ctx(), "req-1").pipe(Effect.result);
      expect(why(failure)).toContain("has not settled on a model");
    }),
  ));

test("a 200 from summarize is not proof that anything compacted", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bind();
      fake.messages = [
        assistant("m1", {
          total: 9,
          input: 9,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        }),
      ];
      yield* opencode.request(ctx(), "req-1");

      expect(fake.calls).toContain(`POST /session/ses_one/summarize`);
      expect(yield* opencode.poll(ctx(), "req-1")).toBeNull();
    }),
  ));

test("a compaction the session already had cannot complete this request", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bind();
      fake.messages = [
        assistant("m1", {
          total: 9,
          input: 9,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        }),
        assistant("c-old", undefined, { mode: "compaction" }),
      ];
      yield* opencode.request(ctx(), "req-1");

      expect(yield* opencode.poll(ctx(), "req-1")).toBeNull();
    }),
  ));

test("a compaction message that was not there before is the success", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bind();
      fake.messages = [
        assistant("m1", {
          total: 9,
          input: 9,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        }),
        assistant("c-old", undefined, { mode: "compaction" }),
      ];
      fake.onSummarize = (f) => {
        f.messages = [...f.messages, assistant("c-new", undefined, { mode: "compaction" })];
      };

      yield* opencode.request(ctx(), "req-1");
      expect(yield* opencode.poll(ctx(), "req-1")).toEqual({ kind: "success" });
    }),
  ));

test("a compaction message still being written is unresolved, not a success", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bind();
      fake.messages = [
        assistant("m1", {
          total: 9,
          input: 9,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        }),
      ];
      fake.onSummarize = (f) => {
        f.messages = [
          ...f.messages,
          assistant("c-new", undefined, { mode: "compaction", finish: undefined }),
        ];
      };

      yield* opencode.request(ctx(), "req-1");
      expect(yield* opencode.poll(ctx(), "req-1")).toBeNull();
    }),
  ));

test("the error on that message is the documented confirmed failure", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bind();
      fake.messages = [
        assistant("m1", {
          total: 9,
          input: 9,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        }),
      ];
      fake.onSummarize = (f) => {
        f.messages = [
          ...f.messages,
          assistant("c-new", undefined, {
            mode: "compaction",
            error: {
              name: "ContextOverflowError",
              data: { message: "the context is too large to compact" },
            },
          }),
        ];
      };

      yield* opencode.request(ctx(), "req-1");
      expect(yield* opencode.poll(ctx(), "req-1")).toEqual({
        kind: "failure",
        reason: "the context is too large to compact",
      });
    }),
  ));

test("a request nothing recorded as submitted has no outcome", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bind();
      fake.messages = [assistant("c-new", undefined, { mode: "compaction" })];

      expect(yield* opencode.poll(ctx(), "never-submitted")).toBeNull();
    }),
  ));

test("two agents in one directory each read their own session", () =>
  runEffect(
    Effect.gen(function* () {
      // The reason Collie creates the session rather than finding one: every OpenCode
      // server answers with every session in the project, so the only thing that tells
      // two agents in one directory apart is the id each was launched with.
      const other = path.join(rig.root, "controls", "review-r1");
      yield* fs.makeDirectory(other, { recursive: true });
      yield* bind();
      yield* writeEvent(other, { session: "ses_two", kind: "session" });

      fake.messages = [
        assistant("m1", {
          total: 400_000,
          input: 400_000,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        }),
      ];
      // This agent's session is the stand-in's, so it reads a context.
      expect(yield* opencode.usage(ctx())).toBe(400_000);
      // The other agent's is not, so its read fails rather than borrowing this one's.
      const failure = yield* opencode
        .usage({ ...ctx(), agent: "review-r1", dir: other })
        .pipe(Effect.result);
      expect(why(failure)).toContain("ses_two");
    }),
  ));

// The contract, against the installed OpenCode. Its own server generates the API
// document, so booting one and reading `/doc` is the only way to ask this release what
// it actually has — and a mock cannot answer it.
test(
  "the installed OpenCode's own API document has the endpoints and the token fields",
  () =>
    runEffect(
      Effect.gen(function* () {
        const port = 39_517;
        // One `sh`, not Bun's shell: this needs a background job, `$!` and a poll,
        // none of which Bun's own parser takes.
        const doc = yield* Effect.promise(() => {
          const probe = Bun.spawn(
            [
              "sh",
              "-c",
              `opencode serve --hostname 127.0.0.1 --port ${port} >/dev/null 2>&1 &
               server=$!
               i=0
               while [ $i -lt 40 ]; do
                 curl -sf -m 2 "http://127.0.0.1:${port}/doc" && break
                 i=$((i + 1))
                 sleep 0.5
               done
               kill $server 2>/dev/null`,
            ],
            { cwd: rig.projectDir, stdout: "pipe", stderr: "ignore" },
          );
          return new Response(probe.stdout).text().finally(() => probe.exited);
        });
        expect(doc, "opencode serve did not answer /doc").toStartWith("{");

        // What the adapter calls.
        expect(doc).toContain(`"/session"`);
        expect(doc).toContain(`"/session/{sessionID}"`);
        expect(doc).toContain(`"/session/{sessionID}/message"`);
        expect(doc).toContain(`"/session/{sessionID}/summarize"`);
        // The accounting the native overflow predicate reads.
        expect(doc).toContain(`"reasoning"`);
        expect(doc).toContain(`"cache"`);
        // The error state on a compaction message that is terminal.
        expect(doc).toContain(`ContextOverflowError`);
      }),
    ),
  { timeout: 90_000 },
);

test(
  "the installed OpenCode is the release these controls were verified against, and takes the launch flags",
  () =>
    runEffect(
      Effect.gen(function* () {
        const wanted = VERIFIED_VERSIONS.get("opencode") ?? "";
        const version = yield* Effect.promise(() =>
          Bun.$`opencode --version 2>&1`.nothrow().text(),
        );
        // The contract is "at least the release these controls were verified against":
        // a newer patch (1.18.29 against the pinned 1.18.9) is the gate's business to
        // accept, and asserting the exact string here made a patch bump a red suite.
        expect(version.trim()).not.toBe("");
        expect(wanted).not.toBe("");
        yield* opencode.gate();

        // The launch: the ordinary TUI hosting its own loopback server, on the session
        // Collie made, with the model and the unattended switch it would have had
        // anyway. `attach` takes `--session` but not these two, which is why the TUI
        // hosts its own server rather than attaching to one of Collie's.
        const help = yield* Effect.promise(() => Bun.$`opencode --help 2>&1`.nothrow().text());
        for (const flag of ["--port", "--hostname", "--session", "--model", "--auto"]) {
          expect(help, `${flag} is gone from the opencode TUI`).toContain(flag);
        }
        const attach = yield* Effect.promise(() =>
          Bun.$`opencode attach --help 2>&1`.nothrow().text(),
        );
        expect(attach).not.toContain("--auto");
      }),
    ),
  { timeout: 60_000 },
);
