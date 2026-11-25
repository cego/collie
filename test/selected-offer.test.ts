import { Database } from "bun:sqlite";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { Effect, FileSystem, Option, Stream } from "effect";
import { Schema } from "effect";
import { parseJson, stringifyJson } from "../src/json";
import { expect, test } from "bun:test";
import { connect } from "../src/host";
import { MODULES, hosted } from "./support/hosted";
import { hostRecords, recordsAt, registeredAt } from "./support/records";
import { OPEN_FINDINGS, readFindingStatuses } from "../src/finding-status";
import { RunRecords } from "../src/run-records";
import { sectionOf } from "../src/board-model";
import { runDir } from "../src/engine";
import { until } from "./support/host";
import { isSettled } from "../src/lifecycle";
import { exec } from "./support/command";
import * as SecureRandom from "effect/crypto/SecureRandom";

const root = new URL("../", import.meta.url).pathname;
const encode: (value: Schema.Json) => string = stringifyJson;
const empty = { answer: "a", cause: "b", summary: "a", findings: [] };

const findings = [
  { severity: "major", title: "The cached build is stale", suggested: "fix" },
  { severity: "major", title: "The retry drops the body", suggested: "fix" },
  { severity: "minor", title: "The log line misses the id", suggested: "ticket" },
];
const investigation = {
  answer: "The Machines page uses the last peer build. Nothing rebuilds the bundle.",
  cause: "The peer's bundle is never rebuilt after it changes.",
  findings,
  summary: "The Machines page uses the last peer build.",
};
const told = {
  ...investigation,
  findings: [
    {
      severity: "major",
      title: "The Machines page uses a stale bundle",
      file: "desktop/src/bun/chat.ts",
      line: 12,
      detail: "The peer's bundle is never rebuilt after it changes.",
      evidence: "peers.test.ts rebuilds it; nothing else does",
      basis: "fact",
    },
    ...findings.slice(1),
  ],
};

// WARNING: these modules are the repository's own, copied in, since a Run reads them from the install.
const install = (world: {
  readonly install: string;
  readonly user: string;
  readonly project: string;
  readonly home: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${world.install}/personas`, { recursive: true });
    for (const name of [
      "investigate.workflow.ts",
      "investigate.md",
      "measuring.ts",
      "measuring.md",
      "selected.ts",
      "file-issue.workflow.ts",
      "file-issue.md",
    ]) {
      yield* fs.copyFile(`${root}workflows/${name}`, `${world.user}/${name}`);
    }
    yield* fs.copyFile(
      `${root}personas/investigator.md`,
      `${world.install}/personas/investigator.md`,
    );
    const remote = `${world.home}/repository.git`;
    yield* exec(["git", "init", "--bare", "-q", remote]);
    const git = (...args: Array<string>) =>
      exec(["git", "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], {
        cwd: world.project,
      });
    const done = yield* git("commit", "-q", "--allow-empty", "-m", "work");
    if (done.exitCode !== 0) {
      return yield* Effect.die(`commit failed: ${done.stderr}`);
    }
    yield* git("remote", "add", "origin", "git@github.com:cego/collie.git");
    yield* git("config", `url.${remote}.insteadOf`, "git@github.com:cego/collie.git");
    const pushed = yield* git("push", "-q", "origin", "HEAD");
    const read = yield* git("remote", "get-url", "origin");
    if (pushed.exitCode !== 0 || read.exitCode !== 0) {
      return yield* Effect.die(`remote failed: ${pushed.stderr} ${read.stdout} ${read.stderr}`);
    }
  }).pipe(Effect.orDie);

const started = (
  state: string,
  project: string,
  id: string,
  input: Readonly<Record<string, Schema.Json>>,
  options?: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const client = yield* connect(state).pipe(Effect.orDie);
    const request = yield* (yield* SecureRandom.SecureRandom).uuidV4();
    const began = yield* client.start({ project, id, request, input, options }).pipe(Effect.orDie);
    yield* until(
      () => client.run({ runId: began.runId }).pipe(Effect.orDie),
      (view) => view !== null && isSettled(view),
    );
    return { id: began.runId, dir: runDir(state, began.runId), client };
  });

const openCount = (state: string, run: string) =>
  hostRecords(
    state,
    RunRecords.use((records) => records.fact(run, "open-findings")),
  ).pipe(Effect.map(Number));

const cardOf = (state: string, run: string) =>
  Effect.gen(function* () {
    const client = yield* connect(state).pipe(Effect.orDie);
    const first = yield* client.board().pipe(Stream.runHead, Effect.orDie);
    const board = yield* Option.match(first, {
      onNone: () => Effect.die("the board sent nothing"),
      onSome: (one) => Effect.succeed(one),
    });
    const tasks = board._tag === "Snapshot" ? board.tasks : [];
    return yield* Option.match(
      Arr.findFirst(tasks, (one) => one.run === run),
      {
        onNone: () => Effect.die(`no card for ${run}`),
        onSome: (one) => Effect.succeed(one),
      },
    );
  });

const idsOf = (run: string) => [`${run}-F1`, `${run}-F2`, `${run}-F3`] as const;

test("an investigate Run's findings hold the card, and choosing two of them starts one Run that takes both", () =>
  hosted(
    "hw-selected-",
    ({ world }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* install(world);
        yield* fs.writeFileString(`${world.home}/outputs.json`, encode([investigation]));
        const run = yield* started(
          world.state,
          world.project,
          "investigate",
          { goal: "Why is the Machines page behind?" },
          { workspace: world.project, branch: "topic" },
        );
        const [first, second, third] = idsOf(run.id);

        expect(
          Arr.map(yield* run.client.runFindings({ runId: run.id }), (one) => one.status),
        ).toEqual(["open", "open", "open"]);
        expect(yield* openCount(world.state, run.id)).toBe(3);
        const held = yield* cardOf(world.state, run.id);
        expect({ landed: held.landed, section: sectionOf(held) }).toEqual({
          landed: false,
          section: "waiting",
        });

        const child = yield* run.client
          .invoke({
            runId: run.id,
            offer: "implement-selected",
            input: { findings: [first, second] },
            request: "choose-two",
          })
          .pipe(Effect.orDie);
        expect(
          (yield* run.client.run({ runId: child.runId }).pipe(Effect.orDie))?.input,
        ).toMatchObject({ findings: [first, second] });
        expect(yield* run.client.runFindings({ runId: run.id })).toMatchObject([
          { id: first, status: "taken", offer: "implement-selected", run: child.runId },
          { id: second, status: "taken", offer: "implement-selected", run: child.runId },
          { id: third, status: "open", offer: null, run: null },
        ]);

        yield* until(
          () => run.client.run({ runId: child.runId }).pipe(Effect.orDie),
          (view) => view !== null && isSettled(view),
        );
        yield* run.client
          .setFinding({
            runId: run.id,
            id: third,
            status: "dismissed",
            reason: "not worth it",
            request: "dismiss-third",
          })
          .pipe(Effect.orDie);
        expect(
          Option.getOrThrow(
            Arr.findFirst(
              yield* run.client.offers({ runId: run.id }),
              (one) => one.id === "implement-selected",
            ),
          ).unavailable,
        ).not.toBeNull();
        expect(yield* openCount(world.state, run.id)).toBe(0);
        const settledAll = yield* cardOf(world.state, run.id);
        expect({ landed: settledAll.landed, section: sectionOf(settledAll) }).toEqual({
          landed: true,
          section: "finished",
        });
      }),
    [...MODULES, "submits.workflow.ts", "implement.workflow.ts"],
  ));

test("a settled Run with nothing else to file is held by the findings it offers to build, until none is open", () =>
  hosted(
    "hw-selected-hold-",
    ({ world }) =>
      Effect.gen(function* () {
        const run = yield* Effect.gen(function* () {
          yield* install(world);
          yield* (yield* FileSystem.FileSystem).writeFileString(
            `${world.home}/outputs.json`,
            encode([empty]),
          );
          return yield* started(world.state, world.project, "submits", { note: "three" });
        });
        const held = yield* cardOf(world.state, run.id);
        expect({ landed: held.landed, section: sectionOf(held), state: held.state }).toEqual({
          landed: false,
          section: "waiting",
          state: "done",
        });

        for (const id of idsOf(run.id)) {
          yield* run.client
            .setFinding({
              runId: run.id,
              id,
              status: "dismissed",
              reason: "not worth it",
              request: `dismiss-${id}`,
            })
            .pipe(Effect.orDie);
        }
        const after = yield* cardOf(world.state, run.id);
        expect({ landed: after.landed, section: sectionOf(after) }).toEqual({
          landed: true,
          section: "finished",
        });
      }),
    [...MODULES, "submits.workflow.ts", "implement.workflow.ts"],
  ));

test("choosing a finding that is dismissed, already taken or unknown is refused, starting nothing", () =>
  hosted(
    "hw-selected-refused-",
    ({ world }) =>
      Effect.gen(function* () {
        const listing = Effect.gen(function* () {
          yield* install(world);
          yield* (yield* FileSystem.FileSystem).writeFileString(
            `${world.home}/outputs.json`,
            encode([investigation]),
          );
          return yield* started(
            world.state,
            world.project,
            "investigate",
            { goal: "Why is the Machines page behind?" },
            { workspace: world.project, branch: "topic" },
          );
        });
        const run = yield* listing;
        const [first, second] = idsOf(run.id);
        yield* run.client
          .setFinding({
            runId: run.id,
            id: second,
            status: "dismissed",
            reason: "not worth it",
            request: "dismiss-second",
          })
          .pipe(Effect.orDie);
        const before = (yield* registeredAt(world.state)).length;
        const refused = (id: string) =>
          Effect.map(
            run.client
              .invoke({
                runId: run.id,
                offer: "implement-selected",
                input: { findings: [id] },
                request: `refuse-${id}`,
              })
              .pipe(Effect.flip),
            (failure) => (failure._tag === "HostRefused" ? failure.reason : failure._tag),
          );

        expect(yield* refused(second)).toContain("not one of the findings still open");
        expect(yield* refused(`${run.id}-F9`)).toContain(`${run.id}-F9`);
        expect((yield* registeredAt(world.state)).length).toBe(before);
        // WARNING: the one line is the dismissal written before these refusals, which wrote none.
        expect(yield* hostRecords(world.state, readFindingStatuses(run.dir))).toHaveLength(1);
        yield* run.client
          .invoke({
            runId: run.id,
            offer: "implement-selected",
            input: { findings: [first] },
            request: "take-first",
          })
          .pipe(Effect.orDie);
        expect(yield* refused(first)).toContain("not one of the findings still open");
        expect(
          Arr.map(yield* run.client.runFindings({ runId: run.id }), (one) => one.status),
        ).toEqual(["taken", "dismissed", "open"]);
        expect(first).toBeDefined();
      }),
    [...MODULES, "submits.workflow.ts", "implement.workflow.ts"],
  ));

test("invoking the offer once per id starts two Runs, each given the one finding it was chosen for", () =>
  hosted(
    "hw-selected-once-",
    ({ world }) =>
      Effect.gen(function* () {
        const run = yield* Effect.gen(function* () {
          yield* install(world);
          yield* (yield* FileSystem.FileSystem).writeFileString(
            `${world.home}/outputs.json`,
            encode([empty]),
          );
          return yield* started(world.state, world.project, "submits", { note: "three" });
        });
        const [first, second] = idsOf(run.id);
        const one = (id: string, request: string) =>
          run.client
            .invoke({
              runId: run.id,
              offer: "implement-selected",
              input: { findings: [id] },
              request,
            })
            .pipe(Effect.orDie);
        const a = yield* one(first, "choose-first");
        const b = yield* one(second, "choose-second");

        expect(yield* run.client.runFindings({ runId: run.id })).toMatchObject([
          { id: first, status: "taken", run: a.runId },
          { id: second, status: "taken", run: b.runId },
          { id: `${run.id}-F3`, status: "open", run: null },
        ]);
        expect((yield* run.client.run({ runId: a.runId }).pipe(Effect.orDie))?.input).toMatchObject(
          {
            findings: [first],
          },
        );
        expect((yield* run.client.run({ runId: b.runId }).pipe(Effect.orDie))?.input).toMatchObject(
          {
            findings: [second],
          },
        );
      }),
    [...MODULES, "submits.workflow.ts", "implement.workflow.ts"],
  ));

test("a one-finding offer is refused two ids or none, and starts nothing on the refusal", () =>
  hosted(
    "hw-selected-one-",
    ({ world }) =>
      Effect.gen(function* () {
        const run = yield* Effect.gen(function* () {
          yield* install(world);
          yield* (yield* FileSystem.FileSystem).writeFileString(
            `${world.home}/outputs.json`,
            encode([empty]),
          );
          return yield* started(world.state, world.project, "submits", { note: "one" });
        });
        const [only] = idsOf(run.id);
        const before = (yield* registeredAt(world.state)).length;
        const refused = yield* run.client
          .invoke({
            runId: run.id,
            offer: "build-one",
            input: { findings: [only, `${run.id}-F2`] },
            request: "choose-two-for-one",
          })
          .pipe(Effect.flip);
        expect(refused._tag === "HostRefused" ? refused.reason : "").toContain(
          "exactly one finding",
        );
        expect((yield* registeredAt(world.state)).length).toBe(before);
        const none = yield* run.client
          .invoke({ runId: run.id, offer: "build-one", input: {}, request: "choose-none" })
          .pipe(Effect.flip);
        expect(none._tag === "HostRefused" ? none.reason : "").toContain("exactly one finding");
        expect((yield* registeredAt(world.state)).length).toBe(before);
        expect(
          Arr.map(yield* run.client.runFindings({ runId: run.id }), (one) => one.status),
        ).toEqual(["open", "open", "open"]);

        const child = yield* run.client
          .invoke({
            runId: run.id,
            offer: "build-one",
            input: { findings: only },
            request: "choose-one",
          })
          .pipe(Effect.orDie);
        const goal = String(
          (yield* run.client.run({ runId: child.runId }).pipe(Effect.orDie))?.input.goal,
        );
        expect(goal).toContain("The first");
        expect(goal).toContain(`${run.dir}/findings.json`);
      }),
    [...MODULES, "submits.workflow.ts", "implement.workflow.ts"],
  ));

test("the CLI invokes a selecting offer given its ids as comma-separated text", () =>
  hosted(
    "hw-selected-cli-",
    ({ world }) =>
      Effect.gen(function* () {
        const run = yield* Effect.gen(function* () {
          yield* install(world);
          yield* (yield* FileSystem.FileSystem).writeFileString(
            `${world.home}/outputs.json`,
            encode([empty]),
          );
          return yield* started(world.state, world.project, "submits", { note: "three" });
        });
        const [first, second] = idsOf(run.id);
        const env = {
          COLLIE_ROOT: world.install,
          COLLIE_STATE_DIR: world.state,
          COLLIE_USER_DIR: world.config,
          HOME: world.home,
        };
        const binary = Bun.argv[0] ?? "bun";
        const proc = Bun.spawn(
          [
            binary,
            `${root}src/main.ts`,
            "run",
            "action",
            run.id,
            "implement-selected",
            "--input",
            `findings=${first}, ${second}`,
          ],
          { cwd: root, env: { ...env, PWD: root }, stdout: "pipe", stderr: "pipe" },
        );
        const [out, err, exit] = yield* Effect.promise(() =>
          Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]),
        );
        expect({ exit, err }).toMatchObject({ exit: 0 });
        expect(out).toContain("implement-selected");
        const read = yield* run.client.runFindings({ runId: run.id });
        expect(Arr.map(read, (one) => one.status)).toEqual(["taken", "taken", "open"]);
      }),
    [...MODULES, "submits.workflow.ts", "implement.workflow.ts"],
  ));

test("Investigate further starts an investigate Run told the one finding it was chosen for", () =>
  hosted(
    "hw-selected-further-",
    ({ world }) =>
      Effect.gen(function* () {
        const run = yield* Effect.gen(function* () {
          yield* install(world);
          yield* (yield* FileSystem.FileSystem).writeFileString(
            `${world.home}/outputs.json`,
            encode([told, told]),
          );
          return yield* started(
            world.state,
            world.project,
            "investigate",
            { goal: "Why is the Machines page behind?" },
            { workspace: world.project, branch: "topic" },
          );
        });
        const [first] = idsOf(run.id);
        const offered = Option.getOrThrow(
          Arr.findFirst(
            yield* run.client.offers({ runId: run.id }),
            (one) => one.id === "investigate-further",
          ),
        );
        expect({ selects: offered.selects, unavailable: offered.unavailable }).toEqual({
          selects: "one",
          unavailable: null,
        });

        const child = yield* run.client
          .invoke({
            runId: run.id,
            offer: "investigate-further",
            input: { findings: first },
            request: "further-first",
          })
          .pipe(Effect.orDie);
        const goal = String(
          (yield* run.client.run({ runId: child.runId }).pipe(Effect.orDie))?.input.goal,
        );
        expect(goal).toContain("The Machines page uses a stale bundle");
        expect(goal).toContain("peers.test.ts rebuilds it; nothing else does");
        expect(goal).toContain(`${run.dir}/investigation.md`);
        expect(yield* run.client.runFindings({ runId: run.id })).toMatchObject([
          { id: first, status: "taken", offer: "investigate-further", run: child.runId },
          { id: `${run.id}-F2`, status: "open", run: null },
          { id: `${run.id}-F3`, status: "open", run: null },
        ]);
      }),
    [...MODULES, "submits.workflow.ts", "implement.workflow.ts"],
  ));

test("an offer that names its selection something else launches with the ids chosen", () =>
  hosted(
    "hw-choose-selected-",
    ({ world }) =>
      Effect.gen(function* () {
        yield* install(world);
        const run = yield* started(world.state, world.project, "chooses", { note: "two" });
        const [first, second] = idsOf(run.id);
        const child = yield* run.client
          .invoke({
            runId: run.id,
            offer: "choose-selected",
            input: { findings: [first, second] },
            request: "choose-given",
          })
          .pipe(Effect.orDie);
        expect(
          (yield* run.client.run({ runId: child.runId }).pipe(Effect.orDie))?.input,
        ).toMatchObject({ selected: [first, second] });
      }),
    [...MODULES, "chooses.workflow.ts", "given.workflow.ts"],
  ));

test("a request id already started answers with the Run it started, once its finding is taken", () =>
  hosted(
    "hw-selected-replay-",
    ({ world }) =>
      Effect.gen(function* () {
        yield* install(world);
        const run = yield* started(world.state, world.project, "submits", { note: "two" });
        const [first, second] = idsOf(run.id);
        const asked = () =>
          run.client.invoke({
            runId: run.id,
            offer: "implement-selected",
            input: { findings: [first, second] },
            request: "choose-twice",
          });
        const child = yield* asked().pipe(Effect.orDie);
        const again = yield* asked().pipe(Effect.orDie);
        expect(again.runId).toBe(child.runId);
        expect(
          Arr.filter(
            yield* run.client.offers({ runId: run.id }),
            (one) => one.unavailable === null,
          ),
        ).toEqual([]);
      }),
    [...MODULES, "submits.workflow.ts", "implement.workflow.ts"],
  ));

test("a repeated request answers with its Run for the same work, whatever the key order, and refuses another parent's or another file's", () =>
  hosted(
    "hw-selected-replay-work-",
    ({ world }) =>
      Effect.gen(function* () {
        const run = yield* Effect.gen(function* () {
          yield* install(world);
          yield* (yield* FileSystem.FileSystem).writeFileString(
            `${world.home}/outputs.json`,
            encode([empty]),
          );
          return yield* started(world.state, world.project, "submits", { note: "two" });
        });
        const [first, second] = idsOf(run.id);
        const asked = (
          input: Readonly<Record<string, Schema.Json>>,
          attachments?: ReadonlyArray<string>,
          runId = run.id,
        ) => {
          const ask = { runId, offer: "implement-selected", input, request: "same-work" };
          return run.client.invoke(attachments === undefined ? ask : { ...ask, attachments });
        };
        const child = yield* asked({ findings: [first, second], plan: "the plan" }).pipe(
          Effect.orDie,
        );
        const reordered = yield* asked({ plan: "the plan", findings: [first, second] }).pipe(
          Effect.orDie,
        );
        expect(reordered.runId).toBe(child.runId);
        const elsewhere = yield* started(world.state, world.project, "submits", { note: "two" });
        const otherParent = yield* asked(
          { findings: [first, second], plan: "the plan" },
          undefined,
          elsewhere.id,
        ).pipe(Effect.flip);
        expect(otherParent._tag === "RequestConflict" ? otherParent.reason : "").toContain(
          "other arguments",
        );
        const otherFiles = yield* asked({ findings: [first, second], plan: "the plan" }, [
          `${world.home}/outputs.json`,
        ]).pipe(Effect.flip);
        expect(otherFiles._tag === "RequestConflict" ? otherFiles.reason : "").toContain(
          "other arguments",
        );
      }),
    [...MODULES, "submits.workflow.ts", "implement.workflow.ts"],
  ));

test("a request id is refused for other files, even in another order, and for a Run a direct start made", () =>
  hosted(
    "hw-selected-replay-files-",
    ({ world }) =>
      Effect.gen(function* () {
        const run = yield* Effect.gen(function* () {
          yield* install(world);
          yield* (yield* FileSystem.FileSystem).writeFileString(
            `${world.home}/outputs.json`,
            encode([empty]),
          );
          return yield* started(world.state, world.project, "submits", { note: "two" });
        });
        const [first] = idsOf(run.id);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${world.home}/one`, { recursive: true });
        yield* fs.makeDirectory(`${world.home}/two`, { recursive: true });
        yield* fs.writeFileString(`${world.home}/one/same.txt`, "first");
        yield* fs.writeFileString(`${world.home}/two/same.txt`, "second");
        const inOrder = [`${world.home}/one/same.txt`, `${world.home}/two/same.txt`];
        const asked = (attachments: ReadonlyArray<string>) =>
          run.client.invoke({
            runId: run.id,
            offer: "implement-selected",
            input: { findings: [first] },
            request: "same-files",
            attachments,
          });
        yield* asked(inOrder).pipe(Effect.orDie);
        const reversed = yield* asked([inOrder[1]!, inOrder[0]!]).pipe(Effect.flip);
        expect(reversed._tag === "RequestConflict" ? reversed.reason : "").toContain(
          "other arguments",
        );
        const direct = yield* run.client
          .start({
            project: world.project,
            id: "submits",
            request: "direct-start",
            input: { note: "direct" },
          })
          .pipe(Effect.orDie);
        const overStart = yield* run.client
          .invoke({
            runId: run.id,
            offer: "implement-selected",
            input: { findings: [first] },
            request: "direct-start",
          })
          .pipe(Effect.flip);
        expect(overStart._tag === "RequestConflict" ? overStart.reason : "").toContain(
          direct.runId,
        );
      }),
    [...MODULES, "submits.workflow.ts", "implement.workflow.ts"],
  ));

test("an offer child admitted before the fingerprint existed still answers its retry", () =>
  hosted(
    "hw-selected-upgrade-",
    ({ world }) =>
      Effect.gen(function* () {
        const run = yield* Effect.gen(function* () {
          yield* install(world);
          yield* (yield* FileSystem.FileSystem).writeFileString(
            `${world.home}/outputs.json`,
            encode([empty]),
          );
          return yield* started(world.state, world.project, "submits", { note: "two" });
        });
        const [first, second] = idsOf(run.id);
        const asked = () =>
          run.client.invoke({
            runId: run.id,
            offer: "implement-selected",
            input: { findings: [first, second] },
            request: "pre-upgrade",
          });
        const child = yield* asked().pipe(Effect.orDie);
        const db = new Database(`${world.state}/host.db`);
        const row = yield* Schema.decodeUnknownEffect(Schema.Struct({ placing: Schema.String }))(
          db.query("SELECT placing FROM collie_runs WHERE run = ?").get(child.runId),
        ).pipe(Effect.orDie);
        const placing = parseJson(Schema.Record(Schema.String, Schema.Json), row.placing);
        const legacy = Rec.filter(
          placing,
          (_, key) => !["direct", "child", "took", "invoked"].includes(key),
        );
        db.run("UPDATE collie_runs SET placing = ? WHERE run = ?", [
          stringifyJson(legacy),
          child.runId,
        ]);
        db.close();
        const again = yield* asked().pipe(Effect.orDie);
        expect(again.runId).toBe(child.runId);
        expect(again.fresh).toBe(false);
      }),
    [...MODULES, "submits.workflow.ts", "implement.workflow.ts"],
  ));

test("a retry finishes the parent's taken lines before it answers with the child", () =>
  hosted(
    "hw-selected-retry-taken-",
    ({ world }) =>
      Effect.gen(function* () {
        const run = yield* Effect.gen(function* () {
          yield* install(world);
          yield* (yield* FileSystem.FileSystem).writeFileString(
            `${world.home}/outputs.json`,
            encode([empty]),
          );
          return yield* started(world.state, world.project, "submits", { note: "two" });
        });
        const [first, second, third] = idsOf(run.id);
        const asked = () =>
          run.client.invoke({
            runId: run.id,
            offer: "implement-selected",
            input: { findings: [first, second] },
            request: "half-done",
          });
        const child = yield* asked().pipe(Effect.orDie);
        const said = Effect.map(run.client.runFindings({ runId: run.id }), (rows) =>
          Arr.map(rows, (one) => [one.id, one.status]),
        );
        expect(yield* said).toEqual([
          [first, "taken"],
          [second, "taken"],
          [third, "open"],
        ]);
        // WARNING: this is the claim made and the answer lost, before the parent's lines were written.
        const lines = new Database(`${world.state}/host.db`);
        lines.run("DELETE FROM collie_run_lines WHERE run = ?", [run.id]);
        lines.close();
        expect(yield* said).toEqual([
          [first, "open"],
          [second, "open"],
          [third, "open"],
        ]);
        const again = yield* asked().pipe(Effect.orDie);
        expect(again.runId).toBe(child.runId);
        expect(yield* said).toEqual([
          [first, "taken"],
          [second, "taken"],
          [third, "open"],
        ]);
      }),
    [...MODULES, "submits.workflow.ts", "implement.workflow.ts"],
  ));

test("a retry saves the parent's open count when its taken lines are already there", () =>
  hosted(
    "hw-selected-retry-count-",
    ({ world }) =>
      Effect.gen(function* () {
        const run = yield* Effect.gen(function* () {
          yield* install(world);
          yield* (yield* FileSystem.FileSystem).writeFileString(
            `${world.home}/outputs.json`,
            encode([empty]),
          );
          return yield* started(world.state, world.project, "submits", { note: "two" });
        });
        const [first, second] = idsOf(run.id);
        const asked = () =>
          run.client.invoke({
            runId: run.id,
            offer: "implement-selected",
            input: { findings: [first, second] },
            request: "count-lost",
          });
        yield* asked().pipe(Effect.orDie);
        yield* RunRecords.use((records) => records.put(run.id, OPEN_FINDINGS, null)).pipe(
          Effect.provide(recordsAt(world.state)),
        );
        expect(
          yield* hostRecords(
            world.state,
            RunRecords.use((records) => records.fact(run.id, OPEN_FINDINGS)),
          ),
        ).toBeNull();
        yield* asked().pipe(Effect.orDie);
        expect(
          yield* hostRecords(
            world.state,
            RunRecords.use((records) => records.fact(run.id, OPEN_FINDINGS)),
          ),
        ).toBe("1");
      }),
    [...MODULES, "submits.workflow.ts", "implement.workflow.ts"],
  ));

const filed = { identifier: "CEGO-12", url: "https://linear.app/cego/issue/CEGO-12/one-issue" };

test("File to Linear files the one finding chosen, and the Run it starts answers with the issue's URL", () =>
  hosted(
    "hw-file-issue-",
    ({ world }) =>
      Effect.gen(function* () {
        const run = yield* Effect.gen(function* () {
          yield* install(world);
          // WARNING: a used Connection is read once and kept, so Linear is set up before the Run that offers it starts.
          yield* (yield* FileSystem.FileSystem).writeFileString(
            `${world.project}/.mcp.json`,
            '{"mcpServers":{"linear":{"url":"https://mcp.linear.app/mcp"}}}',
          );
          yield* (yield* FileSystem.FileSystem).writeFileString(
            `${world.home}/outputs.json`,
            encode([filed]),
          );
          return yield* started(world.state, world.project, "submits", { note: "three" });
        });
        const [first] = idsOf(run.id);
        // WARNING: a listing reads the Connection as the syncer kept it, once it has read it.
        const offered = yield* until(
          () =>
            run.client
              .offers({ runId: run.id })
              .pipe(
                Effect.map((offers) =>
                  Option.getOrUndefined(
                    Arr.findFirst(offers, (one) => one.id === "file-to-linear"),
                  ),
                ),
              ),
          (one) => one !== undefined && !Str.includes("still being read")(one.unavailable ?? ""),
        );
        expect([offered?.workflow, offered?.selects, offered?.unavailable ?? null]).toEqual([
          "file-issue",
          "one",
          null,
        ]);

        const child = yield* run.client
          .invoke({
            runId: run.id,
            offer: "file-to-linear",
            input: { findings: first },
            request: "file-first",
          })
          .pipe(Effect.orDie);
        const goal = String(
          (yield* run.client.run({ runId: child.runId }).pipe(Effect.orDie))?.input.goal,
        );
        expect(goal).toContain("The first");
        expect(goal).toContain("the log names it twice");
        expect(goal).toContain("Suggested: fix");
        expect(
          Arr.map(yield* run.client.runFindings({ runId: run.id }), (one) => [
            one.id,
            one.status,
            one.offer,
          ]),
        ).toEqual([
          [first, "taken", "file-to-linear"],
          [`${run.id}-F2`, "open", null],
          [`${run.id}-F3`, "open", null],
        ]);

        const done = yield* until(
          () => run.client.run({ runId: child.runId }).pipe(Effect.orDie),
          (view) => view !== null && isSettled(view),
        );
        expect(done?.status).toMatchObject({ status: "complete", value: filed.url });
      }),
    [...MODULES, "submits.workflow.ts", "implement.workflow.ts"],
  ));

test("with no Linear, File to Linear is listed with the Connection's fix and starts nothing when taken", () =>
  hosted(
    "hw-file-issue-absent-",
    ({ world }) =>
      Effect.gen(function* () {
        const run = yield* Effect.gen(function* () {
          yield* install(world);
          yield* (yield* FileSystem.FileSystem).writeFileString(
            `${world.home}/outputs.json`,
            encode([filed]),
          );
          return yield* started(world.state, world.project, "submits", { note: "three" });
        });
        const [first] = idsOf(run.id);
        const absent = yield* until(
          () =>
            run.client
              .offers({ runId: run.id })
              .pipe(
                Effect.map((offers) =>
                  Option.getOrUndefined(
                    Arr.findFirst(offers, (one) => one.id === "file-to-linear"),
                  ),
                ),
              ),
          (one) => one !== undefined && !Str.includes("still being read")(one.unavailable ?? ""),
        );
        expect(absent?.unavailable ?? "").toStartWith("needs linear: ");
        expect(absent?.unavailable ?? "").toContain("Fix: ");

        const before = (yield* registeredAt(world.state)).length;
        const refused = yield* run.client
          .invoke({
            runId: run.id,
            offer: "file-to-linear",
            input: { findings: first },
            request: "file-without-linear",
          })
          .pipe(Effect.flip);
        expect(refused.reason).toContain("Fix: ");
        expect((yield* registeredAt(world.state)).length).toBe(before);
        expect(
          Arr.map(yield* run.client.runFindings({ runId: run.id }), (one) => one.status),
        ).toEqual(["open", "open", "open"]);
      }),
    [...MODULES, "submits.workflow.ts", "implement.workflow.ts"],
  ));
