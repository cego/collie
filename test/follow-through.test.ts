// A review that follows its merge request through the host's own engine, store and merge
// watch, on a fast clock, over a fake GitLab and a real git origin: one Run per merge request
// and login, a signed note per round, no agent while it waits, and approval the human's only
// answer. Each runs as shipped and under an unrelated id (ADR-0029).

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, Exit, FileSystem, Schema } from "effect";
import { Rig } from "./support/recorder";
import { runEffect as runLive } from "./support/effect";
import { installFakeSkills } from "./support/defs";
import { exec } from "./support/command";
import { serveForges, type FakeMr, type ForgeModel } from "./support/forge";
import { fixtures } from "./support/host";
import { ROOT, until, watching } from "./support/watching";
import { HOLD, Registry } from "../src/engine";
import { Store } from "../src/store";
import { sectionOf } from "../src/board-model";
import { readMetrics } from "../src/metrics";

const PROJECT = "gitlab.cego.dk/mk/collie";
const TARGET = `https://${PROJECT}/-/merge_requests/7`;
const KEY = `${PROJECT}!7`;
const MR_REF = "refs/merge-requests/7/head";

let rig: Rig;
let host: ReturnType<typeof watching>;

beforeEach(() =>
  runLive(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      host = watching(rig);
      yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeDirectory(rig.projectDir, { recursive: true })),
      );
      yield* installFakeSkills(rig.root);
    }),
  ),
);

afterEach(() => runLive(rig.close()));

const mr = (head: string, over: Partial<FakeMr> = {}): FakeMr => ({
  project: PROJECT,
  iid: "7",
  state: "open",
  head,
  author: "ann",
  sourceBranch: "feature",
  checks: [{ name: "test", state: "passed" }],
  ...over,
});

const model = (head: string, over: Partial<ForgeModel> = {}): ForgeModel => ({
  installed: true,
  loggedIn: ["gitlab.cego.dk"],
  login: "mk",
  mrs: [mr(head)],
  ...over,
});

const git = (args: ReadonlyArray<string>, cwd = rig.projectDir) =>
  exec(["git", "-c", "user.name=ann", "-c", "user.email=ann@example.com", ...args], {
    cwd,
  }).pipe(
    Effect.filterOrElse(
      (ran) => ran.exitCode === 0,
      (ran) => Effect.die(new Error(`git ${Arr.join(args, " ")}: ${ran.stderr}`)),
    ),
  );

/** A project whose origin keeps the merge request's ref, as GitLab does. */
const repository = Effect.gen(function* () {
  yield* git(["init", "-q", "--bare", `${rig.root}/origin.git`], rig.root);
  yield* git(["init", "-q", "-b", "main"]);
  yield* git(["remote", "add", "origin", `${rig.root}/origin.git`]);
  yield* git(["commit", "-q", "--allow-empty", "-m", "start"]);
  yield* git(["push", "-q", "origin", "main"]);
});

/** The author pushes a commit, and GitLab moves the merge request's ref to it. */
const pushed = (what: string, ref = MR_REF) =>
  Effect.gen(function* () {
    yield* git(["commit", "-q", "--allow-empty", "-m", what]);
    yield* git(["push", "-q", "--force", "origin", `HEAD:${ref}`]);
    return Str.trim((yield* git(["rev-parse", "HEAD"])).stdout);
  });

/** The shipped review, under its own id or one that has nothing to do with it. */
const entryOf = (id: string) =>
  Effect.gen(function* () {
    if (id === "review") return `${ROOT}workflows/review.workflow.ts`;
    const fs = yield* FileSystem.FileSystem;
    const entry = `${rig.root}/user/workflows/${id}.workflow.ts`;
    yield* fs.makeDirectory(`${rig.root}/user/workflows`, { recursive: true });
    yield* fs.writeFileString(
      entry,
      Arr.join(
        [
          `import shipped from "${ROOT}workflows/review.workflow.ts";`,
          `import { defineWorkflow } from "collie";`,
          `export default defineWorkflow({ ...shipped, id: "${id}", title: "${id}" });`,
          "",
        ],
        "\n",
      ),
    );
    return entry;
  }).pipe(Effect.orDie);

const F1 = {
  id: "F1",
  severity: "major",
  file: "src/a.ts",
  title: "guard the input",
};
const F2 = {
  id: "F2",
  severity: "major",
  file: "src/b.ts",
  title: "close the handle",
};
const review = (findings: ReadonlyArray<Schema.Json>) => ({
  verdict: findings.length === 0 ? "clean" : "findings",
  summary: "It guards the input.",
  findings,
  dropped: [],
  fixed: [],
});

const notesOf = <E>(forge: { readonly model: () => Effect.Effect<ForgeModel, E> }) =>
  Effect.map(forge.model(), (got) => Rec.values(got.notes ?? {}).flat()).pipe(Effect.orDie);

const asked = (runId: string) => Store.pipe(Effect.flatMap((store) => store.asked(runId)));

for (const id of ["review", "second-look"])
  test(
    `${id}: !481 without Slack — one signed note, one round on the new head, and approval the only answer`,
    () =>
      host.runEffect(
        Effect.gen(function* () {
          yield* repository;
          const first = yield* pushed("fix the input");
          const forge = yield* host.gitlab(model(first));
          yield* host.settingOn(true);
          yield* rig.queueOutputs([
            review([F1, F2]),
            review([
              { ...F1, status: "fixed" },
              { ...F2, status: "fixed" },
            ]),
          ]);
          const entry = yield* entryOf(id);
          yield* host.session(
            forge,
            Effect.gen(function* () {
              const { runId } = yield* host.started(entry, "cli-1", {
                target: TARGET,
              });
              const { board } = yield* host.mergeWatched;
              yield* until(
                () => host.watchOf(runId, TARGET),
                (row) => row !== null,
              );
              const posted = yield* notesOf(forge);
              expect(posted).toHaveLength(1);
              expect(Str.split(posted[0]!, "\n").at(-1)).toBe(
                `Review by Collie for @mk · ${runId} round 1 at ${first}`,
              );
              expect(Arr.map(yield* asked(runId), (row) => row.decision)).toEqual([]);
              expect(yield* host.agentStarts).toHaveLength(1);

              const second = yield* pushed("close the handle");
              yield* forge.set(
                model(second, {
                  ancestry: { [second]: [first] },
                  notes: (yield* forge.model()).notes,
                }),
              );
              const pending = yield* until(
                () => asked(runId),
                (rows) => Arr.some(rows, (row) => row.decision === "approve-2"),
              );
              expect(
                Option.getOrThrow(Arr.findFirst(pending, (row) => row.decision === "approve-2"))
                  .prompt,
              ).toBe(`Approve mk/collie!7 at ${second}?`);
              const notes = yield* notesOf(forge);
              expect(notes).toHaveLength(2);
              expect(notes[1]).toContain(`all findings fixed at \`${second}\``);
              expect(Str.split(notes[1]!, "\n").at(-1)).toBe(
                `Review by Collie for @mk · ${runId} round 2 at ${second}`,
              );
              expect(yield* host.agentStarts).toHaveLength(2);
              const { views } = yield* board;
              const card = Option.getOrThrow(
                Arr.findFirst(views, (view) => Arr.some(view.runs, (one) => one === runId)),
              );
              expect(sectionOf(card)).toBe("needs-you");

              const registry = yield* Registry;
              yield* registry.answer({
                runId,
                decision: "approve-2",
                value: "Approve",
                request: "answer-1",
              });
              yield* until(
                () => forge.model(),
                (got) => (got.approved ?? []).includes(KEY),
              );
              const approvals = Arr.filter(forge.requests(), (one) =>
                Str.endsWith("/merge_requests/7/approve")(one.url),
              );
              expect(approvals).toHaveLength(1);
              expect(approvals[0]?.body).toEqual({ sha: second });

              yield* forge.set(
                model(second, {
                  approved: [KEY],
                  notes: (yield* forge.model()).notes,
                  mrs: [mr(second, { state: "merged", mergedSha: second })],
                }),
              );
              const done = yield* until(
                () => host.status(runId),
                (view) => view?.status.status === "complete",
              );
              expect(done?.status.status === "complete" && done.status.value).toBe(
                "mk/collie!7 was merged",
              );
              expect(yield* notesOf(forge)).toHaveLength(2);
              expect(
                Arr.map(
                  Arr.filter(yield* asked(runId), (row) => row.answer !== null),
                  (row) => [row.decision, row.answer],
                ),
              ).toEqual([["approve-2", "Approve"]]);
              expect(yield* host.agentStarts).toHaveLength(2);
            }),
          );
        }),
      ),
    600_000,
  );

const follows = `${fixtures}/follows-mr.workflow.ts`;

for (const following of [true, false])
  test(
    `${following ? "followed" : "manual"} GitHub approval attempts dismissal before reporting a transient post-submit check`,
    () =>
      host.runEffect(
        Effect.gen(function* () {
          yield* repository;
          const head = yield* pushed("ready to approve", "refs/pull/7/head");
          const target = "https://github.com/acme/app/pull/7";
          const forge = yield* host.github({
            installed: true,
            loggedIn: ["github.com"],
            login: "mk",
            mrs: [{ project: "github.com/acme/app", iid: "7", state: "open", author: "ann", head }],
          });
          let accepted = false;
          let dismissed = 0;
          const api = yield* serveForges({
            forge: "github",
            face: async (url, init) => {
              if (accepted && url.endsWith("/pulls/7") && init?.method === "GET")
                return Response.json(
                  { message: "temporarily unavailable" },
                  { status: following ? 503 : 429 },
                );
              if (url.endsWith("/dismissals")) {
                dismissed += 1;
                if (!following) return Response.json({ message: "Forbidden" }, { status: 403 });
              }
              const response = await forge.face(url, init);
              if (url.endsWith("/reviews") && init?.method === "POST") accepted = true;
              return response;
            },
          });
          yield* host.settingOn(following);
          yield* rig.queueOutputs([review([])]);
          yield* host.session(
            { ...forge, api },
            Effect.gen(function* () {
              const { runId } = yield* host.started(yield* entryOf("review"), "cli-1", { target });
              const decision = following ? "approve-1" : "post-1";
              yield* until(
                () => asked(runId),
                (rows) => Arr.some(rows, (row) => row.decision === decision),
              );
              yield* (yield* Registry).answer({
                runId,
                decision,
                value: following ? "Approve" : `Post and approve ${head.slice(0, 7)}`,
                request: "approve",
              });
              const { view: done } = yield* until(
                () =>
                  Effect.all({
                    view: host.status(runId),
                    watch: host.watchOf(runId, target),
                  }),
                ({ view, watch }) =>
                  view?.status.status === "failed" ||
                  (view?.status.status === "suspended" && view.park != null) ||
                  watch?.name === "follow-1",
              );
              expect(dismissed).toBe(1);
              expect(done?.park).toBeNull();
              const reason = done?.status.status === "failed" ? done.status.reason : "";
              if (!following) {
                expect(done?.status.status).toBe("failed");
                expect(reason).toContain("approval may still be active");
                expect(reason).toContain("review 1");
              }
              expect((yield* forge.model()).approved ?? []).toHaveLength(following ? 0 : 1);
              expect(
                Arr.filter(
                  forge.requests(),
                  (one) => one.method === "POST" && one.url.endsWith("/reviews"),
                ),
              ).toHaveLength(1);
            }),
          );
        }),
      ),
    180_000,
  );

for (const state of ["closed", "merged"] as const)
  test(
    `a merge request ${state} during review finishes without posting or asking for approval`,
    () =>
      host.runEffect(
        Effect.gen(function* () {
          yield* repository;
          const head = yield* pushed("ready to review");
          const forge = yield* host.gitlab(model(head));
          yield* host.settingOn(true);
          yield* rig.queueOutputs([review([])]);
          let ended = false;
          forge.before(async () => {
            if (ended || (await runLive(host.agentStarts)).length === 0) return;
            ended = true;
            await runLive(forge.set(model(head, { mrs: [mr(head, { state })] })));
          });
          yield* host.session(
            forge,
            Effect.gen(function* () {
              const { runId } = yield* host.started(yield* entryOf("review"), "cli-1", {
                target: TARGET,
              });
              yield* host.mergeWatched;
              const done = yield* until(
                () => host.status(runId),
                (view) => view?.status.status === "complete",
              );
              expect(ended).toBe(true);
              expect(done?.status.status === "complete" && done.status.value).toBe(
                `mk/collie!7 was ${state}`,
              );
              expect(yield* notesOf(forge)).toEqual([]);
              expect(yield* asked(runId)).toEqual([]);
            }),
          );
        }),
      ),
    180_000,
  );

test(
  "a second start of a followed merge request by the same login is the first Run, whatever it was given",
  () =>
    host.runEffect(
      Effect.gen(function* () {
        const forge = yield* host.gitlab(model("1111111111111111111111111111111111111111"));
        yield* host.settingOn(true);
        yield* host.session(
          forge,
          Effect.gen(function* () {
            const first = yield* host.started(follows, "cli-1", {
              target: TARGET,
            });
            const again = yield* host.started(follows, "chat-1", {
              target: TARGET,
              proves: "feature",
            });
            expect(again.runId).toBe(first.runId);
            expect(again.fresh).toBe(false);
            expect(again.followed).toBe("gitlab.cego.dk/mk/collie!7");
            expect(first.fresh).toBe(true);
          }),
        );
      }),
    ),
  120_000,
);

test(
  "with following off, each start is a Run of its own",
  () =>
    host.runEffect(
      Effect.gen(function* () {
        const forge = yield* host.gitlab(model("1111111111111111111111111111111111111111"));
        yield* host.settingOn(false);
        yield* host.session(
          forge,
          Effect.gen(function* () {
            const first = yield* host.started(follows, "cli-1", {
              target: TARGET,
            });
            const again = yield* host.started(follows, "chat-1", {
              target: TARGET,
            });
            expect(again.runId).not.toBe(first.runId);
          }),
        );
      }),
    ),
  120_000,
);

const signatures = (notes: ReadonlyArray<string>) =>
  Arr.map(notes, (note) => Str.split(note, "\n").at(-1));

for (const id of ["review", "second-look"])
  test(
    `${id}: a head moved during a round posts nothing for that round, and the next round reviews the newer head`,
    () =>
      host.runEffect(
        Effect.gen(function* () {
          yield* repository;
          const first = yield* pushed("fix the input");
          const forge = yield* host.gitlab(model(first));
          yield* host.settingOn(true);
          const fixed = review([
            { ...F1, status: "fixed" },
            { ...F2, status: "fixed" },
          ]);
          const discovered = { id: "F3", severity: "major", title: "validate the redirect" };
          yield* rig.queueOutputs([
            review([F1, F2]),
            review([...fixed.findings, discovered]),
            review([...fixed.findings, { ...discovered, status: "fixed" }]),
          ]);
          const entry = yield* entryOf(id);
          let second = "";
          let third = "";
          let moving: Promise<void> | null = null;
          // Once round 2's reviewer is at work, the author pushes again before it is done.
          forge.before(
            () =>
              moving ??
              runLive(host.agentStarts).then((starts) => {
                if (starts.length < 2) return;
                moving ??= runLive(
                  Effect.gen(function* () {
                    third = yield* pushed("and the other handle");
                    const now = yield* forge.model();
                    yield* forge.set({
                      ...now,
                      mrs: [mr(third)],
                      ancestry: { ...now.ancestry, [third]: [second, first] },
                    });
                  }),
                );
                return moving;
              }),
          );
          yield* host.session(
            forge,
            Effect.gen(function* () {
              const { runId } = yield* host.started(entry, "cli-1", {
                target: TARGET,
              });
              yield* host.mergeWatched;
              yield* until(
                () => host.watchOf(runId, TARGET),
                (row) => row !== null,
              );
              second = yield* pushed("close the handle");
              yield* forge.set(
                model(second, {
                  ancestry: { [second]: [first] },
                  notes: (yield* forge.model()).notes,
                }),
              );
              const pending = yield* until(
                () => asked(runId),
                (rows) => Arr.some(rows, (row) => row.decision === "approve-3"),
              );
              expect(third).not.toBe("");
              expect(Arr.map(pending, (row) => row.decision)).toEqual(["approve-3"]);
              expect(Option.getOrThrow(Arr.head(pending)).prompt).toBe(
                `Approve mk/collie!7 at ${third}?`,
              );
              const notes = yield* notesOf(forge);
              expect(signatures(notes)).toEqual([
                `Review by Collie for @mk · ${runId} round 1 at ${first}`,
                `Review by Collie for @mk · ${runId} round 3 at ${third}`,
              ]);
              expect(notes[1]).toContain("F3: fixed — validate the redirect");
              expect(yield* host.agentStarts).toHaveLength(3);
              const fs = yield* FileSystem.FileSystem;
              const prompts = yield* fs.readDirectory(`${host.dir()}/agents/${runId}`);
              const thirdPrompt = Option.getOrThrow(
                Arr.findFirst(
                  prompts,
                  (file) => file.startsWith("review-3-") && file.endsWith(".prompt.md"),
                ),
              );
              expect(
                yield* fs.readFileString(`${host.dir()}/agents/${runId}/${thirdPrompt}`),
              ).toContain('"title": "validate the redirect"');
            }),
          );
        }),
      ),
    600_000,
  );

/** A followed review of !7 at its first head, the reviewers answering `outputs` in turn. */
const begun = (id: string, outputs: ReadonlyArray<Schema.Json>) =>
  Effect.gen(function* () {
    yield* repository;
    const first = yield* pushed("fix the input");
    const forge = yield* host.gitlab(model(first));
    yield* host.settingOn(true);
    yield* rig.queueOutputs(outputs);
    return { first, forge, entry: yield* entryOf(id) };
  });
type Forge = Effect.Success<ReturnType<typeof begun>>["forge"];

/** The author pushes on from `from`, and the merge request shows it. */
const pushedOn = (forge: Forge, from: string) =>
  Effect.gen(function* () {
    const next = yield* pushed("and more");
    const now = yield* forge.model();
    yield* forge.set({
      ...now,
      mrs: [mr(next)],
      ancestry: {
        ...now.ancestry,
        [next]: [from, ...(now.ancestry?.[from] ?? [])],
      },
    });
    return next;
  });

const startedWaiting = (entry: string) =>
  Effect.gen(function* () {
    const { runId } = yield* host.started(entry, "cli-1", { target: TARGET });
    yield* host.mergeWatched;
    yield* until(
      () => host.watchOf(runId, TARGET),
      (row) => row !== null,
    );
    return runId;
  });

const approvals = (forge: Forge) =>
  Arr.map(
    Arr.filter(forge.requests(), (one) => Str.endsWith("/merge_requests/7/approve")(one.url)),
    (one) => one.body,
  );

test(
  "concurrent forge failures park the initial head read once and recover before launching a reviewer",
  () =>
    host.runEffect(
      Effect.gen(function* () {
        const { first, forge, entry } = yield* begun("review", [review([])]);
        let unavailable = true;
        let failing: Promise<void> | null = null;
        let replies = 0;
        const together = Promise.withResolvers<void>();
        forge.before((url) =>
          unavailable && Str.includes("/merge_requests/7")(url)
            ? (failing ??= runLive(forge.set(model(first, { httpFault: { status: 503 } }))))
            : Promise.resolve(),
        );
        forge.after((url, _init, response) => {
          if (!unavailable || !Str.includes("/merge_requests/7")(url))
            return Promise.resolve(response);
          if (++replies === 3) together.resolve();
          return together.promise.then(() => response);
        });
        yield* host.session(
          forge,
          Effect.gen(function* () {
            yield* host.recovering;
            const { runId } = yield* host.started(entry, "cli-1", { target: TARGET });
            const parked = yield* until(
              () => host.status(runId),
              (view) =>
                view?.status.status === "failed" ||
                (view?.status.status === "suspended" && view.park != null),
            );
            expect(parked?.status.status).toBe("suspended");
            expect(parked?.park).toMatchObject({ cause: "forge-unavailable", kind: "rechecks" });
            expect(yield* host.agentStarts).toHaveLength(0);
            unavailable = false;
            yield* forge.set(model(first));
            yield* until(
              () => asked(runId),
              (rows) => Arr.some(rows, (row) => row.decision === "approve-1"),
            );
            expect((yield* host.status(runId))?.park).toBeNull();
            expect(yield* host.agentStarts).toHaveLength(1);
            expect(yield* notesOf(forge)).toHaveLength(1);
          }),
        );
      }),
    ),
  600_000,
);

for (const id of ["review", "second-look"])
  for (const status of [503, 429])
    test(
      `${id}: forge ${status} during the wait parks for rechecks and recovers automatically`,
      () =>
        host.runEffect(
          Effect.gen(function* () {
            const { first, forge, entry } = yield* begun(id, [
              review([F1]),
              review([{ ...F1, status: "fixed" }]),
            ]);
            yield* host.session(
              forge,
              Effect.gen(function* () {
                const runId = yield* startedWaiting(entry);
                yield* host.recovering;
                const before = yield* forge.model();
                yield* forge.set({ ...before, httpFault: { status } });
                const parked = yield* until(
                  () => host.status(runId),
                  (view) =>
                    view?.status.status === "failed" ||
                    (view?.status.status === "suspended" && view.park != null),
                ).pipe(Effect.timeout("10 minutes"));
                expect(parked?.status.status).toBe("suspended");
                expect(parked?.park).toMatchObject({
                  cause: "forge-unavailable",
                  kind: "rechecks",
                });
                expect(yield* host.agentStarts).toHaveLength(1);
                yield* forge.set(before);
                yield* until(
                  () => readMetrics(`${host.dir()}/evidence/${runId}`),
                  (lines) =>
                    Arr.some(
                      lines,
                      (line) => line.action === "resumed" && line.outcome === "resumed",
                    ),
                );
                expect((yield* host.status(runId))?.park).toBeNull();
                expect(yield* host.agentStarts).toHaveLength(1);
                yield* pushedOn(forge, first);
                yield* until(
                  () => asked(runId),
                  (rows) => Arr.some(rows, (row) => row.decision === "approve-2"),
                );
                expect(yield* notesOf(forge)).toHaveLength(2);
                expect(yield* host.agentStarts).toHaveLength(2);
              }),
            );
          }),
        ),
      600_000,
    );

for (const id of ["review", "second-look"])
  for (const status of [503, 429])
    test(
      `${id}: forge ${status} after accepting a review parks its Activity and recovers without a duplicate note`,
      () =>
        host.runEffect(
          Effect.gen(function* () {
            const { forge, entry } = yield* begun(id, [review([])]);
            let accepted = false;
            let unavailable = true;
            forge.after((url, init, response) => {
              if (init?.method === "POST" && Str.endsWith("/notes")(url)) accepted = true;
              return Promise.resolve(
                accepted && unavailable
                  ? new Response('{"message":"temporarily unavailable"}', { status })
                  : response,
              );
            });
            yield* host.session(
              forge,
              Effect.gen(function* () {
                yield* host.recovering;
                const { runId } = yield* host.started(entry, "cli-1", { target: TARGET });
                const parked = yield* until(
                  () => host.status(runId),
                  (view) =>
                    view?.status.status === "failed" ||
                    (view?.status.status === "suspended" && view.park != null),
                );
                expect(parked?.status.status).toBe("suspended");
                expect(parked?.park).toMatchObject({
                  cause: "forge-unavailable",
                  kind: "rechecks",
                });
                expect(yield* notesOf(forge)).toHaveLength(1);
                expect(yield* host.agentStarts).toHaveLength(1);
                unavailable = false;
                yield* until(
                  () => asked(runId),
                  (rows) => Arr.some(rows, (row) => row.decision === "approve-1"),
                );
                expect((yield* host.status(runId))?.park).toBeNull();
                expect(yield* notesOf(forge)).toHaveLength(1);
                expect(
                  Arr.filter(
                    forge.requests(),
                    (one) => one.method === "POST" && Str.endsWith("/notes")(one.url),
                  ),
                ).toHaveLength(1);
                expect(yield* host.agentStarts).toHaveLength(1);
              }),
            );
          }),
        ),
      600_000,
    );

for (const id of ["review", "second-look"]) {
  test(
    `${id}: a push while the approval is asked supersedes the question, and approves only the newer head`,
    () =>
      host.runEffect(
        Effect.gen(function* () {
          const { first, forge, entry } = yield* begun(id, [review([]), review([])]);
          yield* host.session(
            forge,
            Effect.gen(function* () {
              const { runId } = yield* host.started(entry, "cli-1", {
                target: TARGET,
              });
              yield* host.mergeWatched;
              yield* until(
                () => asked(runId),
                (rows) => Arr.some(rows, (row) => row.decision === "approve-1"),
              );
              const second = yield* pushedOn(forge, first);
              const rows = yield* until(
                () => asked(runId),
                (rows) => Arr.some(rows, (row) => row.decision === "approve-2"),
              );
              const old = Option.getOrThrow(
                Arr.findFirst(rows, (row) => row.decision === "approve-1"),
              );
              expect(old.answer).not.toBeNull();
              expect(["Approve", "Not now"]).not.toContain(old.answer);
              const registry = yield* Registry;
              const late = yield* Effect.exit(
                registry.answer({
                  runId,
                  decision: "approve-1",
                  value: "Approve",
                  request: "late-1",
                }),
              );
              expect(Exit.isFailure(late)).toBe(true);
              yield* registry.answer({
                runId,
                decision: "approve-2",
                value: "Approve",
                request: "answer-2",
              });
              yield* until(
                () => forge.model(),
                (got) => (got.approved ?? []).includes(KEY),
              );
              expect(approvals(forge)).toEqual([{ sha: second }]);
              expect(yield* host.agentStarts).toHaveLength(2);
            }),
          );
        }),
      ),
    600_000,
  );

  test(
    `${id}: closing the merge request while it waits finishes the Run, and nothing is posted after`,
    () =>
      host.runEffect(
        Effect.gen(function* () {
          const { first, forge, entry } = yield* begun(id, [review([F1])]);
          yield* host.session(
            forge,
            Effect.gen(function* () {
              const runId = yield* startedWaiting(entry);
              expect(yield* notesOf(forge)).toHaveLength(1);
              const now = yield* forge.model();
              yield* forge.set({
                ...now,
                mrs: [mr(first, { state: "closed" })],
              });
              const done = yield* until(
                () => host.status(runId),
                (view) => view?.status.status === "complete",
              );
              expect(done?.status.status === "complete" && done.status.value).toBe(
                "mk/collie!7 was closed",
              );
              yield* Effect.sleep("10 minutes");
              expect(yield* notesOf(forge)).toHaveLength(1);
              expect(yield* host.agentStarts).toHaveLength(1);
            }),
          );
        }),
      ),
    600_000,
  );

  test(
    `${id}: turned off while it waits, the next round asks what to post`,
    () =>
      host.runEffect(
        Effect.gen(function* () {
          const { first, forge, entry } = yield* begun(id, [review([F1, F2]), review([F1, F2])]);
          yield* host.session(
            forge,
            Effect.gen(function* () {
              const runId = yield* startedWaiting(entry);
              yield* host.settingOn(false);
              yield* pushedOn(forge, first);
              const rows = yield* until(
                () => asked(runId),
                (rows) => rows.length > 0,
              );
              expect(Arr.map(rows, (row) => row.decision)).toEqual(["post-1"]);
              expect(yield* notesOf(forge)).toHaveLength(1);
              expect(yield* host.agentStarts).toHaveLength(2);
            }),
          );
        }),
      ),
    600_000,
  );

  test(
    `${id}: held while it waits, a push brings no note and no round until the hold is let go`,
    () =>
      host.runEffect(
        Effect.gen(function* () {
          const { first, forge, entry } = yield* begun(id, [
            review([F1]),
            review([{ ...F1, status: "fixed" }]),
          ]);
          yield* host.session(
            forge,
            Effect.gen(function* () {
              const runId = yield* startedWaiting(entry);
              const registry = yield* Registry;
              yield* registry.control({ runId, control: HOLD, set: true });
              yield* pushedOn(forge, first);
              yield* until(
                () => host.watchOf(runId, TARGET),
                (row) => row === null,
              );
              yield* Effect.sleep("10 minutes");
              expect(yield* notesOf(forge)).toHaveLength(1);
              expect(yield* host.agentStarts).toHaveLength(1);
              yield* registry.control({ runId, control: HOLD, set: false });
              yield* until(
                () => notesOf(forge),
                (notes) => notes.length === 2,
              );
              expect(yield* host.agentStarts).toHaveLength(2);
            }),
          );
        }),
      ),
    600_000,
  );

  test(
    `${id}: a host killed while it waits, and again after the forge took a note before the Run recorded it, leaves one note a round`,
    () =>
      host.runEffect(
        Effect.gen(function* () {
          const fixed = review([
            { ...F1, status: "fixed" },
            { ...F2, status: "fixed" },
          ]);
          const { first, forge, entry } = yield* begun(id, [review([F1, F2]), fixed]);
          const runId = yield* host.session(forge, startedWaiting(entry));
          expect(yield* host.agentStarts).toHaveLength(1);

          const accepted = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          let holding = true;
          yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()));
          forge.after((url, init, response) => {
            if (!holding || init?.method !== "POST" || !Str.endsWith("/notes")(url))
              return Promise.resolve(response);
            holding = false;
            accepted.resolve();
            return release.promise.then(() => response);
          });
          yield* host.session(
            forge,
            Effect.gen(function* () {
              expect((yield* host.watchOf(runId, TARGET)) !== null).toBe(true);
              yield* host.mergeWatched;
              yield* Effect.sleep("10 minutes");
              expect(yield* host.agentStarts).toHaveLength(1);
              yield* pushedOn(forge, first);
              yield* Effect.promise(() => accepted.promise);
              expect(yield* notesOf(forge)).toHaveLength(2);
            }),
          );
          release.resolve();

          yield* host.session(
            forge,
            Effect.gen(function* () {
              yield* host.mergeWatched;
              yield* until(
                () => asked(runId),
                (rows) => Arr.some(rows, (row) => row.decision === "approve-2"),
              );
              expect(
                Arr.map(
                  yield* notesOf(forge),
                  (note) => Str.split(" at ")(Str.split(note, "\n").at(-1) ?? "")[0],
                ),
              ).toEqual([
                `Review by Collie for @mk · ${runId} round 1`,
                `Review by Collie for @mk · ${runId} round 2`,
              ]);
              expect(yield* host.agentStarts).toHaveLength(2);
            }),
          );
        }),
      ),
    600_000,
  );
}
