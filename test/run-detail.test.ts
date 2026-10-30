// One Run's details as the host serves them while a drawer is open: followed as they
// change, with large items fetched by reference.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import {
  Cause,
  ConfigProvider,
  Effect,
  Fiber,
  FileSystem,
  Logger,
  Option,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { startedBy, type AuditLine } from "../src/audit";
import type { RunDetail } from "../src/board-model";
import { evidenceDir, runDir } from "../src/engine";
import { currentEnv } from "../src/env";
import { appState } from "../src/flows";
import { forgeHttpLayer } from "../src/forge/http";
import { Herdr } from "../src/herdr";
import { frontDoor, socketOf } from "../src/host";
import { followRunDetail } from "../src/lifecycle";
import { scopeFor } from "../src/registry";
import { recordReply } from "../src/replies";
import { diffOf, fetchRef, keepDiffs, runDiff } from "../src/run-detail";
import { buildRunDetail, type PlanCache } from "../src/views";
import { madeRun } from "./support/records";
import { runRowId } from "../src/ui/state";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { FakeBin } from "./support/bin";
import { forgeOnPath, serveForges } from "./support/forge";
import { focus } from "./support/focus";
import { stopHost, until } from "./support/host";
import { collie, proves } from "./support/world";
import * as Layer from "effect/Layer";

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
          const door = yield* frontDoor(socketOf(world.state));
          const seen: Array<RunDetail | null> = [];
          const reading = yield* door
            .runDetail({ runId, tail: true, pages: 1, refreshMr: false })
            .pipe(
              Stream.tap((detail) => Effect.sync(() => seen.push(detail))),
              Stream.takeUntil(
                (detail) =>
                  detail !== null &&
                  detail.tail?._tag === "Text" &&
                  pipe_(detail.tail.text, Str.includes("later line")) &&
                  Arr.some(detail.evidence, (one) => one.name === "shot.png"),
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

test(
  "the handoff notes a Run's agents leave are on its record, in run show and fetched by reference",
  () =>
    proves(
      "collie-detail-handoffs-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const runId = yield* started(world, ["plain", "--input", "note=hi"]);
          const handoffs = `${runDir(world.state, runId)}/handoffs`;
          yield* fs.makeDirectory(`${handoffs}/review`, { recursive: true });
          yield* fs.writeFileString(`${handoffs}/review/notes.md`, "for the reviewer\n");

          const shown = yield* collie(world, ["run", "show", runId]);
          expect(shown.envelope.data).toMatchObject({
            handoffs: [{ path: `${handoffs}/review/notes.md`, bytes: 17 }],
          });

          const door = yield* frontDoor(socketOf(world.state));
          const detail = yield* door
            .runDetail({ runId, tail: false, pages: 1, refreshMr: false })
            .pipe(Stream.runHead, Effect.timeout("30 seconds"));
          expect(Option.getOrNull(detail)?.handoffFiles).toEqual([
            { name: "review/notes.md", bytes: 17 },
          ]);
          const note = yield* door.runFile({ runId, ref: "handoff:review/notes.md" });
          expect(note.content).toBe("for the reviewer\n");
          const outside = yield* door
            .runFile({ runId, ref: "handoff:../log.txt" })
            .pipe(Effect.flip);
          expect(outside._tag).toBe("HostRefused");
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      ["plain.workflow.ts"],
    ),
  120_000,
);

test(
  "the replies a Run posted to reviewers are on its record, in run show and the drawer",
  () =>
    proves(
      "collie-detail-replies-",
      (world) =>
        Effect.gen(function* () {
          const runId = yield* started(world, ["plain", "--input", "note=hi"]);
          const mr = "https://github.com/acme/app/pull/7";
          const replies = [
            {
              at: "2026-10-27T10:00:00Z",
              mr,
              comment: `${mr}#issuecomment-41`,
              kind: "fixed" as const,
              body: "Fixed in `c0ffee12`: renamed it",
            },
            {
              at: "2026-10-27T10:01:00Z",
              mr,
              comment: `${mr}#issuecomment-42`,
              kind: "disputed" as const,
              body: "Not changed: a map costs more here",
            },
          ];
          for (const reply of replies) yield* recordReply(runDir(world.state, runId), reply);

          const shown = yield* collie(world, ["run", "show", runId]);
          expect(shown.envelope.data).toMatchObject({ replies });

          const detail = yield* (yield* frontDoor(socketOf(world.state)))
            .runDetail({ runId, tail: false, pages: 1, refreshMr: false })
            .pipe(Stream.runHead, Effect.timeout("30 seconds"));
          expect(Option.getOrNull(detail)?.replies).toEqual(replies);
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
          const bin = yield* FakeBin.make(`${world.home}/bin`);
          const gitlab = yield* forgeOnPath(bin, "gitlab", {
            installed: true,
            loggedIn: ["gitlab.example.com"],
            login: "me",
            mrs: [
              { project: "gitlab.example.com/mk/project", iid: "7", state: "open", title: "Cards" },
            ],
          });
          const COLLIE_FORGE_API = yield* serveForges(gitlab);
          yield* bin.restore();
          const runId = yield* started(world, ["targeted", "--input", `target=${MR}`], {
            PATH: `${bin.dir}:/usr/bin:/bin`,
            COLLIE_FORGE_API,
          });
          const door = yield* frontDoor(socketOf(world.state));
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
                pipe_(state.detail.tail.text, Str.includes("from the host")),
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

test.skipIf(process.getuid?.() === 0)(
  "a defect in a drawer's stream is logged, and the stream follows the next details after it",
  () =>
    proves(
      "collie-detail-dies-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const runId = yield* started(world, ["plain", "--input", "note=hi"]);
          const dir = runDir(world.state, runId);
          const env = yield* currentEnv.pipe(Effect.orDie);
          const defects: Array<string> = [];
          const kept = Logger.make(({ logLevel, cause }) => {
            if (Cause.hasDies(cause)) defects.push(`${logLevel} ${Cause.pretty(cause)}`);
          });
          yield* Effect.gen(function* () {
            const detailOf = yield* followRunDetail(env);
            const key = { runId, tail: true, pages: 1, refreshMr: false };
            expect((yield* detailOf(key))?.id).toBe(runId);
            // Unreadable, the host cannot build the details, and its stream dies.
            yield* Effect.acquireRelease(fs.chmod(dir, 0o000), () =>
              fs.chmod(dir, 0o755).pipe(Effect.ignore),
            );
            yield* fs.makeDirectory(evidenceDir(world.state, runId), { recursive: true });
            yield* fs.writeFileString(`${evidenceDir(world.state, runId)}/poke`, "");
            yield* until(
              () => Effect.sync(() => defects.length),
              (count) => count > 0,
            );
            yield* fs.chmod(dir, 0o755);
            yield* fs.writeFileString(`${dir}/log.txt`, "after the defect\n", { flag: "a" });
            const after = yield* detailOf(key).pipe(
              Effect.repeat({
                until: (detail) =>
                  detail?.tail?._tag === "Text" &&
                  pipe_(detail.tail.text, Str.includes("after the defect")),
                schedule: Schedule.spaced("250 millis"),
                times: 80,
              }),
            );
            expect(after?.tail).toMatchObject({
              _tag: "Text",
              text: expect.stringContaining("after the defect"),
            });
          }).pipe(Effect.provide(Logger.layer([kept])));
          yield* stopHost(world.state);
          expect(defects[0]).toStartWith("Error ");
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
          : Effect.die(new Error(`git ${Arr.join(args, " ")}: ${done.stderr}`)),
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
        expect(
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(live), (present) =>
              Arr.map(present.files, (file) => file.path),
            ),
          ),
        ).toContain("wip.txt");
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
        expect(
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(first), (present_) =>
              Arr.map(present_.files, (file) => file.path),
            ),
          ),
        ).toContain("tab\there.txt");
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
        const joined = Buffer.concat(
          Arr.map([head, tail], (one) => Buffer.from(one.content, "base64")),
        );
        expect(joined.toString()).toBe(kept.content);
      }),
    ).pipe(Effect.provide(forgeHttpLayer)),
  ));

test("a kept diff is taken again once its branch has moved on", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { repo, git } = yield* branched;
        const state = yield* fs.makeTempDirectoryScoped({ prefix: "collie-diff-state-" });
        const stopped = yield* madeRun(state, { cwd: repo, branch: "feature", state: "stopped" });
        expect(
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(yield* diffOf(stopped)), (present__) =>
              Arr.map(present__.files, (file) => file.path),
            ),
          ),
        ).not.toContain("more.txt");

        // Resumed, it committed more and succeeded.
        yield* fs.writeFileString(`${repo}/more.txt`, "more\n");
        yield* git("add", "-A");
        yield* git("commit", "-qm", "more");
        const done = { ...stopped, state: "succeeded" as const };
        expect(
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(yield* diffOf(done)), (present___) =>
              Arr.map(present___.files, (file) => file.path),
            ),
          ),
        ).toContain("more.txt");
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
        const untracked = Option.getOrUndefined(
          Option.map(Option.fromNullishOr(live), (present____) =>
            Arr.filter(present____.files, (file) => file.path === "zero" || file.path === "pipe"),
          ),
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
        expect(Arr.every(parts, (part) => part.encoding === "base64")).toBe(true);
        const joined = Arr.flatMap(parts, (part) => [...Buffer.from(part.content, "base64")]);
        expect(new TextDecoder().decode(new Uint8Array(joined))).toBe("a—b");
      }),
    ).pipe(Effect.provide(forgeHttpLayer)),
  ));

test("an attachment is fetched by name, and never from outside the Run's attachments", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const state = yield* fs.makeTempDirectoryScoped({ prefix: "collie-ref-" });
        const run = yield* madeRun(state, {});
        yield* fs.makeDirectory(`${run.dir}/attachments`);
        yield* fs.writeFile(`${run.dir}/attachments/shot.png`, new Uint8Array([1, 2, 3]));
        yield* fs.writeFileString(`${state}/secret`, "key\n");
        yield* fs.symlink(`${state}/secret`, `${run.dir}/attachments/linked.png`);

        expect(yield* fetchRef(run, "attachment:shot.png", { offset: 1, length: 1 })).toEqual({
          ref: "attachment:shot.png",
          encoding: "base64",
          content: "Ag==",
          size: 3,
        });
        for (const ref of ["attachment:linked.png", "attachment:../log.txt"])
          expect((yield* fetchRef(run, ref).pipe(Effect.flip))._tag).toBe("HostRefused");
      }),
    ).pipe(Effect.provide(forgeHttpLayer)),
  ));

test("a pipeline: reference says how a GitLab pipeline or a GitHub Actions run went", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const state = yield* fs.makeTempDirectoryScoped({ prefix: "collie-pipeline-" });
        const bin = yield* FakeBin.make(`${state}/bin`);
        const runs = { "7": { status: "completed", conclusion: "failure" } };
        const github = yield* forgeOnPath(bin, "github", {
          installed: true,
          loggedIn: ["github.com"],
          login: "me",
          mrs: [],
          runs,
        });
        const gitlab = yield* forgeOnPath(bin, "gitlab", {
          installed: true,
          loggedIn: ["gitlab.example.com"],
          login: "me",
          mrs: [],
          runs: { "7": { status: "success" } },
        });
        const run = yield* madeRun(state, { state: "succeeded" });
        const api = yield* serveForges(github, gitlab);
        const said = (ref: string) =>
          fetchRef(run, ref).pipe(
            Effect.map((file) => file.content),
            Effect.catch((refused) => Effect.succeed(`refused: ${refused.reason}`)),
            Effect.provide(
              forgeHttpLayer.pipe(
                Layer.provideMerge(
                  ConfigProvider.layerAdd(
                    ConfigProvider.fromUnknown({
                      COLLIE_FORGE_API: api,
                    }),
                  ),
                ),
              ),
            ),
          );
        expect(yield* said("pipeline:https://github.com/cego/collie/actions/runs/7")).toBe(
          "failure",
        );
        expect(yield* said("pipeline:https://gitlab.example.com/group/app/-/pipelines/7")).toBe(
          "success",
        );
        expect(yield* said("pipeline:https://github.com/cego/collie/actions/runs/8")).toBe(
          "refused: GitHub did not say how https://github.com/cego/collie/actions/runs/8 went",
        );
        yield* bin.restore();
      }),
    ),
  ));

test("a rewritten ticket, and a finished Run's rewritten plan, reach the record's details", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const state = yield* fs.makeTempDirectoryScoped({ prefix: "collie-plan-" });
        const run = yield* madeRun(state, { state: "succeeded" });
        const env = { ...(yield* currentEnv.pipe(Effect.orDie)), stateDir: state };
        const plans: PlanCache = new Map();
        const planOf = () =>
          buildRunDetail({ env, runId: run.id, runs: [run], mr: null, plans }).pipe(
            Effect.map((detail) => detail?.plan),
          );
        yield* fs.makeDirectory(`${run.dir}/plan/issues`, { recursive: true });
        yield* fs.writeFileString(`${run.dir}/plan/SPEC.md`, "# Spec\n");
        yield* fs.writeFileString(`${run.dir}/plan/issues/01-a.md`, "# A\n- [ ] one\n");

        const first = yield* planOf();
        expect(first?.tickets[0]?.stamp).toBeString();
        expect(yield* planOf()).toBe(first);

        yield* fs.writeFileString(
          `${run.dir}/plan/issues/01-a.md`,
          "# A\n- [ ] one, said better\n",
        );
        const rewritten = yield* planOf();
        expect(rewritten?.tickets[0]).toMatchObject({ file: "01-a.md", title: "A", done: false });
        expect(rewritten?.tickets[0]?.stamp).not.toBe(first?.tickets[0]?.stamp);

        yield* fs.writeFileString(`${run.dir}/plan/SPEC.md`, "# Spec, rewritten\n");
        const respecced = yield* planOf();
        expect(respecced?.spec).toMatchObject({ _tag: "Text", text: "# Spec, rewritten\n" });
        expect(yield* planOf()).toBe(respecced);

        const prefix = Str.repeat(64 * 1024)("x");
        yield* fs.writeFileString(`${run.dir}/plan/SPEC.md`, `${prefix}old tail`);
        const long = yield* planOf();
        expect(long?.spec).toEqual({ _tag: "Text", text: prefix, truncated: true });
        expect(long?.specStamp).toBeString();
        yield* fs.writeFileString(`${run.dir}/plan/SPEC.md`, `${prefix}rewritten tail`);
        const tailOnly = yield* planOf();
        expect(tailOnly?.spec).toEqual(long?.spec);
        expect(tailOnly?.specStamp).not.toBe(long?.specStamp);
        expect(yield* planOf()).toBe(tailOnly);
      }),
    ),
  ));

test("a Run's record says who started it, from its start line, else from its parent", () => {
  const start = (actor: Partial<AuditLine["actor"]> & Pick<AuditLine["actor"], "origin">) =>
    [
      {
        at: "",
        operation: "answer",
        request: "a",
        actor: { requestId: "a", origin: "chat" },
        result: null,
      },
      {
        at: "",
        operation: "start",
        request: "r",
        actor: { requestId: "r", ...actor },
        result: null,
      },
    ] satisfies ReadonlyArray<AuditLine>;
  const top = { id: "run-1", parent: null };
  expect(
    startedBy(
      start({
        origin: "schedule",
        schedule: { name: "daily", occurrence: "2026-10-14T07:00:00Z" },
      }),
      top,
    ),
  ).toBe("Started by schedule `daily` for 2026-10-14T07:00:00Z");
  expect(startedBy(start({ origin: "chat" }), top)).toBe("Started from chat");
  expect(startedBy(start({ origin: "desktop" }), top)).toBe("Started from Desktop");
  expect(startedBy(start({ origin: "board" }), top)).toBe("Started from the board");
  expect(startedBy(start({ origin: "cli" }), top)).toBe("Started from the CLI");
  expect(startedBy(start({ origin: "cli-tty" }), top)).toBe("Started from the CLI");
  expect(startedBy([], { id: "run-1.review", parent: "run-1" })).toBe("Started by run-1 as review");
  expect(startedBy([], top)).toBeUndefined();
});

test(
  "a Run started from the CLI says so in its details and in run show",
  () =>
    proves(
      "collie-started-by-",
      (world) =>
        Effect.gen(function* () {
          const runId = yield* started(world, ["plain", "--input", "note=hi"]);
          const door = yield* frontDoor(socketOf(world.state));
          const detail = yield* door
            .runDetail({ runId, tail: false, pages: 1, refreshMr: false })
            .pipe(Stream.runHead, Effect.timeout("30 seconds"));
          expect(Option.getOrNull(detail)?.startedBy).toBe("Started from the CLI");
          const shown = yield* collie(world, ["run", "show", runId]);
          expect(shown.envelope).toMatchObject({
            ok: true,
            data: { startedBy: "Started from the CLI" },
          });
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      ["plain.workflow.ts"],
    ),
  120_000,
);
