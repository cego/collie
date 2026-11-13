import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, Exit, FileSystem, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Rig } from "./support/recorder";
import { runEffect as runLive } from "./support/effect";
import { installFakeSkills } from "./support/defs";
import { exec } from "./support/command";
import { serveForges, type FakeMr, type ForgeModel } from "./support/forge";
import { fixtures } from "./support/host";
import { ROOT, until, watching } from "./support/watching";
import { HOLD, Registry } from "../src/engine";
import { Host } from "../src/sdk";
import { Store } from "../src/store";
import { sectionOf } from "../src/board-model";
import { readMetrics } from "../src/metrics";
import { newsPath, read as readNews } from "../src/news";
import { machineHerd } from "../src/steering";

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
  yield* git(["config", `url.${rig.root}/origin.git.insteadOf`, `https://${PROJECT}.git`]);
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
    const entry = `${rig.userDir}/workflows/${id}.workflow.ts`;
    yield* fs.makeDirectory(`${rig.userDir}/workflows`, { recursive: true });
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

const configured = (on: boolean) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.writeFileString(
        `${rig.userDir}/config.json`,
        JSON.stringify({
          review: { follow_through: on },
          projects: { root: rig.root },
          gitlab_host: "gitlab.cego.dk",
        }),
      ),
    ),
    Effect.orDie,
  );

const loaded = Effect.gen(function* () {
  const entry = yield* entryOf("review");
  return yield* Registry.pipe(Effect.flatMap((registry) => registry.load(entry)));
}).pipe(Effect.orDie);

const runsHere = Registry.pipe(Effect.flatMap((registry) => registry.views(null)));

const listings = (forge: { readonly requests: () => ReadonlyArray<{ readonly url: string }> }) =>
  Arr.filter(forge.requests(), (one) => Str.includes("reviewer_username=mk")(one.url));

const requesting = (head: string) =>
  model(head, {
    mrs: [
      mr(head, { reviewers: ["mk"], title: "Guard the input" }),
      mr(head, { iid: "8", author: "mk", reviewers: ["mk"] }),
    ],
  });

test(
  "a GitLab review request starts one Follow-through, never for the login's own, and a round lists once",
  () =>
    host.runEffect(
      Effect.gen(function* () {
        yield* repository;
        yield* git(["remote", "add", "upstream", `https://${PROJECT}.git`]);
        const head = yield* pushed("review this");
        const forge = yield* host.gitlab(requesting(head));
        yield* configured(true);
        yield* rig.queueOutputs([review([F1])]);
        yield* host.session(
          forge,
          Effect.gen(function* () {
            yield* loaded;
            yield* host.mergeWatched;
            const [started] = yield* until(
              () => runsHere,
              (views) => views.length > 0,
            );
            const runId = started!.runId;
            yield* until(
              () => host.watchOf(runId, TARGET),
              (row) => row?.name === "follow-1",
            );
            const listed = listings(forge).length;
            yield* until(
              () => Effect.sync(() => listings(forge).length),
              (count) => count === listed + 1,
            );
            const from = forge.requests().length;
            yield* until(
              () => Effect.sync(() => listings(forge).length),
              (count) => count === listed + 2,
            );
            const round = Arr.filter(
              forge.requests().slice(from),
              (one) => !/\/merge_requests\/7(?:[/?]|$)/.test(decodeURIComponent(one.url)),
            );
            expect(Arr.map(round, (one) => one.url)).toEqual([
              expect.stringContaining(
                "/merge_requests?scope=all&state=opened&reviewer_username=mk",
              ),
            ]);
            const views = yield* runsHere;
            expect(Arr.map(views, (view) => view.runId)).toEqual([runId]);
            expect(views[0]?.input).toMatchObject({ target: `mr:${KEY}` });
            const byHand = yield* host.started(yield* entryOf("review"), "by-hand", {
              target: TARGET,
            });
            expect(byHand.runId).toBe(runId);
          }),
        );
      }),
    ),
  180_000,
);

test("an unplaced or ambiguous review request says why once and starts after it is resolved", () =>
  host.runEffect(
    Effect.gen(function* () {
      yield* repository;
      const head = yield* pushed("review this");
      const forge = yield* host.gitlab(requesting(head));
      yield* configured(true);
      yield* rig.queueOutputs([review([F1])]);
      yield* host.session(
        forge,
        Effect.gen(function* () {
          const news = yield* newsPath(host.dir(), yield* machineHerd(host.env()));
          const notices = () =>
            Effect.map(readNews(news), (lines) =>
              Arr.filter(lines, (line) => line.kind === "item"),
            );
          yield* loaded;
          yield* host.mergeWatched;
          yield* until(notices, (lines) => lines.length > 0);
          yield* until(
            () => Effect.sync(() => listings(forge).length),
            (count) => count >= 2,
          );
          expect(yield* runsHere).toEqual([]);
          const unplaced = yield* notices();
          expect(unplaced).toHaveLength(1);
          expect(unplaced[0]?.text).toContain("clone it there");

          const fork = yield* entryOf("second-look");
          yield* git(["remote", "add", "upstream", `https://${PROJECT}.git`]);
          const ambiguous = yield* until(notices, (lines) => lines.length === 2);
          expect(ambiguous[1]?.text).toContain("review, second-look");
          expect(yield* runsHere).toEqual([]);
          yield* Effect.sleep("30 seconds");
          expect(yield* notices()).toHaveLength(2);

          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(fork);
          const [started] = yield* until(
            () => runsHere,
            (views) => views.length > 0,
          );
          yield* until(
            () => host.watchOf(started!.runId, TARGET),
            (row) => row !== null,
          );
          expect(yield* runsHere).toHaveLength(1);
          expect(yield* host.agentStarts).toHaveLength(1);
        }),
      );
    }),
  ));

test("an empty review-request listing refreshes a changed login on the next round", () =>
  host.runEffect(
    Effect.gen(function* () {
      yield* repository;
      yield* configured(true);
      const head = yield* pushed("review this");
      const forge = yield* host.gitlab(model(head));
      yield* host.session(
        forge,
        Effect.gen(function* () {
          yield* host.mergeWatched;
          yield* until(
            () => Effect.sync(() => listings(forge).length),
            (count) => count > 0,
          );
          yield* forge.set(model(head, { login: "bob" }));
          yield* until(
            () => Effect.sync(() => forge.requests()),
            (requests) =>
              Arr.some(requests, (one) => Str.includes("reviewer_username=bob")(one.url)),
          ).pipe(Effect.timeout("1 minute"));
          expect(yield* runsHere).toEqual([]);
        }),
      );
    }),
  ));

test("with following off, no review request is listed and nothing starts", () =>
  host.runEffect(
    Effect.gen(function* () {
      yield* repository;
      yield* git(["remote", "add", "upstream", `https://${PROJECT}.git`]);
      const head = yield* pushed("review this");
      const forge = yield* host.gitlab(requesting(head));
      yield* configured(false);
      yield* host.session(
        forge,
        Effect.gen(function* () {
          yield* loaded;
          yield* host.mergeWatched;
          yield* Effect.sleep("1 minute");
          expect(listings(forge)).toEqual([]);
          expect(yield* runsHere).toEqual([]);
        }),
      );
    }),
  ));

test(
  "!482: a signed fixed claim without a push reassesses only its finding",
  () =>
    host.runEffect(
      Effect.gen(function* () {
        yield* repository;
        const head = yield* pushed("review this");
        const forge = yield* host.gitlab(model(head));
        yield* host.settingOn(true);
        yield* rig.queueOutputs([
          review([F1, F2]),
          { findings: [{ id: "F1", status: "open", reason: "The guard is still missing." }] },
        ]);
        yield* host.session(
          forge,
          Effect.gen(function* () {
            const { runId } = yield* host.started(yield* entryOf("review"), "reply-482", {
              target: TARGET,
            });
            yield* host.mergeWatched;
            yield* until(
              () => host.watchOf(runId, TARGET),
              (row) => row !== null,
            );
            const now = yield* forge.model();
            yield* forge.set({
              ...now,
              mrs: [
                mr(head, {
                  comments: [
                    {
                      id: 482,
                      author: "ann",
                      at: "2026-11-11T10:00:00Z",
                      body: `F1: Fixed in \`${head}\`.\n\nPosted by Collie's Run run-author on vm-author.`,
                    },
                  ],
                }),
              ],
            });
            yield* TestClock.adjust("6 minutes");
            const reassessed = yield* until(
              () => host.watchOf(runId, TARGET),
              (row) => row?.name === "follow-2",
            ).pipe(Effect.timeoutOption("3 minutes"));
            expect(Option.isSome(reassessed)).toBe(true);
            const fs = yield* FileSystem.FileSystem;
            const files = yield* fs.readDirectory(`${host.dir()}/agents/${runId}`);
            const prompts = yield* Effect.forEach(
              Arr.filter(files, (file) => Str.endsWith(".prompt.md")(file)),
              (file) => fs.readFileString(`${host.dir()}/agents/${runId}/${file}`),
            );
            const prompt = Arr.findFirst(prompts, Str.includes("Reassess these findings")).pipe(
              Option.getOrElse(() => ""),
            );
            expect(prompt).toContain("Collie-signed by run-author · @ann · 482");
            expect(prompt).toContain("- F1: open");
            expect(prompt).not.toContain("- F2: ");
            expect(yield* host.agentStarts).toHaveLength(2);
            expect(
              Arr.filter(forge.requests(), (one) => Str.endsWith("/approve")(one.url)),
            ).toHaveLength(0);
            expect(yield* notesOf(forge)).toHaveLength(1);
          }),
        );
      }),
    ),
  180_000,
);

for (const id of ["review", "second-look"])
  for (const choice of ["Keep", "Drop"])
    test(
      `${id}: a maintained dispute gets one rebuttal and ${choice} is the human's decision`,
      () =>
        host.runEffect(
          Effect.gen(function* () {
            const { first, forge, entry } = yield* begun(id, [
              review([F1]),
              {
                findings: [
                  {
                    id: "F1",
                    status: "disputed",
                    reason: "An empty input still reaches the handler.",
                  },
                ],
              },
              review([{ ...F1, status: "fixed" }]),
            ]);
            yield* host.session(
              forge,
              Effect.gen(function* () {
                const { runId } = yield* host.started(entry, "dispute", { target: TARGET });
                yield* host.mergeWatched;
                yield* until(
                  () => host.watchOf(runId, TARGET),
                  (row) => row !== null,
                );
                const dispute = {
                  id: 482,
                  author: "ann",
                  at: "2026-11-11T10:00:00Z",
                  body: "F1: I dispute this; the caller validates it.",
                };
                let now = yield* forge.model();
                yield* forge.set({ ...now, mrs: [mr(first, { comments: [dispute] })] });
                yield* TestClock.adjust("6 minutes");
                yield* until(
                  () => host.watchOf(runId, TARGET),
                  (row) => row?.name === "follow-2",
                );
                const notes = yield* notesOf(forge);
                expect(notes).toHaveLength(2);
                expect(notes[1]).toContain("An empty input still reaches the handler.");
                now = yield* forge.model();
                yield* forge.set({
                  ...now,
                  mrs: [
                    mr(first, {
                      comments: [
                        dispute,
                        {
                          ...dispute,
                          id: 483,
                          body: "F1: I still dispute it.\n\nPosted by Collie's Run run-author on vm-author.",
                        },
                      ],
                    }),
                  ],
                });
                yield* TestClock.adjust("6 minutes");
                const pending = yield* until(
                  () => asked(runId),
                  (rows) => Arr.some(rows, (one) => Str.startsWith("dispute-")(one.decision)),
                ).pipe(Effect.timeoutOption("6 minutes"));
                expect(Option.isSome(pending)).toBe(true);
                const decision = Arr.findFirst(Option.getOrThrow(pending), (one) =>
                  Str.startsWith("dispute-")(one.decision),
                ).pipe(Option.getOrThrow);
                expect(decision.prompt).toContain(`approve ${first}`);
                expect(yield* host.agentStarts).toHaveLength(2);
                expect(yield* notesOf(forge)).toHaveLength(2);
                const registry = yield* Registry;
                yield* registry.answer({
                  runId,
                  decision: decision.decision,
                  value: choice === "Drop" ? `Drop it (approve ${first})` : "Keep F1 (no approval)",
                  request: "settle-dispute",
                });
                yield* until(
                  () => host.watchOf(runId, TARGET),
                  (row) => row?.name === "follow-3",
                );
                const approvals = Arr.filter(forge.requests(), (one) =>
                  Str.endsWith("/approve")(one.url),
                );
                expect(approvals).toHaveLength(choice === "Drop" ? 1 : 0);
                if (choice === "Drop") {
                  expect(approvals[0]?.body).toEqual({ sha: first });
                  const fs = yield* FileSystem.FileSystem;
                  const recorded = yield* fs.readFileString(
                    `${host.dir()}/runs/${runId}/findings.json`,
                  );
                  expect(recorded).toContain("Dropped by the human");
                } else {
                  now = yield* forge.model();
                  yield* forge.set({
                    ...now,
                    mrs: [
                      mr(first, {
                        comments: [{ ...dispute, id: 484, body: "F1: please reconsider again" }],
                      }),
                    ],
                  });
                  yield* Effect.sleep("6 minutes");
                  expect(yield* host.agentStarts).toHaveLength(2);
                  const next = yield* pushedOn(forge, first);
                  yield* until(
                    () => host.watchOf(runId, TARGET),
                    (row) => row?.observed?.head === next,
                  );
                  yield* TestClock.adjust("6 minutes");
                  yield* until(
                    () => asked(runId),
                    (rows) =>
                      Arr.some(rows, (one) => one.prompt === `Approve mk/collie!7 at ${next}?`),
                  );
                  expect(yield* host.agentStarts).toHaveLength(3);
                }
              }),
            );
          }),
        ),
      240_000,
    );

for (const id of ["review", "second-look"])
  test(
    `${id}: a reply arriving with a new head runs one full round with both reply labels`,
    () =>
      host.runEffect(
        Effect.gen(function* () {
          const { first, forge, entry } = yield* begun(id, [review([F1, F2]), review([F1, F2])]);
          yield* host.session(
            forge,
            Effect.gen(function* () {
              const { runId } = yield* host.started(entry, "reply-and-head", { target: TARGET });
              yield* host.mergeWatched;
              yield* until(
                () => host.watchOf(runId, TARGET),
                (row) => row !== null,
              );
              const next = yield* pushed("and another change");
              const now = yield* forge.model();
              yield* forge.set({
                ...now,
                ancestry: { [next]: [first] },
                mrs: [
                  mr(next, {
                    comments: [
                      {
                        id: 482,
                        author: "ann",
                        at: "2026-11-11T10:00:00Z",
                        body: `F1: Fixed in \`${next}\`.\n\nPosted by Collie's Run run-author on vm-author.`,
                      },
                      {
                        id: 483,
                        author: "ann",
                        at: "2026-11-11T10:01:00Z",
                        body: "F2: I checked the handle manually.",
                      },
                    ],
                  }),
                ],
              });
              yield* until(
                () => host.watchOf(runId, TARGET),
                (row) => row?.observed?.head === next,
              );
              yield* TestClock.adjust("6 minutes");
              yield* until(
                () => host.watchOf(runId, TARGET),
                (row) => row?.name === "follow-2",
              );
              expect(yield* host.agentStarts).toHaveLength(2);
              const fs = yield* FileSystem.FileSystem;
              const files = yield* fs.readDirectory(`${host.dir()}/agents/${runId}`);
              const file = Arr.findFirst(
                files,
                (name) => Str.startsWith("review-2-")(name) && Str.endsWith(".prompt.md")(name),
              ).pipe(Option.getOrThrow);
              const prompt = yield* fs.readFileString(`${host.dir()}/agents/${runId}/${file}`);
              expect(prompt).toContain("Collie-signed by run-author · @ann · 482");
              expect(prompt).toContain("human-typed · @ann · 483");
              expect(prompt).toContain("I checked the handle manually.");
              expect(prompt).toContain(next);
              expect(
                Arr.filter(
                  files,
                  (name) => Str.startsWith("reassess-")(name) && Str.endsWith(".prompt.md")(name),
                ),
              ).toHaveLength(0);
              expect(
                Arr.filter(forge.requests(), (one) => Str.endsWith("/approve")(one.url)),
              ).toHaveLength(0);
            }),
          );
        }),
      ),
    180_000,
  );

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

test("pinning an upstream merge request fetches its project instead of the fork's origin", () =>
  host.runEffect(Effect.gen(function* () {
    yield* repository;
    const head = yield* pushed("upstream change");
    yield* git(["remote", "rename", "origin", "upstream"]);
    yield* git(["remote", "set-url", "upstream", `https://${PROJECT}.git`]);
    yield* git(["config", `url.${rig.root}/origin.git.insteadOf`, `https://${PROJECT}.git`]);
    yield* git(["init", "-q", "--bare", `${rig.root}/fork.git`], rig.root);
    yield* git(["remote", "add", "origin", `${rig.root}/fork.git`]);
    const forge = yield* host.gitlab(model(head));
    yield* host.session(forge, Effect.gen(function* () {
      const started = yield* host.started(follows, "upstream", { target: TARGET });
      const pinned = yield* (yield* Host).pinHead({ runId: started.runId, target: TARGET, head });
      expect(pinned).toHaveProperty("cwd");
      if (!("cwd" in pinned)) throw new Error(JSON.stringify(pinned));
      expect(Str.trim((yield* git(["rev-parse", "HEAD"], pinned.cwd)).stdout)).toBe(head);
    }));
  })), 180_000);

test("an unreadable login refuses follow-through admission instead of bypassing its claim", () =>
  host.runEffect(Effect.gen(function* () {
    const forge = yield* host.gitlab(model("head"));
    forge.after((url, _init, response) => Promise.resolve(
      Str.endsWith("/user")(url) ? new Response("unavailable", { status: 503 }) : response,
    ));
    yield* configured(true);
    yield* host.session(forge, Effect.gen(function* () {
      const started = yield* Effect.exit(host.started(follows, "login-outage", { target: TARGET }));
      expect(Exit.isFailure(started)).toBe(true);
      expect(yield* runsHere).toEqual([]);
    }));
  })), 180_000);

test("a new start after follow-through finishes reviews a reopened merge request", () =>
  host.runEffect(Effect.gen(function* () {
    const forge = yield* host.gitlab(model("head"));
    yield* configured(true);
    yield* host.session(forge, Effect.gen(function* () {
      const first = yield* host.started(follows, "first", { target: TARGET });
      yield* until(() => asked(first.runId), (rows) => rows.length > 0);
      yield* (yield* Registry).answer({runId: first.runId, decision: "approve-1", value: "Not now", request: "done"});
      yield* until(() => host.status(first.runId), (row) => row?.status.status === "complete");
      const next = yield* host.started(follows, "reopened", { target: TARGET });
      expect(next.runId).not.toBe(first.runId);
      const again = yield* host.started(follows, "duplicate", { target: TARGET, proves: "different" });
      expect(again.runId).toBe(next.runId);
      const pending = yield* until(() => asked(next.runId), (rows) => rows.length > 0);
      expect(pending[0]?.decision).toBe("approve-1");
    }));
  })), 180_000);

for (const following of [true, false])
  for (const status of [503, 429])
    test(
      `${following ? "followed" : "manual"} GitHub approval parks before submission on ${status} and recovers once`,
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
              mrs: [
                { project: "github.com/acme/app", iid: "7", state: "open", author: "ann", head },
              ],
            });
            let unavailable = false;
            let posted = false;
            const api = yield* serveForges({
              forge: "github",
              face: (url, init) => {
                if (
                  unavailable &&
                  posted &&
                  Str.endsWith("/pulls/7")(url) &&
                  init?.method === "GET"
                )
                  return Promise.resolve(Response.json({ message: "unavailable" }, { status }));
                return forge.face(url, init).then((response) => {
                  if (Str.endsWith("/comments")(url) && init?.method === "POST") posted = true;
                  return response;
                });
              },
            });
            yield* host.settingOn(following);
            yield* rig.queueOutputs([review([])]);
            yield* host.session(
              { ...forge, api },
              Effect.gen(function* () {
                const { runId } = yield* host.started(yield* entryOf("review"), "cli-1", {
                  target,
                });
                const decision = following ? "approve-1" : "post-1";
                yield* until(
                  () => asked(runId),
                  (rows) => Arr.some(rows, (row) => row.decision === decision),
                );
                unavailable = true;
                yield* (yield* Registry).answer({
                  runId,
                  decision,
                  value: following ? "Approve" : `Post and approve ${Str.slice(0, 7)(head)}`,
                  request: "approve",
                });
                const parked = yield* until(
                  () => host.status(runId),
                  (view) => view?.status.status === "failed" || view?.park != null,
                );
                expect(parked?.status.status).toBe("suspended");
                expect(parked?.park).toMatchObject({
                  cause: "forge-unavailable",
                  kind: "rechecks",
                });
                expect((yield* forge.model()).approved ?? []).toHaveLength(0);
                expect(
                  Arr.filter(
                    forge.requests(),
                    (one) => one.method === "POST" && Str.endsWith("/reviews")(one.url),
                  ),
                ).toHaveLength(0);
                unavailable = false;
                yield* host.recovering;
                yield* until(
                  () => forge.model(),
                  (now) => (now.approved ?? []).length === 1,
                );
                yield* until(
                  () =>
                    Effect.all({ view: host.status(runId), watch: host.watchOf(runId, target) }),
                  ({ view, watch }) =>
                    following ? watch?.name === "follow-1" : view?.status.status === "complete",
                );
                expect((yield* host.status(runId))?.park).toBeNull();
                expect(
                  Arr.filter(
                    forge.requests(),
                    (one) => one.method === "POST" && Str.endsWith("/reviews")(one.url),
                  ),
                ).toHaveLength(1);
                expect(yield* host.agentStarts).toHaveLength(1);
                expect(
                  Arr.filter(
                    forge.requests(),
                    (one) => one.method === "POST" && Str.endsWith("/comments")(one.url),
                  ),
                ).toHaveLength(1);
              }),
            );
          }),
        ),
      180_000,
    );

for (const { following, after, refused } of [
  { following: true, after: 503, refused: false },
  { following: false, after: 429, refused: true },
  { following: true, after: "push", refused: false },
  { following: true, after: "push", refused: true },
] as const)
  test(
    `${following ? "followed" : "manual"} GitHub approval fails after ${after} with dismissal ${refused ? "refused" : "accepted"}`,
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
            face: (url, init) =>
              runLive(
                Effect.gen(function* () {
                  if (accepted && Str.endsWith("/pulls/7")(url) && init?.method === "GET") {
                    if (after !== "push")
                      return Response.json(
                        { message: "temporarily unavailable" },
                        { status: after },
                      );
                    const now = yield* forge.model();
                    yield* forge.set({
                      ...now,
                      mrs: Arr.map(now.mrs, (one) => ({ ...one, head: Str.repeat(40)("f") })),
                    });
                  }
                  if (Str.endsWith("/dismissals")(url)) {
                    dismissed += 1;
                    if (refused) return Response.json({ message: "Forbidden" }, { status: 403 });
                  }
                  const response = yield* Effect.promise(() => forge.face(url, init));
                  if (Str.endsWith("/reviews")(url) && init?.method === "POST") accepted = true;
                  return response;
                }),
              ),
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
                value: following ? "Approve" : `Post and approve ${Str.slice(0, 7)(head)}`,
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
              expect(done?.status.status).toBe("failed");
              expect(reason).toContain(
                refused ? "approval may still be active" : "approval withdrawn",
              );
              if (refused) {
                expect(reason).toContain("review 1");
              }
              expect((yield* forge.model()).approved ?? []).toHaveLength(refused ? 1 : 0);
              expect(
                Arr.filter(
                  forge.requests(),
                  (one) => one.method === "POST" && Str.endsWith("/reviews")(one.url),
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
          forge.before(() =>
            runLive(
              Effect.gen(function* () {
                if (ended || (yield* host.agentStarts).length === 0) return;
                ended = true;
                yield* forge.set(model(head, { mrs: [mr(head, { state })] }));
              }),
            ),
          );
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
                  (file) => Str.startsWith("review-3-")(file) && Str.endsWith(".prompt.md")(file),
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
                const recovered = yield* until(
                  () => host.status(runId),
                  (view) => view?.park === null,
                );
                expect(recovered?.park).toBeNull();
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
