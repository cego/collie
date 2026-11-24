import * as Arr from "effect/Array";
import { Effect, FileSystem, Option, Stream } from "effect";
import type { Schema } from "effect";
import { stringifyJson } from "../src/json";
import { expect, test } from "bun:test";
import { connect } from "../src/host";
import { MODULES, hosted } from "./support/hosted";
import { hostRecords, registeredAt } from "./support/records";
import { readFindingStatuses } from "../src/finding-status";
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
  id: "investigate" | "submits",
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

test("a one-finding offer is refused two ids, and starts nothing on the refusal", () =>
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

        const child = yield* run.client
          .invoke({
            runId: run.id,
            offer: "build-one",
            input: { findings: only },
            request: "choose-one",
          })
          .pipe(Effect.orDie);
        expect(
          (yield* run.client.run({ runId: child.runId }).pipe(Effect.orDie))?.input,
        ).toMatchObject({
          findings: [only],
        });
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
