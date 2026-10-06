// One Run's details as the host serves them while a drawer is open: followed as they
// change, with large items fetched by reference.

import { expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, Option, Schedule, Schema, Stream } from "effect";
import type { RunDetail } from "../src/board-model";
import { runDir } from "../src/engine";
import { currentEnv } from "../src/env";
import { appState } from "../src/flows";
import { Herdr } from "../src/herdr";
import { frontDoor } from "../src/host";
import { followRunDetail } from "../src/lifecycle";
import { scopeFor } from "../src/registry";
import { diffOf, fetchRef, keepDiffs, runDiff } from "../src/run-detail";
import { madeRun } from "./support/records";
import { runRowId } from "../src/ui/state";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { focus } from "./support/focus";
import { stopHost } from "./support/host";
import { collie, proves } from "./support/world";

const runIdOf = (envelope: { readonly data?: unknown }) =>
  Schema.decodeUnknownEffect(Schema.Struct({ runId: Schema.String }))(envelope.data).pipe(
    Effect.map(({ runId }) => runId),
    Effect.orDie,
  );

const started = (world: Parameters<typeof collie>[0], args: ReadonlyArray<string>, extra = {}) =>
  collie(world, ["run", "start", ...args], extra).pipe(
    Effect.tap(({ envelope }) => Effect.sync(() => expect(envelope.ok).toBe(true))),
    Effect.flatMap(({ envelope }) => runIdOf(envelope)),
  );

test(
  "a drawer's subscription follows the Run's log and evidence, and fetches them by reference",
  () =>
    proves(
      "collie-detail-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const runId = yield* started(world, ["plain", "--input", "note=hi"]);
          const dir = runDir(world.state, runId);
          const door = yield* frontDoor(world.state);
          const seen: Array<RunDetail | null> = [];
          const reading = yield* door
            .runDetail({ runId, tail: true, pages: 1, refreshMr: false })
            .pipe(
              Stream.tap((detail) => Effect.sync(() => seen.push(detail))),
              Stream.takeUntil(
                (detail) =>
                  detail !== null &&
                  detail.tail?._tag === "Text" &&
                  detail.tail.text.includes("later line") &&
                  detail.evidence.some((one) => one.name === "shot.png"),
              ),
              Stream.runLast,
              Effect.forkScoped,
            );
          yield* Effect.sleep("1 second");
          yield* fs.writeFileString(`${dir}/log.txt`, "later line\n", { flag: "a" });
          yield* fs.makeDirectory(`${world.state}/evidence/${runId}`, { recursive: true });
          yield* fs.writeFile(
            `${world.state}/evidence/${runId}/shot.png`,
            new Uint8Array([1, 2, 3]),
          );
          const last = yield* Fiber.await(reading).pipe(Effect.timeout("30 seconds"));
          expect(seen[0]?.id).toBe(runId);
          expect(last._tag).toBe("Success");

          const log = yield* door.runFile({ runId, ref: "log" });
          expect(log).toMatchObject({ encoding: "utf8" });
          expect(log.content).toContain("later line");
          const shot = yield* door.runFile({ runId, ref: "evidence:shot.png" });
          expect(shot).toEqual({
            ref: "evidence:shot.png",
            encoding: "base64",
            content: "AQID",
            size: 3,
          });
          const part = yield* door.runFile({
            runId,
            ref: "evidence:shot.png",
            offset: 1,
            length: 1,
          });
          expect(part).toMatchObject({ content: "Ag==", size: 3 });
          const outside = yield* door
            .runFile({ runId, ref: "evidence:../../installation" })
            .pipe(Effect.flip);
          expect(outside._tag).toBe("HostRefused");
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      ["plain.workflow.ts"],
    ),
  120_000,
);

const MR = "mr:gitlab.example.com/mk/project!7";

test(
  "the drawer's merge request panel is what the host's merge watch read",
  () =>
    proves(
      "collie-detail-mr-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const bin = `${world.home}/bin`;
          yield* fs.makeDirectory(bin, { recursive: true });
          const view = `{"iid":7,"state":"opened","title":"Cards","web_url":"https://gitlab.example.com/mk/project/-/merge_requests/7"}`;
          yield* fs.writeFileString(
            `${bin}/glab`,
            `#!/bin/sh\n[ "$1" = mr ] && [ "$2" = view ] && echo '${view}'\nexit 0\n`,
            { mode: 0o755 },
          );
          const runId = yield* started(world, ["targeted", "--input", `target=${MR}`], {
            PATH: `${bin}:/usr/bin:/bin`,
          });
          const door = yield* frontDoor(world.state);
          const detail = yield* door
            .runDetail({ runId, tail: false, pages: 1, refreshMr: false })
            .pipe(
              Stream.filter((one) => one?.mr?._tag === "Details"),
              Stream.runHead,
              Effect.timeout("30 seconds"),
            );
          yield* stopHost(world.state);
          const mr = Option.getOrNull(detail)?.mr;
          expect(mr?._tag === "Details" && mr.title).toBe("Cards");
        }).pipe(Effect.orDie),
      ["targeted.workflow.ts"],
    ),
  120_000,
);

test(
  "the TUI drawer is what the host serves, and follows it",
  () =>
    proves(
      "collie-detail-tui-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const runId = yield* started(world, ["plain", "--input", "note=hi"]);
          const env = yield* currentEnv.pipe(Effect.orDie);
          const app = appState(
            {
              herdr: new Herdr(env),
              ...scopeFor(env, env.cwd),
              stateDir: env.stateDir,
              userDir: env.userDir,
              paneId: env.paneId,
              pluginRoot: env.pluginRoot,
              tasksOf: () => Effect.succeed({ tasks: [], unreadable: null }),
              detailOf: yield* followRunDetail(env),
            },
            env,
          );
          const looking = focus({ selected: runRowId(runId), tail: true });
          expect((yield* app.load(looking)).detail?.id).toBe(runId);
          yield* fs.writeFileString(`${runDir(world.state, runId)}/log.txt`, "from the host\n", {
            flag: "a",
          });
          const after = yield* app.load(focus({ ...looking, nonce: 1 })).pipe(
            Effect.repeat({
              until: (state) =>
                state.detail?.tail?._tag === "Text" &&
                state.detail.tail.text.includes("from the host"),
              schedule: Schedule.spaced("250 millis"),
              times: 80,
            }),
          );
          yield* stopHost(world.state);
          expect(after.detail?.tail?._tag).toBe("Text");
        }),
      ["plain.workflow.ts"],
    ),
  120_000,
);

/** A checkout with a default branch and a branch off it, as a Run's worktree has. */
const branched = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const repo = yield* fs.makeTempDirectoryScoped({ prefix: "collie-diff-" });
  const git = (...args: string[]) =>
    exec(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo }).pipe(
      Effect.flatMap((done) =>
        done.exitCode === 0
          ? Effect.void
          : Effect.die(new Error(`git ${args.join(" ")}: ${done.stderr}`)),
      ),
    );
  yield* git("init", "-q", "-b", "main");
  yield* fs.writeFileString(`${repo}/kept.txt`, "one\ntwo\n");
  yield* fs.writeFileString(`${repo}/gone.txt`, "bye\n");
  yield* git("add", ".");
  yield* git("commit", "-qm", "base");
  yield* git("checkout", "-qb", "feature");
  yield* fs.writeFileString(`${repo}/kept.txt`, "one\nthree\n");
  yield* fs.remove(`${repo}/gone.txt`);
  yield* fs.writeFileString(`${repo}/new.txt`, "hello\n");
  yield* git("add", "-A");
  yield* git("commit", "-qm", "work");
  return { repo, git };
});

test("a Run's diff is its branch against the merge base, per file, and live while it works", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { repo } = yield* branched;
        const final = yield* runDiff({ cwd: repo, branch: "feature", live: false });
        expect(final?.files).toEqual([
          { path: "gone.txt", status: "deleted", added: 0, removed: 1 },
          { path: "kept.txt", status: "modified", added: 1, removed: 1 },
          { path: "new.txt", status: "added", added: 1, removed: 0 },
        ]);
        expect(final?.live).toBe(false);

        // Live: what the checkout holds now, committed or not.
        yield* fs.writeFileString(`${repo}/wip.txt`, "draft\n");
        const live = yield* runDiff({ cwd: repo, branch: "feature", live: true });
        expect(live?.files.map((file) => file.path)).toContain("wip.txt");
        expect(yield* runDiff({ cwd: `${repo}/nowhere`, branch: "feature", live: false })).toBe(
          null,
        );
      }),
    ),
  ));

test("an ended Run keeps its diff once its checkout has gone, file by file", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { repo, git } = yield* branched;
        yield* fs.writeFileString(`${repo}/tab\there.txt`, "odd\n");
        yield* git("add", "-A");
        yield* git("commit", "-qm", "odd name");
        const state = yield* fs.makeTempDirectoryScoped({ prefix: "collie-diff-state-" });
        const run = yield* madeRun(state, { cwd: repo, branch: "feature", state: "succeeded" });

        const first = yield* diffOf(run);
        expect(first?.files.map((file) => file.path)).toContain("tab\there.txt");
        const pruned = { ...run, cwd: `${repo}/pruned` };

        expect(yield* diffOf(pruned)).toEqual(first);
        const kept = yield* fetchRef(pruned, "diff:kept.txt");
        expect(kept.content).toContain("+three");
        expect(kept.content).not.toContain("new.txt");
        // A name git quotes in a patch header is still found by the name it has on disk.
        expect((yield* fetchRef(pruned, "diff:tab\there.txt")).content).toContain("+odd");

        // A patch read in parts is built once: the later parts are cut from the first's.
        const head = yield* fetchRef(pruned, "diff:kept.txt", { offset: 0, length: 10 });
        yield* fs.remove(`${run.dir}/diff.json`);
        const tail = yield* fetchRef(pruned, "diff:kept.txt", { offset: 10, length: 1 << 20 });
        const joined = Buffer.concat([head, tail].map((one) => Buffer.from(one.content, "base64")));
        expect(joined.toString()).toBe(kept.content);
      }),
    ),
  ));

test("a kept diff is taken again once its branch has moved on", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { repo, git } = yield* branched;
        const state = yield* fs.makeTempDirectoryScoped({ prefix: "collie-diff-state-" });
        const stopped = yield* madeRun(state, { cwd: repo, branch: "feature", state: "stopped" });
        expect((yield* diffOf(stopped))?.files.map((file) => file.path)).not.toContain("more.txt");

        // Resumed, it committed more and succeeded.
        yield* fs.writeFileString(`${repo}/more.txt`, "more\n");
        yield* git("add", "-A");
        yield* git("commit", "-qm", "more");
        const done = { ...stopped, state: "succeeded" as const };
        expect((yield* diffOf(done))?.files.map((file) => file.path)).toContain("more.txt");
      }),
    ),
  ));

test("the host keeps a Run's diff each time it ends, with no drawer opened", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { repo, git } = yield* branched;
        const state = yield* fs.makeTempDirectoryScoped({ prefix: "collie-diff-state-" });
        const stopped = yield* madeRun(state, { cwd: repo, branch: "feature", state: "stopped" });
        const keptNames = fs
          .readFileString(`${stopped.dir}/diff.json`)
          .pipe(Effect.orElseSucceed(() => ""));
        const kept = new Set<string>();

        yield* keepDiffs([stopped], kept);
        expect(yield* keptNames).toContain("new.txt");

        // Resumed: going again, then ended with more committed.
        yield* keepDiffs([{ ...stopped, state: "running" }], kept);
        yield* fs.writeFileString(`${repo}/more.txt`, "more\n");
        yield* git("add", "-A");
        yield* git("commit", "-qm", "more");
        yield* keepDiffs([{ ...stopped, state: "succeeded" }], kept);
        expect(yield* keptNames).toContain("more.txt");
      }),
    ),
  ));

test("a live diff never reads through a link or into a device or FIFO", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { repo } = yield* branched;
        yield* fs.symlink("/dev/zero", `${repo}/zero`);
        const fifo = `${yield* fs.makeTempDirectoryScoped({ prefix: "collie-fifo-" })}/pipe`;
        yield* exec(["mkfifo", fifo]);
        yield* fs.symlink(fifo, `${repo}/pipe`);

        const live = yield* runDiff({ cwd: repo, branch: "feature", live: true }).pipe(
          Effect.timeout("10 seconds"),
        );
        const untracked = live?.files.filter(
          (file) => file.path === "zero" || file.path === "pipe",
        );
        expect(untracked).toEqual([
          { path: "pipe", status: "added", added: null, removed: null },
          { path: "zero", status: "added", added: null, removed: null },
        ]);
      }),
    ),
  ));

test("a reference never follows a link out of the directory it belongs to", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const state = yield* fs.makeTempDirectoryScoped({ prefix: "collie-ref-" });
        const run = yield* madeRun(state, {});
        yield* fs.writeFileString(`${state}/secret`, "key\n");
        yield* fs.symlink(`${state}/secret`, `${run.evidence}/shot.png`);
        yield* fs.makeDirectory(`${run.dir}/plan/issues`, { recursive: true });
        yield* fs.writeFileString(`${run.dir}/plan/issues/01-a.md`, "# A\n");

        expect((yield* fetchRef(run, "evidence:shot.png").pipe(Effect.flip))._tag).toBe(
          "HostRefused",
        );
        expect((yield* fetchRef(run, "plan:../log.txt").pipe(Effect.flip))._tag).toBe(
          "HostRefused",
        );
        expect((yield* fetchRef(run, "plan:issues/01-a.md")).content).toBe("# A\n");
        yield* fs.writeFileString(`${run.dir}/review.md`, "## Review\n");
        expect((yield* fetchRef(run, "review")).content).toBe("## Review\n");

        // Read in parts, a text comes back as bytes, so joined it is the file again.
        yield* fs.writeFileString(`${run.dir}/plan/issues/02-b.md`, "a—b");
        const parts = [];
        for (const offset of [0, 2, 4])
          parts.push(yield* fetchRef(run, "plan:issues/02-b.md", { offset, length: 2 }));
        expect(parts.every((part) => part.encoding === "base64")).toBe(true);
        const joined = parts.flatMap((part) => [...Buffer.from(part.content, "base64")]);
        expect(new TextDecoder().decode(new Uint8Array(joined))).toBe("a—b");
      }),
    ),
  ));
