import { describe, expect, test } from "bun:test";
import { Clock, ConfigProvider, Deferred, Effect, Fiber, FileSystem, Schema } from "effect";
import { TestClock } from "effect/testing";
import type { MrForge } from "../src/board-model";
import { FORGES } from "../src/forge/forge";
import { forgeHttpLayer, forgeHttpTest, type ForgeHttp } from "../src/forge/http";
import { rollupChecks } from "../src/forge/github";
import { gitlab, glabExpiry, pipelineChecks } from "../src/forge/gitlab";
import type { ReviewRead } from "../src/forge/review";
import { shell, type Runner } from "../src/mr";
import { FakeBin } from "./support/bin";
import { epochMs } from "../src/time";
import { runEffect } from "./support/effect";
import { exec } from "./support/command";
import {
  FORGE_HOST,
  PROJECT,
  fakeForge,
  forgeBin,
  forgeHttpOnPath,
  forgeOnPath,
  serveForges,
  rfc822,
  CLI,
  type FakeMr,
  type ForgeModel,
} from "./support/forge";

const HEAD = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const MERGED = "35ae2cea5e5848602729dbc0e8a87ed0d9049c46";

const mr = (forge: MrForge, over: Partial<FakeMr> = {}): FakeMr => ({
  project: PROJECT[forge],
  iid: "30",
  state: "open",
  head: HEAD,
  ...over,
});

const model = (forge: MrForge, over: Partial<ForgeModel> = {}): ForgeModel => ({
  installed: true,
  loggedIn: [FORGE_HOST[forge]],
  login: "me",
  mrs: [mr(forge)],
  ...over,
});

const ref = (forge: MrForge) => ({ project: PROJECT[forge], iid: "30" });

/** A job's id as its forge gives it: GitHub's names the Actions run of merge request 30. */
const jobId = (forge: MrForge, job: number) => (forge === "github" ? `4030/${job}` : String(job));

const against = <A>(
  forge: MrForge,
  start: ForgeModel,
  read: (run: Runner) => Effect.Effect<A, never, ForgeHttp>,
) => {
  const fake = fakeForge(forge, start);
  return read(fake.run).pipe(Effect.provide(fake.layer));
};

for (const name of ["gitlab", "github"] as const) {
  const forge = FORGES[name];
  const host = FORGE_HOST[name];

  describe(`the ${name} forge`, () => {
    test("lists only issues over HTTP from a cold login", () => {
      const fake = fakeForge(
        name,
        model(name, {
          issues: [
            {
              project: PROJECT[name],
              number: 1,
              title: "Problem",
              body: "Evidence",
              state: "open",
            },
          ],
        }),
      );
      return runEffect(
        Effect.gen(function* () {
          expect(yield* forge.issues(PROJECT[name], "/w", fake.run)).toMatchObject({
            ok: true,
            issues: [{ number: 1, title: "Problem", body: "Evidence" }],
          });
          expect(fake.requests.length).toBeGreaterThan(0);
          expect(fake.calls).toEqual([...READ_ONCE[name]]);
        }).pipe(Effect.provide(fake.layer)),
      );
    });

    test("files an issue over HTTP from a cold login", () => {
      const fake = fakeForge(name, model(name));
      return runEffect(
        Effect.gen(function* () {
          const filed = yield* forge.fileIssue(
            PROJECT[name],
            "Problem",
            "Evidence",
            "/w",
            fake.run,
          );
          expect(filed).toEqual({
            ok: true,
            number: 1,
            url: `https://${PROJECT[name]}/${name === "gitlab" ? "-/issues" : "issues"}/1`,
          });
          expect(fake.model().issues).toMatchObject([{ title: "Problem", body: "Evidence" }]);
          expect(fake.requests.filter((one) => one.method === "POST")).toHaveLength(1);
          expect(fake.calls).toEqual([...READ_ONCE[name]]);
        }).pipe(Effect.provide(fake.layer)),
      );
    });

    for (const [failure, fault] of [
      ["5xx", { status: 503 }],
      ["network", "network"],
    ] as const)
      test(`sends issue creation only once on a ${failure} failure and asks for inspection`, () => {
        const fake = fakeForge(name, model(name, { httpFault: fault }));
        return runEffect(
          Effect.gen(function* () {
            const filed = yield* forge.fileIssue(
              PROJECT[name],
              "Problem",
              "Evidence",
              "/w",
              fake.run,
            );
            expect(filed.ok).toBe(false);
            if (filed.ok) throw new Error("issue creation should be unavailable");
            expect(filed.reason).toContain("before retrying");
            expect(fake.requests.filter((one) => one.method === "POST")).toHaveLength(1);
          }).pipe(Effect.provide(fake.layer)),
        );
      });

    test("comments on an issue over HTTP from a cold login", () => {
      const fake = fakeForge(
        name,
        model(name, {
          issues: [
            {
              project: PROJECT[name],
              number: 1,
              title: "Problem",
              body: "Evidence",
              state: "open",
            },
          ],
        }),
      );
      return runEffect(
        Effect.gen(function* () {
          expect(
            yield* forge.commentIssue(PROJECT[name], 1, "More evidence", "/w", fake.run),
          ).toEqual({ ok: true, reason: "" });
          expect(fake.model().issueNotes).toEqual({ [`${PROJECT[name]}#1`]: ["More evidence"] });
          expect(fake.requests.filter((one) => one.method === "POST")).toHaveLength(1);
          expect(fake.calls).toEqual([...READ_ONCE[name]]);
        }).pipe(Effect.provide(fake.layer)),
      );
    });

    test("lists open issues, files one, and comments on it", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(
            name,
            model(name, {
              issues: [
                {
                  project: PROJECT[name],
                  number: 1,
                  title: "Open",
                  body: "Evidence",
                  state: "open",
                },
                {
                  project: PROJECT[name],
                  number: 2,
                  title: "Closed",
                  body: "Old",
                  state: "closed",
                },
              ],
            }),
          );
          const first = yield* forge
            .issues(PROJECT[name], "/w", fake.run)
            .pipe(Effect.provide(fake.layer));
          expect(first).toMatchObject({
            ok: true,
            issues: [{ number: 1, title: "Open", body: "Evidence" }],
          });
          const filed = yield* forge
            .fileIssue(PROJECT[name], "Problem", "Details", "/w", fake.run)
            .pipe(Effect.provide(fake.layer));
          expect(filed).toMatchObject({ ok: true, number: 3 });
          if (!filed.ok) throw new Error(filed.reason);
          expect(filed.url).toBe(
            `https://${PROJECT[name]}/${name === "gitlab" ? "-/issues" : "issues"}/3`,
          );
          expect(
            yield* forge
              .commentIssue(PROJECT[name], 3, "More evidence", "/w", fake.run)
              .pipe(Effect.provide(fake.layer)),
          ).toEqual({ ok: true, reason: "" });
          expect(fake.model().issueNotes).toEqual({ [`${PROJECT[name]}#3`]: ["More evidence"] });
          expect(
            yield* forge.issues(PROJECT[name], "/w", fake.run).pipe(Effect.provide(fake.layer)),
          ).toMatchObject({
            ok: true,
            issues: [{ number: 1 }, { number: 3, title: "Problem", body: "Details" }],
          });
        }),
      ));

    test("lists open issues beyond the first page", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(
            name,
            model(name, {
              issues: Array.from({ length: 103 }, (_, index) => ({
                project: PROJECT[name],
                number: index + 1,
                title: "Open",
                body: "Evidence",
                state: "open",
              })),
            }),
          );
          const listed = yield* forge
            .issues(PROJECT[name], "/w", fake.run)
            .pipe(Effect.provide(fake.layer));
          expect(listed.ok).toBe(true);
          if (!listed.ok) throw new Error(listed.reason);
          expect(listed.issues).toHaveLength(103);
          expect(listed.issues.at(-1)?.number).toBe(103);
        }),
      ));

    test("refuses issue operations when the CLI fails or returns an unreadable answer", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(name, model(name, { installed: false }));
          expect(
            (yield* forge.issues(PROJECT[name], "/w", fake.run).pipe(Effect.provide(fake.layer)))
              .ok,
          ).toBe(false);
          expect(
            (yield* forge
              .fileIssue(PROJECT[name], "Problem", "Evidence", "/w", fake.run)
              .pipe(Effect.provide(fake.layer))).ok,
          ).toBe(false);
          expect(
            (yield* forge
              .commentIssue(PROJECT[name], 1, "Evidence", "/w", fake.run)
              .pipe(Effect.provide(fake.layer))).ok,
          ).toBe(false);
          const broken = fakeForge(name, model(name));
          const malformed = forgeHttpTest(broken.run, () =>
            Promise.resolve(new Response("unreadable")),
          );
          expect(
            (yield* forge.issues(PROJECT[name], "/w", broken.run).pipe(Effect.provide(malformed)))
              .ok,
          ).toBe(false);
          expect(
            (yield* forge
              .fileIssue(PROJECT[name], "Problem", "Evidence", "/w", broken.run)
              .pipe(Effect.provide(malformed))).ok,
          ).toBe(false);
        }),
      ));

    test("is ready only with its CLI installed and logged in to the host", () =>
      runEffect(
        Effect.gen(function* () {
          const ask = (over: Partial<ForgeModel>) =>
            forge.ready(PROJECT[name], "/w", fakeForge(name, model(name, over)).run);
          expect(yield* ask({})).toEqual({ ok: true, reason: "" });
          expect(yield* ask({ installed: false })).toEqual({
            ok: false,
            reason: `${CLI[name]} is not installed`,
          });
          expect(yield* ask({ loggedIn: [] })).toEqual({
            ok: false,
            reason: `${CLI[name]} is not logged in to ${host}`,
          });
        }),
      ));

    test("reads the login over HTTP from a cold login", () => {
      const fake = fakeForge(name, model(name));
      return runEffect(
        Effect.gen(function* () {
          expect(yield* forge.login("/w", fake.run, PROJECT[name])).toBe("me");
          expect(fake.requests).toHaveLength(1);
          expect(fake.calls).toEqual([...READ_ONCE[name]]);
        }).pipe(Effect.provide(fake.layer)),
      );
    });

    test("says who its CLI is logged in as, and null where it will not", () =>
      runEffect(
        Effect.gen(function* () {
          expect(
            yield* against(name, model(name), (run) => forge.login("/w", run, PROJECT[name])),
          ).toBe("me");
          expect(
            yield* against(name, model(name, { login: null }), (run) =>
              forge.login("/w", run, PROJECT[name]),
            ),
          ).toBe(null);
        }),
      ));

    test("reads a merge request open, merged or closed, with its head, merge commit and merge time", () =>
      runEffect(
        Effect.gen(function* () {
          const read = (over: Partial<FakeMr>) =>
            against(name, model(name, { mrs: [mr(name, over)] }), (run) =>
              forge.details(ref(name), "/w", run),
            );
          const open = yield* read({});
          expect(open).toMatchObject({
            _tag: "Details",
            iid: "30",
            project: PROJECT[name],
            state: name === "gitlab" ? "opened" : "open",
            head: HEAD,
            headSha: "1a2b3c4",
            mergedSha: "",
          });
          expect(
            yield* read({ state: "merged", mergedSha: MERGED, mergedAt: "2026-10-15T08:00:00Z" }),
          ).toMatchObject({
            state: "merged",
            mergedSha: MERGED,
            mergedAt: "2026-10-15T08:00:00Z",
          });
          expect(yield* read({ state: "closed" })).toMatchObject({ state: "closed" });
          expect(yield* read({ state: "closed", draft: true })).toMatchObject({ state: "closed" });
          expect(yield* read({ state: "merged", draft: true, mergedSha: MERGED })).toMatchObject({
            state: "merged",
            mergedSha: MERGED,
          });
        }),
      ));

    test("says whether it would merge it now, by its own rules and in its own words", () =>
      runEffect(
        Effect.gen(function* () {
          const mergeable = (over: Partial<FakeMr>) =>
            against(name, model(name, { mrs: [mr(name, over)] }), (run) =>
              forge.details(ref(name), "/w", run),
            ).pipe(Effect.map((panel) => (panel._tag === "Details" ? panel.mergeable : null)));
          expect(yield* mergeable({})).toEqual({ state: "mergeable", said: "mergeable" });
          expect((yield* mergeable({ mergeable: "conflict" }))?.state).toBe("blocked");
          expect((yield* mergeable({ mergeable: "unapproved" }))?.state).toBe("blocked");
          expect((yield* mergeable({ mergeable: "checking" }))?.state).toBe("unknown");
          expect((yield* mergeable({ mergeable: "conflict" }))?.said).toBe(
            name === "gitlab" ? "conflict" : "conflicting",
          );
          expect((yield* mergeable({ mergeable: "unapproved" }))?.said).toBe(
            name === "gitlab" ? "not approved" : "blocked",
          );
        }),
      ));

    test("reads the whole panel: draft, people, branches, approval, auto-merge and when it moved", () =>
      runEffect(
        Effect.gen(function* () {
          const read = (over: Partial<FakeMr>) =>
            against(name, model(name, { mrs: [mr(name, over)] }), (run) =>
              forge.details(ref(name), "/w", run),
            );
          expect(
            yield* read({
              title: "Cards",
              author: "ann",
              assignees: ["me"],
              sourceBranch: "me/cards",
              targetBranch: "main",
              approved: true,
              autoMerge: true,
              updatedAt: "2026-10-01T12:00:00Z",
            }),
          ).toMatchObject({
            title: "Cards",
            author: "ann",
            assignees: ["me"],
            sourceBranch: "me/cards",
            targetBranch: "main",
            approvals: "approved",
            autoMerge: true,
            updatedAt: epochMs("2026-10-01T12:00:00Z"),
          });
          expect(yield* read({ draft: true })).toMatchObject({ state: "draft", autoMerge: false });
        }),
      ));

    test("says whether the reviewed branch comes from a fork", () =>
      runEffect(
        Effect.gen(function* () {
          for (const fork of [false, true])
            expect(
              yield* against(name, model(name, { mrs: [mr(name, { fork })] }), (run) =>
                forge.details(ref(name), "/w", run),
              ),
            ).toMatchObject({ fork });
        }),
      ));

    test("reads its checks passed, failed or running", () =>
      runEffect(
        Effect.gen(function* () {
          const checksOf = (checks: FakeMr["checks"]) =>
            Effect.map(
              against(name, model(name, { mrs: [mr(name, { checks })] }), (run) =>
                forge.details(ref(name), "/w", run),
              ),
              (panel) => (panel._tag === "Details" ? panel.checks : undefined),
            );
          expect(yield* checksOf([{ name: "test", state: "passed" }])).toEqual({ state: "passed" });
          expect(
            yield* checksOf([
              { name: "test", state: "passed" },
              { name: "lint", state: "failed" },
            ]),
          ).toEqual({ state: "failed", name: name === "gitlab" ? "pipeline" : "lint" });
          expect(yield* checksOf([{ name: "e2e", state: "running" }])).toEqual({
            state: "running",
          });
          expect(yield* checksOf([])).toEqual({ state: "none" });
        }),
      ));

    test("keeps the check address its forge supplied", () =>
      runEffect(
        Effect.gen(function* () {
          const url = `https://${host}/checks/42`;
          const panel = yield* against(
            name,
            model(name, {
              mrs: [mr(name, { checks: [{ name: "test", state: "failed" }], checksUrl: url })],
            }),
            (run) => forge.details(ref(name), "/w", run),
          );
          expect(panel).toMatchObject({ _tag: "Details", checks: { state: "failed", url } });
        }),
      ));

    test("says why a merge request it cannot read is unavailable", () =>
      runEffect(
        Effect.gen(function* () {
          const gone = yield* against(name, model(name), (run) =>
            forge.details({ project: PROJECT[name], iid: "99" }, "/w", run),
          );
          expect(gone._tag).toBe("Unavailable");
        }),
      ));

    for (const approve of [false, true])
      test(`posts one review note over HTTP from a cold login, approval ${approve}`, () => {
        const fake = fakeForge(name, model(name));
        return runEffect(
          Effect.gen(function* () {
            const posted = yield* forge.post(ref(name), "Clean", approve, "/w", fake.run);
            expect(posted.ok).toBe(true);
            expect(Object.values(fake.model().notes ?? {})).toEqual([["Clean"]]);
            expect(fake.model().approved ?? []).toHaveLength(approve ? 1 : 0);
            expect(fake.requests.filter((one) => one.method === "POST")).toHaveLength(
              approve ? 2 : 1,
            );
            expect(fake.calls).toEqual([...READ_ONCE[name]]);
          }).pipe(Effect.provide(fake.layer)),
        );
      });

    for (const [failure, fault] of [
      ["5xx", { status: 503 }],
      ["network", "network"],
    ] as const)
      test(`keeps the posted note when approval has a ${failure} failure, without sending it again`, () => {
        const fake = fakeForge(name, model(name));
        const layer = forgeHttpTest(fake.run, (url, init) => {
          if (url.endsWith(name === "github" ? "/reviews" : "/approve"))
            fake.set({ ...fake.model(), httpFault: fault });
          return fake.fetch(url, init);
        });
        return runEffect(
          Effect.gen(function* () {
            const posted = yield* forge.post(ref(name), "Clean", true, "/w", fake.run);
            expect(posted.ok).toBe(true);
            expect(posted.message).toContain("and did not approve it");
            expect(posted.message).toContain("before approving again");
            expect(Object.values(fake.model().notes ?? {})).toEqual([["Clean"]]);
            expect(fake.model().approved ?? []).toEqual([]);
            expect(fake.requests.filter((one) => one.method === "POST")).toHaveLength(2);
          }).pipe(Effect.provide(layer)),
        );
      });

    test("posts one note, and approves only where asked, saying what landed", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(name, model(name));
          const noted = yield* forge
            .post(ref(name), "LGTM", false, "/w", fake.run)
            .pipe(Effect.provide(fake.layer));
          expect(noted.ok).toBe(true);
          expect(noted.message).not.toContain("approved");
          expect(fake.model().approved ?? []).toEqual([]);
          const approved = yield* forge
            .post(ref(name), "Clean", true, "/w", fake.run)
            .pipe(Effect.provide(fake.layer));
          expect(approved.message).toContain("and approved it");
          expect(Object.values(fake.model().notes ?? {})).toEqual([["LGTM", "Clean"]]);
          expect(fake.model().approved?.length).toBe(1);
          const missed = yield* forge
            .post({ project: PROJECT[name], iid: "99" }, "LGTM", false, "/w", fake.run)
            .pipe(Effect.provide(fake.layer));
          expect(missed.ok).toBe(false);
        }),
      ));

    test("reports an approval the forge refuses, with the note still posted", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(name, model(name, { refusesApproval: true }));
          const posted = yield* forge
            .post(ref(name), "Clean", true, "/w", fake.run)
            .pipe(Effect.provide(fake.layer));
          expect(posted.ok).toBe(true);
          expect(posted.message).toContain("and did not approve it");
          expect(Object.values(fake.model().notes ?? {})).toEqual([["Clean"]]);
        }),
      ));

    test("lists my merge requests over HTTP from a cold login", () => {
      const fake = fakeForge(
        name,
        model(name, {
          mrs: [
            mr(name, { assignees: ["me"], author: "me", title: "Mine" }),
            mr(name, { iid: "31", author: "ann" }),
          ],
        }),
      );
      return runEffect(
        Effect.gen(function* () {
          expect(yield* forge.mine(PROJECT[name], "/w", fake.run)).toEqual([
            { iid: "30", title: "Mine" },
          ]);
          expect(fake.requests.length).toBeGreaterThan(1);
          expect(fake.calls).toEqual([...READ_ONCE[name]]);
        }).pipe(Effect.provide(fake.layer)),
      );
    });

    test("lists my open merge requests, as assignee or author, once each", () =>
      runEffect(
        Effect.gen(function* () {
          const mrs = [
            mr(name, { iid: "31", assignees: ["me"], title: "Mine" }),
            mr(name, { iid: "32", author: "me", assignees: ["me"], title: "Both" }),
            mr(name, { iid: "33", author: "ann" }),
            mr(name, { iid: "34", author: "me", state: "merged" }),
          ];
          expect(
            yield* against(name, model(name, { mrs }), (run) =>
              forge.mine(PROJECT[name], "/w", run),
            ),
          ).toEqual([
            { iid: "31", title: "Mine" },
            { iid: "32", title: "Both" },
          ]);
        }),
      ));

    test("opens one in a browser", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(name, model(name));
          expect((yield* forge.open(ref(name), "/w", fake.run)).code).toBe(0);
          expect(fake.calls.at(-1)).toContain("--web");
        }),
      ));

    test("writes the commands a reviewer reads and checks one out with, for its own CLI", () => {
      const said = forge.review(ref(name));
      for (const line of [said.diff, said.view, said.checkout]) {
        expect(line.startsWith(`${CLI[name]} `)).toBe(true);
        expect(line).toContain("30");
      }
    });

    test("keeps shell characters in delivery arguments literal", () =>
      runEffect(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "forge-delivery-" });
          const bin = yield* FakeBin.make(`${cwd}/bin`);
          try {
            yield* bin.add(CLI[name], `printf '%s\\n' "$@"`);
            yield* fs.writeFileString(`${cwd}/body.txt`, "description");
            const branch = `feature/${SHELL_WORD}`;
            const assignee = `account${SHELL_WORD}`;
            const existing = `https://${PROJECT[name]}/30?query=${SHELL_WORD}`;
            const commands = forge.commands({ project: PROJECT[name], branch, assignee, existing });
            const lines = commands.create.split("\n");
            const created = yield* shell(
              "sh",
              [
                "-c",
                lines[0]!
                  .replaceAll("<title>", "Change")
                  .replace("<file>", "body.txt")
                  .replace("<iid>", "7"),
              ],
              cwd,
            );
            expect(created.code).toBe(0);
            const args = created.stdout.trimEnd().split("\n");
            expect(args[args.indexOf("--assignee") + 1]).toBe(assignee);
            if (name === "github") {
              expect(lines).toHaveLength(1);
              expect(args[args.indexOf("--head") + 1]).toBe(branch);
              expect(args[args.indexOf("--body-file") + 1]).toBe("body.txt");
            } else {
              const described = yield* shell(
                "sh",
                ["-c", lines[1]!.replace("<file>", "body.txt").replace("<iid>", "7")],
                cwd,
              );
              expect(described.stdout.trimEnd().split("\n")).toEqual([
                "api",
                "--hostname",
                "gitlab.example.com",
                "--method",
                "PUT",
                "projects/group%2Fapp/merge_requests/7",
                "-F",
                "description=@body.txt",
              ]);
            }
            const noted = yield* shell(
              "sh",
              ["-c", commands.comment.replace("<file>", "body.txt")],
              cwd,
            );
            expect(noted.code).toBe(0);
            const said = noted.stdout.trimEnd().split("\n");
            if (name === "github") expect(said[2]).toBe(existing);
            else
              expect(said.slice(-3)).toEqual([
                `projects/group%2Fapp/merge_requests/${existing}/notes`,
                "-F",
                "body=@body.txt",
              ]);
          } finally {
            yield* bin.restore();
          }
        }),
      ));

    test("writes its delivery commands without command substitution", () => {
      const commands = forge.commands({
        project: PROJECT[name],
        branch: "feature/one",
        assignee: "tester",
        existing: "31",
      });
      for (const line of [commands.create, commands.comment]) {
        expect(line).not.toContain("$(");
        expect(line).not.toContain("`");
        expect(line.startsWith(`${CLI[name]} `)).toBe(true);
      }
    });

    test("keeps shell characters in a review target literal", () =>
      runEffect(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "forge-review-" });
          const bin = yield* FakeBin.make(`${cwd}/bin`);
          try {
            yield* bin.add(CLI[name], `printf '%s\\n' "$@"`);
            const commands = forge.review({
              project: `${PROJECT[name]}${SHELL_WORD}`,
              iid: "30",
            });
            for (const line of [commands.diff, commands.view, commands.checkout]) {
              const result = yield* shell("sh", ["-c", line], cwd);
              expect(result.code).toBe(0);
              const args = result.stdout.trimEnd().split("\n");
              expect(args[args.indexOf("--repo") + 1]).toBe(
                name === "github"
                  ? `owner/repo${SHELL_WORD}`
                  : `gitlab.example.com/group/app${SHELL_WORD}`,
              );
            }
          } finally {
            yield* bin.restore();
          }
        }),
      ));
  });
}

// Shell metacharacters without the injection shapes endpoint security flags (SEC-148).
const SHELL_WORD = `'x;y $HOME *`;

const URLS = {
  gitlab: {
    run: "https://gitlab.example.com/group/app/-/pipelines/7",
    other: "https://github.com/owner/repo/actions/runs/7",
  },
  github: {
    run: "https://github.com/owner/repo/actions/runs/7",
    other: "https://gitlab.example.com/group/app/-/pipelines/7",
  },
} as const;

/** A job of pipeline or Actions run 7, as each forge links it. */
const JOB_URL = {
  gitlab: (id: number) => `https://gitlab.example.com/group/app/-/jobs/${id}`,
  github: (id: number) => `https://github.com/owner/repo/actions/runs/7/job/${id}`,
} as const;

for (const name of ["gitlab", "github"] as const) {
  const forge = FORGES[name];

  describe(`the ${name} forge's deploys`, () => {
    const tierOf = (over: Partial<ForgeModel>) =>
      against(name, model(name, over), (run) => forge.liveTier(ref(name), MERGED, "/w", run));
    const environments = (stage: string, prod: string, failed = "") => [
      { name: "stage", tier: "staging", deployed: stage },
      { name: "production", tier: "production", deployed: prod, failed },
    ];
    const ancestry = { child: [MERGED] };

    test("say production, then stage, then nothing, and nothing where the forge does not answer", () =>
      runEffect(
        Effect.gen(function* () {
          expect(yield* tierOf({ environments: environments("child", MERGED), ancestry })).toBe(
            "production",
          );
          expect(yield* tierOf({ environments: environments("child", "0ld"), ancestry })).toBe(
            "staging",
          );
          expect(yield* tierOf({ environments: environments("0ld", "0ld"), ancestry })).toBe(null);
          expect(yield* tierOf({ environments: [] })).toBe(null);
          expect(
            yield* tierOf({ environments: environments(MERGED, MERGED), deploysDown: true }),
          ).toBe(null);
        }),
      ));

    test("go by what is live, not by a newer deployment that failed", () =>
      runEffect(
        Effect.gen(function* () {
          expect(
            yield* tierOf({ environments: environments("0ld", "0ld", MERGED), ancestry }),
          ).toBe(null);
        }),
      ));

    test("name the commit a tier's newest successful deployment has, none, and why not where the forge does not answer", () =>
      runEffect(
        Effect.gen(function* () {
          const deployed = (tier: "staging" | "production", over: Partial<ForgeModel>) =>
            against(name, model(name, over), (run) => forge.deployed(ref(name), tier, "/w", run));
          const both = { environments: environments("child", "0ld", MERGED) };
          expect(yield* deployed("staging", both)).toEqual({ ok: true, sha: "child" });
          expect(yield* deployed("production", both)).toEqual({ ok: true, sha: "0ld" });
          expect(yield* deployed("staging", { environments: [] })).toEqual({ ok: true, sha: null });
          expect((yield* deployed("staging", { ...both, deploysDown: true })).ok).toBe(false);
        }),
      ));
  });

  describe(`the ${name} forge's stage per environment`, () => {
    test("reads stage environments over HTTP with only the CLI login", () => {
      const fake = fakeForge(
        name,
        model(name, {
          environments: [
            { name: "stage-web", tier: "staging", deployments: [{ sha: HEAD, status: "success" }] },
          ],
        }),
      );
      return runEffect(
        Effect.gen(function* () {
          expect(yield* forge.stagingEnvironments(ref(name), HEAD, "/w", fake.run)).toEqual({
            ok: true,
            environments: [{ name: "stage-web", live: HEAD, hasCommit: true }],
          });
          expect(fake.requests.length).toBeGreaterThan(0);
          expect(fake.calls).toEqual([...READ_ONCE[name]]);
        }).pipe(Effect.provide(fake.layer)),
      );
    });

    const read = (
      commit: string | null,
      environments: ForgeModel["environments"],
      over: Partial<ForgeModel> = {},
    ) =>
      against(name, model(name, { environments, ...over }), (run) =>
        forge.stagingEnvironments(ref(name), commit, "/w", run),
      );
    const success = (sha: string) => ({ sha, status: "success" as const });
    const failed = (sha: string) => ({ sha, status: "failed" as const });

    test("attribution: only selected jobs' deployments count, including a selected job's earlier attempt", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(
            name,
            model(name, {
              mrs: [
                mr(name, {
                  jobs: [
                    { name: "stage:playground", state: "passed", id: 23 },
                    { name: "stage:playground", state: "failed", id: 17 },
                    { name: "stage:spilnu", state: "passed", id: 9 },
                  ],
                }),
              ],
              environments: [
                {
                  name: "stage-playground",
                  tier: "staging",
                  deployments: [
                    { sha: HEAD, status: "success", job: "stage:playground", jobId: 17 },
                  ],
                },
                {
                  name: "stage-spilnu",
                  tier: "staging",
                  deployments: [{ sha: HEAD, status: "success", job: "stage:spilnu", jobId: 9 }],
                },
                {
                  name: "stage-manual",
                  tier: "staging",
                  deployments: [{ sha: HEAD, status: "success", logUrl: "" }],
                },
                {
                  name: "stage-bot",
                  tier: "staging",
                  deployments: [
                    { sha: HEAD, status: "success", logUrl: "https://bot.example/log/17" },
                  ],
                },
              ],
            }),
          );
          const read = yield* forge
            .stagingEnvironments(ref(name), HEAD, "/w", fake.run, ["stage:playground"])
            .pipe(Effect.provide(fake.layer));
          expect(read).toEqual({
            ok: true,
            environments: [
              { name: "stage-playground", live: HEAD, hasCommit: true },
              { name: "stage-spilnu", live: HEAD, hasCommit: false },
              { name: "stage-manual", live: HEAD, hasCommit: false },
              { name: "stage-bot", live: HEAD, hasCommit: false },
            ],
          });
        }),
      ));

    test("per environment: each stage environment's newest successful deployment is read, even where another's is newer", () =>
      runEffect(
        Effect.gen(function* () {
          expect(
            yield* read(null, [
              { name: "stage-spilnu", tier: "staging", deployments: [success("newer")] },
              { name: "production", tier: "production", deployments: [success("prod")] },
              { name: "stage-happytiger", tier: "staging", deployments: [success("older")] },
              { name: "review-7", tier: "development", deployments: [success("preview")] },
            ]),
          ).toEqual({
            ok: true,
            environments: [
              { name: "stage-spilnu", live: "newer", hasCommit: false },
              { name: "stage-happytiger", live: "older", hasCommit: false },
            ],
          });
        }),
      ));

    test("per environment: a newer failed deployment is not what is live, and none at all is null", () =>
      runEffect(
        Effect.gen(function* () {
          expect(
            yield* read(null, [
              {
                name: "stage-spilnu",
                tier: "staging",
                deployments: [failed("broken"), success("good")],
              },
              { name: "stage-happytiger", tier: "staging", deployments: [failed("broken")] },
            ]),
          ).toEqual({
            ok: true,
            environments: [
              { name: "stage-spilnu", live: "good", hasCommit: false },
              { name: "stage-happytiger", live: null, hasCommit: false },
            ],
          });
        }),
      ));

    test("per environment: the environments with a deployment of a commit, whatever its status, are listed", () =>
      runEffect(
        Effect.gen(function* () {
          const read1 = yield* read(HEAD, [
            {
              name: "stage-spilnu",
              tier: "staging",
              deployments: [success("other"), failed(HEAD), success("older")],
            },
            { name: "stage-happytiger", tier: "staging", deployments: [success("older")] },
            { name: "stage-web", tier: "staging", deployments: [success(HEAD)] },
          ]);
          expect(read1).toEqual({
            ok: true,
            environments: [
              { name: "stage-spilnu", live: "other", hasCommit: true },
              { name: "stage-happytiger", live: "older", hasCommit: false },
              { name: "stage-web", live: HEAD, hasCommit: true },
            ],
          });
        }),
      ));

    test("per environment: a read the forge does not answer is a refusal naming the project, not none", () =>
      runEffect(
        Effect.gen(function* () {
          const refused = yield* read(
            HEAD,
            [{ name: "stage-spilnu", tier: "staging", deployments: [success(HEAD)] }],
            { deploysDown: true },
          );
          expect(refused.ok).toBe(false);
          expect(refused.ok ? "" : refused.reason).toContain(PROJECT[name]);
        }),
      ));
  });

  test(`the ${name} forge says how its own pipeline or Actions run went, and nothing of the other's`, () =>
    runEffect(
      Effect.gen(function* () {
        const status = (url: string, runs: ForgeModel["runs"]) => {
          const fake = fakeForge(name, model(name, { runs }));
          return forge.runStatus(url, "/w", fake.run).pipe(Effect.provide(fake.layer));
        };
        expect(
          yield* status(URLS[name].run, { "7": { status: "completed", conclusion: "success" } }),
        ).toBe(name === "gitlab" ? "completed" : "success");
        expect(yield* status(URLS[name].run, { "7": { status: "running" } })).toBe("running");
        expect(yield* status(URLS[name].other, { "7": { status: "running" } })).toBe(null);
        expect(yield* status(URLS[name].run, {})).toBe(null);
      }),
    ));

  test(`the ${name} forge reads its own pipeline's jobs by name with their pages, a job waiting to be started by hand among them`, () =>
    runEffect(
      Effect.gen(function* () {
        const read = (url: string, runs: ForgeModel["runs"]) =>
          against(name, model(name, { runs }), (run) => forge.pipeline(url, "/w", run));
        const done = { status: "completed", conclusion: "success" };
        expect(
          yield* read(URLS[name].run, {
            "7": {
              ...(name === "gitlab" ? { status: "success" } : done),
              ref: "v1.2.0",
              sha: MERGED,
              jobs: [
                { name: "build", state: "passed" },
                { name: "publish", state: "manual" },
              ],
            },
          }),
        ).toEqual({
          ok: true,
          succeeded: true,
          project: PROJECT[name],
          ref: "v1.2.0",
          sha: MERGED,
          jobs: [
            { name: "build", state: "passed", url: JOB_URL[name](1) },
            { name: "publish", state: "manual", url: JOB_URL[name](2) },
          ],
        });
        const running = yield* read(URLS[name].run, {
          "7": {
            status: name === "gitlab" ? "running" : "in_progress",
            ref: "main",
            sha: "0ld",
            jobs: [],
          },
        });
        expect(running).toEqual({
          ok: true,
          succeeded: false,
          project: PROJECT[name],
          ref: "main",
          sha: "0ld",
          jobs: [],
        });
        expect((yield* read(URLS[name].other, { "7": done })).ok).toBe(false);
        expect((yield* read(URLS[name].run, {})).ok).toBe(false);
      }),
    ));

  test(`the ${name} forge reads pipeline over HTTP from a cold login`, () => {
    const fake = fakeForge(
      name,
      model(name, {
        runs: {
          "7": {
            status: name === "gitlab" ? "success" : "completed",
            conclusion: "success",
            ref: "v1.2.0",
            sha: MERGED,
            jobs: [{ name: "publish", state: "manual" }],
          },
        },
      }),
    );
    return runEffect(
      Effect.gen(function* () {
        expect(yield* forge.pipeline(URLS[name].run, "/w", fake.run)).toEqual({
          ok: true,
          succeeded: true,
          project: PROJECT[name],
          ref: "v1.2.0",
          sha: MERGED,
          jobs: [{ name: "publish", state: "manual", url: JOB_URL[name](1) }],
        });
        expect(fake.requests.length).toBeGreaterThan(0);
        expect(fake.calls).toEqual(
          READ_ONCE[name].map((command) =>
            name === "gitlab"
              ? `env -u GITLAB_TOKEN -u GITLAB_ACCESS_TOKEN -u OAUTH_TOKEN ${command}`
              : command,
          ),
        );
      }).pipe(Effect.provide(fake.layer)),
    );
  });
}

test("GitLab pipeline reads refuse an unknown host's environment token without a request", () => {
  const fake = fakeForge("gitlab", model("gitlab", { envToken: "environment-only" }));
  return runEffect(
    Effect.gen(function* () {
      expect(
        (yield* fake.run("glab", ["config", "get", "token", "--host", "elsewhere.example"], "/w"))
          .stdout,
      ).toBe("environment-only\n");
      fake.calls.length = 0;
      expect(
        yield* gitlab.pipeline("https://elsewhere.example/group/app/-/pipelines/7", "/w", fake.run),
      ).toEqual({
        ok: false,
        reason: "glab is not logged in to elsewhere.example",
      });
      expect(fake.requests).toEqual([]);
      expect(fake.calls).toEqual([
        "env -u GITLAB_TOKEN -u GITLAB_ACCESS_TOKEN -u OAUTH_TOKEN glab config get oauth2_expiry_date --host elsewhere.example",
        "env -u GITLAB_TOKEN -u GITLAB_ACCESS_TOKEN -u OAUTH_TOKEN glab config get token --host elsewhere.example",
      ]);
    }).pipe(Effect.provide(fake.layer)),
  );
});

test("GitHub finds production beyond a full page of newer deployments over HTTP", () => {
  const fake = fakeForge(
    "github",
    model("github", {
      environments: [
        ...Array.from({ length: 100 }, (_, at) => ({
          name: `preview-${at}`,
          tier: "development",
          deployed: "preview",
        })),
        { name: "production", tier: "production", deployed: MERGED },
      ],
    }),
  );
  return runEffect(
    Effect.gen(function* () {
      expect(yield* FORGES.github.liveTier(ref("github"), MERGED, "/w", fake.run)).toBe(
        "production",
      );
      expect(fake.requests.some((request) => request.url.includes("page=2"))).toBe(true);
      expect(fake.calls).toEqual([...READ_ONCE.github]);
    }).pipe(Effect.provide(fake.layer)),
  );
});

for (const name of ["gitlab", "github"] as const) {
  test(`the ${name} forge reads tagPipeline over HTTP from a cold login`, () => {
    const fake = fakeForge(
      name,
      model(name, {
        runs: {
          "7": { status: "success", ref: "v1.2.0", sha: MERGED },
          "8": { status: "running", ref: "main", sha: HEAD },
        },
      }),
    );
    return runEffect(
      Effect.gen(function* () {
        expect(yield* FORGES[name].tagPipeline(ref(name), "v1.2.0", "/w", fake.run)).toEqual({
          ok: true,
          url: URLS[name].run,
        });
        expect(fake.requests.length).toBeGreaterThan(0);
        expect(fake.calls).toEqual([...READ_ONCE[name]]);
      }).pipe(Effect.provide(fake.layer)),
    );
  });

  test(`the ${name} forge finds the newest pipeline a tag started in the project, and none where it started none`, () =>
    runEffect(
      Effect.gen(function* () {
        const runs: ForgeModel["runs"] = {
          "7": { status: "success", ref: "v1.2.0", sha: MERGED },
          "8": { status: "success", ref: "main", sha: MERGED },
          "9": { status: "failed", ref: "v1.2.0", sha: MERGED },
        };
        const fake = fakeForge(name, model(name, { runs }));
        const found = (tag: string) =>
          FORGES[name].tagPipeline(ref(name), tag, "/w", fake.run).pipe(Effect.provide(fake.layer));
        expect(yield* found("v1.2.0")).toEqual({
          ok: true,
          url: URLS[name].run.replace(/7$/, "9"),
        });
        expect(yield* found("v9.9.9")).toEqual({ ok: true, url: null });
        expect(
          (yield* against(name, model(name, { runs, installed: false }), (run) =>
            FORGES[name].tagPipeline(ref(name), "v1.2.0", "/w", run),
          )).ok,
        ).toBe(false);
      }),
    ));
}

test("GitHub finds a tag's newest run whatever event started it, a release's among them", () =>
  runEffect(
    Effect.gen(function* () {
      const runs: ForgeModel["runs"] = {
        "7": { status: "success", ref: "v1.2.0", sha: MERGED },
        "9": { status: "failed", ref: "v1.2.0", sha: MERGED, event: "release" },
      };
      const fake = fakeForge("github", model("github", { runs }));
      expect(
        yield* FORGES.github
          .tagPipeline(ref("github"), "v1.2.0", "/w", fake.run)
          .pipe(Effect.provide(fake.layer)),
      ).toEqual({
        ok: true,
        url: URLS.github.run.replace(/7$/, "9"),
      });
    }),
  ));

test("attribution: GitLab retains its earlier merged-results deployment without attributing descendants or another MR's merge", () =>
  runEffect(
    Effect.gen(function* () {
      const fake = fakeForge(
        "gitlab",
        model("gitlab", {
          mrs: [mr("gitlab", { head: "new-head" })],
          ancestry: { [MERGED]: ["target", HEAD], "next-commit": [HEAD] },
          environments: [
            {
              name: "stage-spilnu",
              tier: "staging",
              job: "deploy-stage",
              deployments: [
                {
                  sha: MERGED,
                  status: "success",
                  pipeline: { ref: "refs/merge-requests/30/merge", sha: MERGED },
                },
              ],
            },
            {
              name: "stage-teammate",
              tier: "staging",
              job: "deploy-stage",
              deployments: [
                {
                  sha: "next-commit",
                  status: "success",
                  pipeline: { ref: "feature", sha: "next-commit" },
                },
              ],
            },
            {
              name: "stage-branch-merge",
              tier: "staging",
              job: "deploy-stage",
              deployments: [
                {
                  sha: MERGED,
                  status: "success",
                  pipeline: { ref: "feature", sha: MERGED },
                },
              ],
            },
            {
              name: "stage-other-mr",
              tier: "staging",
              job: "deploy-stage",
              deployments: [
                {
                  sha: MERGED,
                  status: "success",
                  pipeline: { ref: "refs/merge-requests/31/merge", sha: MERGED },
                },
              ],
            },
          ],
        }),
      );
      expect(
        yield* FORGES.gitlab
          .stagingEnvironments(ref("gitlab"), HEAD, "/w", fake.run, ["deploy-stage"])
          .pipe(Effect.provide(fake.layer)),
      ).toEqual({
        ok: true,
        environments: [
          { name: "stage-spilnu", live: MERGED, hasCommit: true },
          { name: "stage-teammate", live: "next-commit", hasCommit: false },
          { name: "stage-branch-merge", live: MERGED, hasCommit: false },
          { name: "stage-other-mr", live: MERGED, hasCommit: false },
        ],
      });
    }),
  ));

test("GitHub attributes stage beyond a page of environments, deployments and selected job attempts", () =>
  runEffect(
    Effect.gen(function* () {
      const fake = fakeForge(
        "github",
        model("github", {
          mrs: [
            mr("github", {
              jobs: Array.from({ length: 101 }, (_, at) => ({
                name: "deploy-stage",
                state: "passed" as const,
                id: 101 - at,
              })),
            }),
          ],
          environments: [
            ...Array.from({ length: 100 }, (_, at) => ({
              name: `review-${at}`,
              tier: "development" as const,
            })),
            {
              name: "stage-web",
              tier: "staging",
              deployments: [
                ...Array.from({ length: 100 }, () => ({
                  sha: "other",
                  status: "failed" as const,
                })),
                { sha: HEAD, status: "success", jobId: 1 },
              ],
            },
          ],
        }),
      );
      expect(
        yield* FORGES.github
          .stagingEnvironments(ref("github"), HEAD, "/w", fake.run, ["deploy-stage"])
          .pipe(
            Effect.provide(
              forgeHttpTest(fake.run, (input, init) =>
                Number(new URL(input).searchParams.get("page")) > 2
                  ? Promise.resolve(new Response('{"message":"unexpected page"}', { status: 400 }))
                  : fake.fetch(input, init),
              ),
            ),
          ),
      ).toEqual({
        ok: true,
        environments: [{ name: "stage-web", live: HEAD, hasCommit: true }],
      });
    }),
  ));

test("GitLab reads a stage environment per environment beyond a page of its deployments", () =>
  runEffect(
    Effect.gen(function* () {
      const fake = fakeForge(
        "gitlab",
        model("gitlab", {
          environments: [
            {
              name: "stage-spilnu",
              tier: "staging",
              deployments: [
                ...Array.from({ length: 120 }, () => ({
                  sha: "failing",
                  status: "failed" as const,
                })),
                { sha: HEAD, status: "success" as const },
              ],
            },
          ],
        }),
      );
      expect(
        yield* FORGES.gitlab
          .stagingEnvironments(ref("gitlab"), HEAD, "/w", fake.run)
          .pipe(Effect.provide(fake.layer)),
      ).toEqual({
        ok: true,
        environments: [{ name: "stage-spilnu", live: HEAD, hasCommit: true }],
      });
    }),
  ));

test("GitLab finds a tier's deployment beyond a page of environments and of deployments", () =>
  runEffect(
    Effect.gen(function* () {
      const fake = fakeForge(
        "gitlab",
        model("gitlab", {
          environments: [
            ...Array.from({ length: 120 }, (_, at) => ({
              name: `preview-${at}`,
              tier: "development",
              deployed: "preview",
            })),
            { name: "stage", tier: "staging", deployed: "child" },
          ],
        }),
      );
      expect(
        yield* FORGES.gitlab
          .deployed(ref("gitlab"), "staging", "/w", fake.run)
          .pipe(Effect.provide(fake.layer)),
      ).toEqual({
        ok: true,
        sha: "child",
      });
    }),
  ));

test("GitHub reads every page of an Actions run's jobs", () =>
  runEffect(
    Effect.gen(function* () {
      const jobs = [
        ...Array.from({ length: 120 }, (_, at) => ({
          name: `test-${at}`,
          state: "passed" as const,
        })),
        { name: "lint", state: "failed" as const },
      ];
      const fake = fakeForge(
        "github",
        model("github", { runs: { "7": { status: "completed", conclusion: "failure", jobs } } }),
      );
      const read = yield* FORGES.github
        .pipeline(URLS.github.run, "/w", fake.run)
        .pipe(Effect.provide(fake.layer));
      expect(read.ok && read.jobs.map((job) => job.state)).toEqual(jobs.map((job) => job.state));
    }),
  ));

test("a status context's state counts as a check run's conclusion does", () => {
  expect(rollupChecks([{ context: "ci/build", state: "PENDING" }])).toEqual({ state: "running" });
  expect(rollupChecks([{ context: "ci/build", state: "SUCCESS" }])).toEqual({ state: "passed" });
  expect(rollupChecks([{ context: "ci/build", state: "ERROR" }])).toEqual({
    state: "failed",
    name: "ci/build",
  });
});

test(
  "each fake answers the same on PATH, logs what it got, and keeps what was posted",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const bin = yield* FakeBin.make(
          yield* fs.makeTempDirectoryScoped({ prefix: "forge-bin-" }),
        );
        try {
          for (const name of ["gitlab", "github"] as const) {
            const onPath = yield* forgeOnPath(bin, name, model(name));
            expect(
              yield* FORGES[name]
                .details(ref(name), "/", shell)
                .pipe(Effect.provide(forgeHttpOnPath)),
            ).toMatchObject({
              _tag: "Details",
              head: HEAD,
            });
            expect(
              (yield* FORGES[name]
                .post(ref(name), "LGTM", false, "/", shell)
                .pipe(Effect.provide(forgeHttpOnPath))).ok,
            ).toBe(true);
            expect(Object.values((yield* onPath.model()).notes ?? {})).toEqual([["LGTM"]]);
            expect((yield* onPath.calls()).length).toBeGreaterThan(0);
            yield* forgeOnPath(bin, name, model(name, { installed: false }));
            expect(yield* exec([CLI[name], "--version"])).toMatchObject({
              exitCode: 127,
              stdout: "",
            });
          }
        } finally {
          yield* bin.restore();
        }
      }),
    ),
  30_000,
);

test("a fake forge's model stays readable while its replacement is being written", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bin = yield* FakeBin.make(yield* fs.makeTempDirectoryScoped({ prefix: "forge-bin-" }));
      try {
        const writing = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        let replacing = false;
        const slow = FileSystem.FileSystem.of({
          ...fs,
          writeFileString: (file, text, options) =>
            replacing
              ? fs
                  .writeFileString(file, "", options)
                  .pipe(
                    Effect.andThen(Deferred.succeed(writing, undefined)),
                    Effect.andThen(Deferred.await(finish)),
                    Effect.andThen(fs.writeFileString(file, text, options)),
                  )
              : fs.writeFileString(file, text, options),
        });
        const original = model("github");
        const next = model("github", { login: "someone-else" });
        const fake = yield* forgeOnPath(bin, "github", original).pipe(
          Effect.provideService(FileSystem.FileSystem, slow),
        );
        replacing = true;
        const write = yield* Effect.forkChild(fake.set(next));
        yield* Deferred.await(writing);
        yield* fake.model().pipe(
          Effect.tap((read) => Effect.sync(() => expect(read).toEqual(original))),
          Effect.ensuring(Deferred.succeed(finish, undefined)),
        );
        yield* Fiber.join(write);
        expect(yield* fake.model()).toEqual(next);
      } finally {
        yield* bin.restore();
      }
    }),
  ));

test("the suite's compiled forge fake receives its model and arguments literally", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bin = yield* FakeBin.make(yield* fs.makeTempDirectoryScoped({ prefix: "forge-bin-" }));
      try {
        const binary = `${bin.dir}/compiled forge's reply`;
        yield* fs.writeFileString(binary, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });
        yield* forgeOnPath(bin, "github", model("github")).pipe(
          Effect.provide(
            ConfigProvider.layerAdd(
              ConfigProvider.fromUnknown({ COLLIE_TEST_FAKE_FORGE: binary }),
              { asPrimary: true },
            ),
          ),
        );
        const args = ["--version", "words with spaces", "a'b", "line one\nline two", "$literal"];
        expect(yield* exec([CLI.github, ...args])).toEqual({
          exitCode: 0,
          stdout: ["github", `${bin.dir}/github.model.json`, ...args].join("\n") + "\n",
          stderr: "",
        });
      } finally {
        yield* bin.restore();
      }
    }),
  ));

test("a forge call that changes nothing leaves the model as a test last wrote it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = `${yield* fs.makeTempDirectoryScoped({ prefix: "forge-bin-" })}/gitlab.model.json`;
      const written = `${Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(model("gitlab"))}\n`;
      yield* fs.writeFileString(file, written);
      yield* forgeBin("gitlab", file, ["api", "--hostname", FORGE_HOST.gitlab, "environments"]);
      expect(yield* fs.readFileString(file)).toBe(written);
    }),
  ));

test("the source forge fake works with no Bun command on PATH", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bin = yield* FakeBin.make(yield* fs.makeTempDirectoryScoped({ prefix: "forge-bin-" }));
      try {
        const onPath = yield* forgeOnPath(bin, "github", model("github")).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
        );
        expect(
          yield* exec([CLI.github, "--version"], {
            env: { ...Bun.env, PATH: `${bin.dir}:/usr/bin:/bin` },
          }),
        ).toEqual({
          exitCode: 0,
          stdout: "gh version 2.0.0",
          stderr: "",
        });
        expect(yield* onPath.calls()).toEqual(["gh --version"]);
      } finally {
        yield* bin.restore();
      }
    }),
  ));

const TEMPLATES = {
  gitlab: [".gitlab/merge_request_templates/default.md"],
  github: [
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md",
    "PULL_REQUEST_TEMPLATE.md",
    "docs/pull_request_template.md",
    "docs/PULL_REQUEST_TEMPLATE.md",
  ],
} as const;

for (const name of ["gitlab", "github"] as const) {
  const forge = FORGES[name];

  test(`the ${name} forge finds a branch's open merge request, none, and auto-merge`, () =>
    runEffect(
      Effect.gen(function* () {
        const open = mr(name, { iid: "31", sourceBranch: "me/x" });
        const ask = (mrs: ReadonlyArray<FakeMr>) =>
          against(name, model(name, { mrs }), (run) =>
            forge.forBranch(PROJECT[name], "me/x", "/w", run),
          );
        expect(yield* ask([mr(name, { sourceBranch: "other" })])).toEqual({ ok: true, open: null });
        expect(yield* ask([open])).toMatchObject({
          ok: true,
          open: { iid: "31", autoMerge: false },
        });
        expect(yield* ask([{ ...open, autoMerge: true }])).toMatchObject({
          open: { autoMerge: true },
        });
        expect(
          yield* ask([
            { ...open, targetBranch: "main" },
            { ...open, iid: "32", targetBranch: "release", autoMerge: true },
          ]),
        ).toMatchObject({
          open: {
            iid: "32",
            autoMerge: true,
            url:
              name === "github"
                ? "https://github.com/owner/repo/pull/32"
                : "https://gitlab.example.com/group/app/-/merge_requests/32",
          },
        });
        expect(
          (yield* against(name, model(name, { installed: false }), (run) =>
            forge.forBranch(PROJECT[name], "me/x", "/w", run),
          )).ok,
        ).toBe(false);
      }),
    ));

  test(`the ${name} forge says a branch is protected by the default branch or any rule, and null where it cannot read`, () =>
    runEffect(
      Effect.gen(function* () {
        const ask = (branch: string, over: Partial<ForgeModel> = {}) =>
          against(name, model(name, { defaultBranch: "main", ...over }), (run) =>
            forge.protects(PROJECT[name], branch, "/w", run),
          );
        const rule =
          name === "gitlab"
            ? { protectedBranches: [{ name: "release/*" }] }
            : { rulesets: ["release/*"] };
        expect(yield* ask("main")).toBe(true);
        expect(yield* ask("me/not-pushed-yet")).toBe(false);
        expect(yield* ask("release/2.0", rule)).toBe(true);
        expect(yield* ask("me/not-pushed-yet", rule)).toBe(false);
        expect(
          yield* ask("release/2.0", {
            protectedBranches: [{ name: "release/*", allowForcePush: true }],
          }),
        ).toBe(true);
        expect(yield* ask("me/x", { protectionDown: true })).toBeNull();
        expect(yield* ask("me/x", { installed: false })).toBeNull();
      }),
    ));

  test(`the ${name} forge lists a branch's merge requests in every state, and says when it cannot`, () =>
    runEffect(
      Effect.gen(function* () {
        const from = (over: Partial<FakeMr>) =>
          mr(name, { sourceBranch: "me/x", createdAt: "2026-10-15T08:00:00Z", ...over });
        const mrs = [
          from({ iid: "31" }),
          from({ iid: "32", state: "merged", mergedAt: "2026-10-15T08:40:00Z" }),
          from({ iid: "33", state: "closed", closedAt: "2026-10-15T09:00:00Z" }),
          mr(name, { iid: "34", sourceBranch: "other" }),
        ];
        const listed = yield* against(name, model(name, { mrs }), (run) =>
          forge.fromBranch(PROJECT[name], "me/x", "/w", run),
        );
        const url = (iid: string) =>
          name === "github"
            ? `https://github.com/owner/repo/pull/${iid}`
            : `https://gitlab.example.com/group/app/-/merge_requests/${iid}`;
        expect(listed).toEqual({
          ok: true,
          mrs: [
            {
              iid: "31",
              url: url("31"),
              state: "open",
              created: "2026-10-15T08:00:00Z",
              ended: null,
            },
            {
              iid: "32",
              url: url("32"),
              state: "merged",
              created: "2026-10-15T08:00:00Z",
              ended: "2026-10-15T08:40:00Z",
            },
            {
              iid: "33",
              url: url("33"),
              state: "closed",
              created: "2026-10-15T08:00:00Z",
              ended: "2026-10-15T09:00:00Z",
            },
          ],
        });
        for (const over of [{ installed: false }, { loggedIn: [] }])
          expect(
            (yield* against(name, model(name, { mrs, ...over }), (run) =>
              forge.fromBranch(PROJECT[name], "me/x", "/w", run),
            )).ok,
          ).toBe(false);
      }),
    ));

  test(`the ${name} forge reads a check's job on the merge request's head, in every state, and says when it cannot`, () =>
    runEffect(
      Effect.gen(function* () {
        const read = (over: Partial<FakeMr>, rest: Partial<ForgeModel> = {}) => {
          const fake = fakeForge(name, model(name, { mrs: [mr(name, over)], ...rest }));
          return forge
            .job(ref(name), "nuxi-typecheck", "/w", fake.run)
            .pipe(Effect.provide(fake.layer));
        };
        const url =
          name === "github"
            ? "https://github.com/owner/repo/actions/runs/4030/job/2"
            : "https://gitlab.example.com/group/app/-/jobs/2";
        for (const state of [
          "passed",
          "pending",
          "running",
          "failed",
          "skipped",
          "cancelled",
        ] as const)
          expect(
            yield* read({
              jobs: [
                { name: "lint", state: "failed" },
                { name: "nuxi-typecheck", state },
              ],
            }),
          ).toEqual({ ok: true, head: HEAD, state, url, id: jobId(name, 2), merge: null });
        expect(yield* read({ jobs: [{ name: "lint", state: "passed" }] })).toEqual({
          ok: true,
          head: HEAD,
          state: "missing",
          url: null,
          id: null,
          merge: null,
        });
        for (const rest of [{ installed: false }, { loggedIn: [] }])
          expect((yield* read({ jobs: [] }, rest)).ok).toBe(false);
      }),
    ));

  test(`the ${name} forge reads a job where the branch leaves its target, else on the target's latest, and fails safe`, () =>
    runEffect(
      Effect.gen(function* () {
        const BASE = "b".repeat(40);
        const TIP = "c".repeat(40);
        const failed = [{ name: "nuxi-typecheck", state: "failed" as const }];
        const passed = [{ name: "nuxi-typecheck", state: "passed" as const }];
        const read = (over: Partial<FakeMr>) => {
          const fake = fakeForge(
            name,
            model(name, { mrs: [mr(name, { targetBranch: "main", ...over })] }),
          );
          return forge
            .baseJob(ref(name), "nuxi-typecheck", "/w", fake.run)
            .pipe(Effect.provide(fake.layer));
        };
        expect(
          yield* read({ base: { at: BASE, jobs: failed }, target: { at: TIP, jobs: passed } }),
        ).toMatchObject({ ok: true, at: BASE, state: "failed" });
        expect(
          yield* read({ base: { at: BASE }, target: { at: TIP, jobs: failed } }),
        ).toMatchObject({ ok: true, at: TIP, state: "failed" });
        expect((yield* read({ base: { at: BASE } })).ok).toBe(false);
        expect((yield* read({ target: { at: TIP, jobs: failed } })).ok).toBe(false);
        // CI ran there without it: the target's red job says nothing about it.
        expect(
          yield* read({
            base: { at: BASE, jobs: [{ name: "lint", state: "passed" }] },
            target: { at: TIP, jobs: failed },
          }),
        ).toEqual({ ok: true, at: BASE, state: "missing", url: null });
      }),
    ));

  test(`the ${name} forge retries a job once asked, and says how to read its log`, () => {
    const fake = fakeForge(
      name,
      model(name, {
        mrs: [mr(name, { jobs: [{ name: "nuxi-typecheck", state: "failed", retried: "passed" }] })],
      }),
    );
    return runEffect(
      Effect.gen(function* () {
        const job = () => forge.job(ref(name), "nuxi-typecheck", "/w", fake.run);
        expect(yield* job()).toMatchObject({ state: "failed", id: jobId(name, 1) });
        expect(yield* forge.retryJob(ref(name), jobId(name, 1), "/w", fake.run)).toEqual({
          ok: true,
          reason: "",
        });
        expect(yield* job()).toMatchObject({ state: "passed", id: jobId(name, 101) });
        expect(
          (yield* forge.retryJob(ref(name), name === "github" ? "9/9" : "9", "/w", fake.run)).ok,
        ).toBe(false);
        expect(forge.jobLog(ref(name), jobId(name, 1))).toBe(
          name === "gitlab"
            ? "glab ci trace 1 --repo gitlab.example.com/group/app"
            : "gh run view 4030 --log-failed --repo owner/repo",
        );
      }).pipe(Effect.provide(fake.layer)),
    );
  });

  test(`the ${name} forge finds the repository's template wherever it keeps one, and none`, () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (const where of TEMPLATES[name]) {
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "forge-template-" });
          expect(yield* forge.template(dir)).toBe(null);
          const parent = where.split("/").slice(0, -1).join("/");
          if (parent !== "") yield* fs.makeDirectory(`${dir}/${parent}`, { recursive: true });
          yield* fs.writeFileString(`${dir}/${where}`, "## Description\n");
          expect(yield* forge.template(dir)).toBe(where);
        }
      }),
    ));
}

for (const name of ["gitlab", "github"] as const) {
  test(`the ${name} forge clones a repository into a directory, and refuses where it is not logged in`, () =>
    runEffect(
      Effect.gen(function* () {
        const fake = fakeForge(name, model(name));
        expect(yield* FORGES[name].clone(PROJECT[name], "/into", "/w", fake.run)).toEqual({
          ok: true,
          reason: "",
        });
        expect(fake.model().cloned).toEqual([`${PROJECT[name]} /into`]);
        const out = fakeForge(name, model(name, { loggedIn: [] }));
        const refused = yield* FORGES[name].clone(PROJECT[name], "/into", "/w", out.run);
        expect(refused.ok).toBe(false);
        expect(out.model().cloned ?? []).toEqual([]);
      }),
    ));
}

for (const name of ["gitlab", "github"] as const) {
  test(`a ${name} clone keeps a credential helper that asks ${CLI[name]} at each use, and no token`, () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "forge-credentials-" });
        const bin = yield* FakeBin.make(`${dir}/bin`);
        try {
          const onPath = yield* forgeOnPath(bin, name, model(name, { token: "first-token" }));
          const clone = `${dir}/clone`;
          yield* exec(["git", "init", "--quiet", clone]);
          // A global helper with a stale answer, which git would otherwise ask first.
          const global = `${dir}/global.gitconfig`;
          yield* fs.writeFileString(
            global,
            `[credential]\n\thelper = "!f() { echo username=stale; echo password=stale-token; }; f"\n`,
          );
          const env = {
            ...process.env,
            GIT_CONFIG_GLOBAL: global,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
          };
          const host = FORGE_HOST[name];
          const fill = exec(
            ["sh", "-c", `printf 'protocol=https\\nhost=${host}\\n\\n' | git credential fill`],
            { cwd: clone, env },
          );

          for (const _ of [1, 2])
            expect(yield* FORGES[name].credentials(PROJECT[name], clone, shell)).toEqual({
              ok: true,
              reason: "",
            });
          expect((yield* fill).stdout).toContain("password=first-token\n");
          yield* onPath.set(model(name, { token: "second-token" }));
          expect((yield* fill).stdout).toContain("password=second-token\n");

          const config = yield* fs.readFileString(`${clone}/.git/config`);
          expect(config).not.toContain("-token");
          expect(config.toLowerCase()).not.toContain("extraheader");
          const helpers = (yield* exec(
            ["git", "config", "--local", "--get-all", `credential.https://${host}.helper`],
            { cwd: clone },
          )).stdout
            .split("\n")
            .slice(0, -1);
          expect(helpers).toHaveLength(2);
          expect(helpers[0]).toBe("");
        } finally {
          yield* bin.restore();
        }
      }),
    ));
}

test("a GitLab pipeline of an older head is not this head's CI, and one that was canceled has not passed", () =>
  runEffect(
    Effect.gen(function* () {
      const checksOf = (over: Partial<FakeMr>) =>
        Effect.map(
          against(
            "gitlab",
            model("gitlab", {
              mrs: [mr("gitlab", { checks: [{ name: "test", state: "passed" }], ...over })],
            }),
            (run) => gitlab.details(ref("gitlab"), "/w", run),
          ),
          (panel) => (panel._tag === "Details" ? panel.checks : undefined),
        );
      expect(yield* checksOf({ head: "new-head" })).toEqual({ state: "passed" });
      expect(yield* checksOf({ head: "new-head", pipelineAt: "old-head" })).toEqual({
        state: "unknown",
      });
      expect(pipelineChecks("canceled")).toEqual({ state: "unknown" });
      expect(pipelineChecks("")).toEqual({ state: "none" });
    }),
  ));

test("a GitLab job past the first page of its pipeline's jobs is found", () =>
  runEffect(
    Effect.gen(function* () {
      const jobs = [
        ...Array.from({ length: 100 }, (_, n) => ({
          name: `shard-${n}`,
          state: "passed" as const,
        })),
        { name: "nuxi-typecheck", state: "passed" as const },
      ];
      const fake = fakeForge("gitlab", model("gitlab", { mrs: [mr("gitlab", { jobs })] }));
      expect(
        yield* gitlab
          .job(ref("gitlab"), "nuxi-typecheck", "/w", fake.run)
          .pipe(Effect.provide(fake.layer)),
      ).toMatchObject({ ok: true, state: "passed", id: "101" });
    }),
  ));

test("a GitLab merged-results pipeline counts for the head it was built from, and one that cannot be shown is not missing", () =>
  runEffect(
    Effect.gen(function* () {
      const MERGE = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
      const TARGET = "0000000000000000000000000000000000000001";
      const read = (over: Partial<FakeMr>, ancestry: Record<string, ReadonlyArray<string>>) => {
        const fake = fakeForge(
          "gitlab",
          model("gitlab", {
            mrs: [mr("gitlab", { jobs: [{ name: "nuxi-typecheck", state: "passed" }], ...over })],
            ancestry,
          }),
        );
        return gitlab
          .job(ref("gitlab"), "nuxi-typecheck", "/w", fake.run)
          .pipe(Effect.provide(fake.layer));
      };
      expect(yield* read({ pipelineAt: MERGE }, { [MERGE]: [TARGET, HEAD] })).toEqual({
        ok: true,
        head: HEAD,
        state: "passed",
        url: "https://gitlab.example.com/group/app/-/jobs/1",
        id: "1",
        merge: MERGE,
      });
      // A pipeline of an older head: this head's has not started.
      expect(
        yield* read({ pipelineAt: MERGE }, { [MERGE]: [TARGET, "an-older-head"] }),
      ).toMatchObject({ ok: true, state: "pending" });
      const unshown = yield* read({ pipelineAt: MERGE }, {});
      expect(unshown.ok).toBe(false);
      if (!unshown.ok) expect(unshown.reason).toContain(MERGE);
    }),
  ));

const WEB = {
  gitlab: "https://gitlab.example.com/group/app/-/merge_requests/30",
  github: "https://github.com/owner/repo/pull/30",
} as const;

for (const name of ["gitlab", "github"] as const) {
  const forge = FORGES[name];
  /** A thread, by the id of its first comment: GitLab's discussion, GitHub's first review comment. */
  const thread = (first: number) => (name === "gitlab" ? `d${first}` : String(first));
  /** A comment's address: GitLab's note, GitHub's review comment or issue comment. */
  const urlOf = (id: number, threaded: boolean) =>
    name === "gitlab"
      ? `${WEB.gitlab}#note_${id}`
      : `${WEB.github}#${threaded ? "discussion_r" : "issuecomment-"}${id}`;
  const at = (minute: number) => `2026-10-20T10:${String(minute).padStart(2, "0")}:00Z`;
  const read = (over: Partial<FakeMr>, rest: Partial<ForgeModel> = {}) =>
    against(name, model(name, { mrs: [mr(name, over)], ...rest }), (run) =>
      forge.readReview(ref(name), "/w", run),
    );

  describe(`the ${name} forge's review read`, () => {
    test("merges over HTTP from a cold login", () => {
      const fake = fakeForge(
        name,
        model(name, { mergeMethod: "SQUASH", mrs: [mr(name, { mergedSha: MERGED })] }),
      );
      return runEffect(
        Effect.gen(function* () {
          expect(yield* forge.merge(ref(name), HEAD, "/w", fake.run)).toEqual({
            _tag: "Merged",
            merged: MERGED,
          });
          expect(fake.model().merges).toMatchObject([
            { sha: HEAD, method: name === "github" ? "squash" : null },
          ]);
          expect(fake.requests.filter((one) => one.method === "PUT")).toHaveLength(1);
          expect(fake.calls).toEqual([...READ_ONCE[name]]);
        }).pipe(Effect.provide(fake.layer)),
      );
    });

    for (const outcome of ["merged", "head moved"] as const)
      test(`a merge returning 503 is sent once and reads that it ${outcome}`, () => {
        const fake = fakeForge(name, model(name, { mrs: [mr(name, { mergedSha: MERGED })] }));
        const layer = forgeHttpTest(fake.run, (input, init = {}) => {
          const merging = init.method === "PUT" && input.endsWith("/merge");
          if (merging && outcome === "head moved")
            fake.set({ ...fake.model(), mrs: [mr(name, { head: "new-head" })] });
          return fake
            .fetch(input, init)
            .then((response) =>
              merging
                ? new Response('{"message":"service unavailable"}', { status: 503 })
                : response,
            );
        });
        return runEffect(
          Effect.gen(function* () {
            expect(yield* forge.merge(ref(name), HEAD, "/w", fake.run)).toEqual(
              outcome === "merged"
                ? {
                    _tag: "AlreadyMerged",
                    merged: MERGED,
                    head: HEAD,
                    by: "me",
                    at: "2026-10-20T12:00:00Z",
                  }
                : { _tag: "HeadMoved", head: "new-head" },
            );
            expect(fake.requests.filter((one) => one.method === "PUT")).toHaveLength(1);
            expect(fake.model().merges?.length ?? 0).toBe(outcome === "merged" ? 1 : 0);
            expect(fake.calls).toEqual([...READ_ONCE[name]]);
          }).pipe(Effect.provide(layer)),
        );
      });

    for (const threaded of [false, true])
      test(`replies ${threaded ? "in a thread" : "on the merge request"} over HTTP from a cold login`, () => {
        const fake = fakeForge(
          name,
          model(name, {
            mrs: [
              mr(name, {
                comments: [
                  { id: 11, author: "alice", at: at(1), body: "Fix this", thread: thread(11) },
                ],
              }),
            ],
          }),
        );
        const to = threaded ? thread(11) : null;
        return runEffect(
          Effect.gen(function* () {
            expect(
              yield* forge.reply(
                ref(name),
                { thread: to },
                "Fixed\nSee the commit.",
                "/w",
                fake.run,
              ),
            ).toEqual({ ok: true, reason: "" });
            expect(Object.values(fake.model().replies ?? {})).toEqual([
              [{ thread: to, body: "Fixed\nSee the commit." }],
            ]);
            expect(fake.requests.filter((one) => one.method === "POST")).toHaveLength(1);
            expect(fake.calls).toEqual([...READ_ONCE[name]]);
          }).pipe(Effect.provide(fake.layer)),
        );
      });

    test("reads a review over HTTP from a cold login", () => {
      const fake = fakeForge(
        name,
        model(name, {
          reviewsRequired: { classic: 1, rulesets: [1] },
          mrs: [
            mr(name, {
              targetBranch: "main",
              required: 1,
              approvers: ["me", "alice"],
              reviews: [
                { id: 1, author: "me", state: "APPROVED", at: at(1) },
                { id: 2, author: "alice", state: "APPROVED", at: at(2) },
              ],
              comments: [
                { id: 11, author: "bob", at: at(3), body: "Fix this", thread: thread(11) },
              ],
            }),
          ],
        }),
      );
      return runEffect(
        Effect.gen(function* () {
          expect(yield* forge.readReview(ref(name), "/w", fake.run)).toMatchObject({
            ok: true,
            head: HEAD,
            approved: true,
            approvers: ["alice"],
            comments: [{ id: "11", body: "Fix this", external: true, answered: false }],
          });
          expect(fake.requests.length).toBeGreaterThan(0);
          expect(fake.calls).toEqual([...READ_ONCE[name]]);
        }).pipe(Effect.provide(fake.layer)),
      );
    });

    test("reads the state, head, pipeline, mergeability and every comment with its kind and place", () =>
      runEffect(
        Effect.gen(function* () {
          const review = yield* read({
            checks: [{ name: "test", state: "passed" }],
            comments: [
              {
                id: 11,
                author: "alice",
                at: at(0),
                body: "Rename this",
                thread: thread(11),
                file: "src/a.ts",
                line: 4,
              },
              { id: 12, author: "bob", at: at(5), body: "Agreed", thread: thread(11) },
              { id: 13, author: "renovate", kind: "bot", at: at(10), body: "Bumped" },
              { id: 15, author: "me", at: at(20), body: "Pushed a fix" },
            ],
          });
          if (!review.ok) throw new Error(review.reason);
          expect(review).toMatchObject({
            login: "me",
            state: "open",
            head: HEAD,
            merged: null,
            pipeline: { state: "passed" },
            mergeable: { state: "mergeable" },
            approved: true,
            changesRequested: false,
          });
          expect(review.comments).toEqual([
            {
              id: "11",
              url: urlOf(11, true),
              thread: thread(11),
              author: "alice",
              kind: "person",
              at: at(0),
              body: "Rename this",
              file: "src/a.ts",
              line: 4,
              external: true,
              answered: false,
            },
            {
              id: "12",
              url: urlOf(12, true),
              thread: thread(11),
              author: "bob",
              kind: "person",
              at: at(5),
              body: "Agreed",
              file: null,
              line: null,
              external: true,
              answered: false,
            },
            expect.objectContaining({ id: "13", kind: "bot", thread: null, external: false }),
            expect.objectContaining({ id: "15", author: "me", kind: "person", external: false }),
          ]);
        }),
      ));

    test("counts a comment answered by Collie's later reply in its thread, a reply that links it, or a resolved thread", () =>
      runEffect(
        Effect.gen(function* () {
          const review = yield* read({
            comments: [
              { id: 11, author: "alice", at: at(0), body: "One", thread: thread(11) },
              { id: 12, author: "me", at: at(5), body: "Fixed in abc1234", thread: thread(11) },
              { id: 21, author: "carol", at: at(10), body: "Two" },
              { id: 22, author: "me", at: at(15), body: `Fixed: ${urlOf(21, false)}` },
              { id: 31, author: "dave", at: at(20), body: "Three", thread: thread(31) },
              { id: 41, author: "erin", at: at(25), body: "Four" },
              { id: 2, author: "gus", at: at(27), body: "Five" },
              { id: 51, author: "me", at: at(30), body: "Note", thread: thread(51) },
              { id: 52, author: "frank", at: at(35), body: "Six", thread: thread(51) },
            ],
            resolved: [thread(31)],
          });
          if (!review.ok) throw new Error(review.reason);
          const answered = Object.fromEntries(
            review.comments.filter((one) => one.external).map((one) => [one.id, one.answered]),
          );
          expect(answered).toEqual({
            "11": true,
            "21": true,
            "31": true,
            "41": false,
            // Linked by 22 only as part of comment 21's address.
            "2": false,
            "52": false,
          });
        }),
      ));

    test("answers a reply where it belongs, with its body as given, and never resolves the thread", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(
            name,
            model(name, {
              now: at(50),
              mrs: [
                mr(name, {
                  comments: [
                    { id: 11, author: "alice", at: at(0), body: "Inline", thread: thread(11) },
                    { id: 21, author: "carol", at: at(10), body: "On the whole" },
                  ],
                }),
              ],
            }),
          );
          const body = "@file stays as written";
          expect(
            yield* forge
              .reply(ref(name), { thread: thread(11) }, body, "/w", fake.run)
              .pipe(Effect.provide(fake.layer)),
          ).toEqual({
            ok: true,
            reason: "",
          });
          const linked = `Not changed: ${urlOf(21, false)}`;
          expect(
            yield* forge
              .reply(ref(name), { thread: null }, linked, "/w", fake.run)
              .pipe(Effect.provide(fake.layer)),
          ).toEqual({
            ok: true,
            reason: "",
          });
          expect(fake.model().replies).toEqual({
            [`${PROJECT[name]}${name === "gitlab" ? "!" : "#"}30`]: [
              { thread: thread(11), body },
              { thread: null, body: linked },
            ],
          });
          expect(fake.model().mrs[0]?.resolved).toBeUndefined();
          const review = yield* forge
            .readReview(ref(name), "/w", fake.run)
            .pipe(Effect.provide(fake.layer));
          if (!review.ok) throw new Error(review.reason);
          expect(
            review.comments.filter((one) => one.external).map((one) => [one.id, one.answered]),
          ).toEqual([
            ["11", true],
            ["21", true],
          ]);
          const missing = yield* forge
            .reply(ref(name), { thread: thread(99) }, "x", "/w", fake.run)
            .pipe(Effect.provide(fake.layer));
          expect(missing.ok).toBe(false);
        }),
      ));

    test("merges at the head through the REST merge, never `mr merge`, admin or auto-merge", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(
            name,
            model(name, {
              now: at(55),
              mergeMethod: "SQUASH",
              mrs: [mr(name, { mergedSha: MERGED })],
            }),
          );
          expect(
            yield* forge.merge(ref(name), HEAD, "/w", fake.run).pipe(Effect.provide(fake.layer)),
          ).toEqual({
            _tag: "Merged",
            merged: MERGED,
          });
          expect(fake.model().merges).toEqual([
            {
              key: `${PROJECT[name]}${name === "gitlab" ? "!" : "#"}30`,
              sha: HEAD,
              method: name === "github" ? "squash" : null,
              fields: name === "gitlab" ? [`sha=${HEAD}`] : [`sha=${HEAD}`, "merge_method=squash"],
              by: "me",
              at: at(55),
            },
          ]);
          const said = fake.calls.join("\n");
          expect(said).not.toMatch(/mr merge|pr merge|--admin|auto/);
        }),
      ));

    test("answers a moved head, an unmergeable one and one already merged without merging", () =>
      runEffect(
        Effect.gen(function* () {
          const ask = (over: Partial<FakeMr>, head = HEAD) => {
            const fake = fakeForge(name, model(name, { mrs: [mr(name, over)] }));
            return Effect.map(
              forge.merge(ref(name), head, "/w", fake.run).pipe(Effect.provide(fake.layer)),
              (answer) => ({
                answer,
                merges: fake.model().merges,
              }),
            );
          };
          expect(yield* ask({}, "0ld")).toEqual({
            answer: { _tag: "HeadMoved", head: HEAD },
            merges: undefined,
          });
          const conflicted = yield* ask({ mergeable: "conflict" });
          expect(conflicted.answer._tag).toBe("Refused");
          expect(conflicted.merges).toBeUndefined();
          expect(
            (yield* ask({
              state: "merged",
              mergedSha: MERGED,
              mergedBy: "alice",
              mergedAt: at(40),
            })).answer,
          ).toEqual({ _tag: "AlreadyMerged", merged: MERGED, head: HEAD, by: "alice", at: at(40) });
        }),
      ));

    test("reads a merged merge request's commit, who merged it and when", () =>
      runEffect(
        Effect.gen(function* () {
          const review = yield* read({
            state: "merged",
            mergedSha: MERGED,
            mergedBy: "alice",
            mergedAt: at(40),
          });
          expect(review).toMatchObject({
            ok: true,
            state: "merged",
            merged: { sha: MERGED, by: "alice", at: at(40) },
          });
        }),
      ));

    test("says why where the forge cannot be asked", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(name, model(name, { installed: false }));
          const review = yield* forge
            .readReview(ref(name), "/w", fake.run)
            .pipe(Effect.provide(fake.layer));
          expect(review.ok).toBe(false);
          if (!review.ok) expect(review.reason).toContain(CLI[name]);
          expect(
            (yield* forge
              .reply(ref(name), { thread: null }, "x", "/w", fake.run)
              .pipe(Effect.provide(fake.layer))).ok,
          ).toBe(false);
          expect(
            (yield* forge.merge(ref(name), HEAD, "/w", fake.run).pipe(Effect.provide(fake.layer)))
              ._tag,
          ).toBe("Refused");
          const unread = yield* against(name, model(name), (run) =>
            forge.readReview({ project: PROJECT[name], iid: "99" }, "/w", run),
          );
          expect(unread.ok).toBe(false);
        }),
      ));

    test("leaves Collie's own approval out of the approvers", () =>
      runEffect(
        Effect.gen(function* () {
          const review =
            name === "gitlab"
              ? yield* read({ required: 1, approvers: ["me"] })
              : yield* read(
                  { reviews: [{ id: 901, author: "me", state: "APPROVED", at: at(1) }] },
                  { reviewsRequired: { classic: 1 } },
                );
          expect(review).toMatchObject({ ok: true, approved: false, approvers: [] });
          if (review.ok) expect(review.unapproved).toContain("me's own");
        }),
      ));
  });
}

const reviewOn = (name: MrForge, over: Partial<FakeMr>, rest: Partial<ForgeModel> = {}) =>
  against(
    name,
    model(name, { mrs: [mr(name, { targetBranch: "main", ...over })], ...rest }),
    (run) => FORGES[name].readReview(ref(name), "/w", run),
  );

test("GitHub reads a review comment beyond the first HTTP page", () => {
  const fake = fakeForge(
    "github",
    model("github", {
      mrs: [
        mr("github", {
          comments: Array.from({ length: 101 }, (_, n) => ({
            id: n + 1,
            author: "alice",
            at: "2026-10-20T10:00:00Z",
            body: `Finding ${n + 1}`,
            thread: String(n + 1),
          })),
        }),
      ],
    }),
  );
  return runEffect(
    Effect.gen(function* () {
      const review = yield* FORGES.github.readReview(ref("github"), "/w", fake.run);
      if (!review.ok) throw new Error(review.reason);
      expect(review.comments).toHaveLength(101);
      expect(review.comments[100]).toMatchObject({
        id: "101",
        body: "Finding 101",
        external: true,
        answered: false,
      });
      expect(
        fake.requests.some((one) => one.url.includes("/pulls/30/comments?per_page=100&page=2")),
      ).toBe(true);
      expect(fake.calls).toEqual([...READ_ONCE.github]);
    }).pipe(Effect.provide(fake.layer)),
  );
});

const approval = (review: ReviewRead) => {
  if (!review.ok) throw new Error(review.reason);
  return { approved: review.approved, approvers: review.approvers };
};

test("GitLab counts each approval rule again without Collie's approval, on every tier", () =>
  runEffect(
    Effect.gen(function* () {
      const gitlabOn = (over: Partial<FakeMr>, rest: Partial<ForgeModel> = {}) =>
        Effect.map(reviewOn("gitlab", over, rest), approval);
      expect(yield* gitlabOn({ required: 2, approvers: ["alice", "me"] })).toEqual({
        approved: false,
        approvers: ["alice"],
      });
      expect(yield* gitlabOn({ required: 2, approvers: ["alice", "bob", "me"] })).toEqual({
        approved: true,
        approvers: ["alice", "bob"],
      });
      // Collie's approval is the only one on the second rule.
      const rules = [
        { name: "Maintainers", required: 1, approvers: ["alice"] },
        { name: "Security", required: 1, approvers: ["me"] },
      ];
      expect(yield* gitlabOn({ rules, approvers: ["alice", "me"] })).toEqual({
        approved: false,
        approvers: ["alice"],
      });
      const free = { free: true } as const;
      expect(yield* gitlabOn({ required: 2, approvers: ["alice", "me"] }, free)).toEqual({
        approved: false,
        approvers: ["alice"],
      });
      expect(yield* gitlabOn({ required: 2, approvers: ["alice", "bob", "me"] }, free)).toEqual({
        approved: true,
        approvers: ["alice", "bob"],
      });
      // No rule requires an approval.
      expect(yield* gitlabOn({})).toEqual({ approved: true, approvers: [] });
      const asked = yield* reviewOn("gitlab", { changesRequested: true });
      expect(asked).toMatchObject({ ok: true, approved: false, changesRequested: true });
    }),
  ));

test("GitLab's system notes and access-token bots are not external", () =>
  runEffect(
    Effect.gen(function* () {
      const review = yield* reviewOn("gitlab", {
        comments: [
          {
            id: 1,
            author: "alice",
            kind: "system",
            at: "2026-10-20T10:00:00Z",
            body: "added 1 commit",
          },
          { id: 2, author: "project_7_bot_5f2e", at: "2026-10-20T10:01:00Z", body: "Deployed" },
          { id: 3, author: "dependabot", kind: "bot", at: "2026-10-20T10:02:00Z", body: "Bump" },
        ],
      });
      if (!review.ok) throw new Error(review.reason);
      expect(review.comments.map((one) => [one.kind, one.external])).toEqual([
        ["system", false],
        ["bot", false],
        ["bot", false],
      ]);
    }),
  ));

test("GitHub's approval stands without Collie's only where the base branch's required count is met by others", () =>
  runEffect(
    Effect.gen(function* () {
      const review = (id: number, author: string, state: "APPROVED" | "CHANGES_REQUESTED") => ({
        id,
        author,
        state,
        at: `2026-10-20T10:0${id % 10}:00Z`,
      });
      const githubOn = (
        reviews: ReadonlyArray<ReturnType<typeof review>>,
        rest: Partial<ForgeModel> = {},
      ) => Effect.map(reviewOn("github", { reviews }, rest), approval);
      const two = { reviewsRequired: { classic: 2 } };
      expect(
        yield* githubOn([review(1, "alice", "APPROVED"), review(2, "me", "APPROVED")], two),
      ).toEqual({
        approved: false,
        approvers: ["alice"],
      });
      expect(
        yield* githubOn(
          [
            review(1, "alice", "APPROVED"),
            review(2, "me", "APPROVED"),
            review(3, "bob", "APPROVED"),
          ],
          two,
        ),
      ).toEqual({
        approved: true,
        approvers: ["alice", "bob"],
      });
      // A ruleset requiring more than branch protection decides.
      const ruleset = { reviewsRequired: { classic: 1, rulesets: [2] } };
      expect(
        yield* githubOn([review(1, "alice", "APPROVED"), review(2, "me", "APPROVED")], ruleset),
      ).toEqual({
        approved: false,
        approvers: ["alice"],
      });
      // Approved by others alone needs no count.
      expect(
        yield* githubOn([review(1, "alice", "APPROVED")], { reviewsRequired: { classic: 1 } }),
      ).toEqual({
        approved: true,
        approvers: ["alice"],
      });
      const unread = yield* reviewOn(
        "github",
        { reviews: [review(1, "alice", "APPROVED"), review(2, "me", "APPROVED")] },
        { reviewsRequired: { classic: 1 }, protectionDown: true },
      );
      expect(unread).toMatchObject({ ok: true, approved: false });
      if (unread.ok) expect(unread.unapproved).toContain("me's own approval stands");
      const owners = yield* reviewOn(
        "github",
        { reviews: [review(1, "alice", "APPROVED"), review(2, "me", "APPROVED")] },
        { reviewsRequired: { classic: 1, codeOwners: true } },
      );
      expect(owners).toMatchObject({ ok: true, approved: false });
      if (owners.ok) expect(owners.unapproved).toContain("code owners");
    }),
  ));

test("GitHub with no review required is approved unless an external reviewer asks for changes", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* reviewOn("github", {})).toMatchObject({
        ok: true,
        approved: true,
        changesRequested: false,
      });
      const asked = yield* reviewOn("github", {
        reviews: [
          {
            id: 1,
            author: "alice",
            state: "CHANGES_REQUESTED",
            body: "Please split this",
            at: "2026-10-20T10:00:00Z",
          },
        ],
      });
      expect(asked).toMatchObject({ ok: true, approved: false, changesRequested: true });
      // The review's body is a comment of its own.
      if (asked.ok)
        expect(asked.comments).toEqual([
          expect.objectContaining({
            id: "1",
            url: "https://github.com/owner/repo/pull/30#pullrequestreview-1",
            body: "Please split this",
            thread: null,
            external: true,
          }),
        ]);
      const byBot = yield* reviewOn("github", {
        reviews: [
          {
            id: 2,
            author: "linter",
            bot: true,
            state: "CHANGES_REQUESTED",
            at: "2026-10-20T10:00:00Z",
          },
        ],
      });
      expect(byBot).toMatchObject({ ok: true, approved: true, changesRequested: false });
      const withdrawn = yield* reviewOn("github", {
        reviews: [
          { id: 3, author: "alice", state: "CHANGES_REQUESTED", at: "2026-10-20T10:00:00Z" },
          { id: 4, author: "alice", state: "APPROVED", at: "2026-10-20T10:05:00Z" },
        ],
      });
      expect(withdrawn).toMatchObject({ ok: true, approved: true, changesRequested: false });
    }),
  ));

/** What ForgeHttp may run: a credential read, and nothing else. */
const CREDENTIAL_READ =
  /^(?:gh auth token --hostname github\.com|(?:env -u GITLAB_TOKEN -u GITLAB_ACCESS_TOKEN -u OAUTH_TOKEN )?glab config get (?:token|oauth2_expiry_date) --host \S+|glab auth status --hostname \S+)$/;

/** The commands one cold credential read of a forge's host runs. */
const READ_ONCE = {
  github: ["gh auth token --hostname github.com"],
  gitlab: [
    "glab config get oauth2_expiry_date --host gitlab.example.com",
    "glab config get token --host gitlab.example.com",
  ],
} as const;

const FIRST_TOKEN = { gitlab: "glpat-fake", github: "gho-fake" } as const;
const RELOGIN = {
  gitlab: "glab auth login --hostname gitlab.example.com",
  github: "gh auth login --hostname github.com",
} as const;

for (const name of ["gitlab", "github"] as const) {
  const forge = FORGES[name];
  const BASE = "b".repeat(40);
  const jobbed = (over: Partial<ForgeModel> = {}) =>
    fakeForge(
      name,
      model(name, {
        mrs: [
          mr(name, {
            sourceBranch: "me/x",
            targetBranch: "main",
            jobs: [{ name: "nuxi-typecheck", state: "failed", retried: "passed" }],
            base: { at: BASE, jobs: [{ name: "nuxi-typecheck", state: "passed" }] },
          }),
        ],
        runs: { "7": { status: "completed", conclusion: "success" } },
        ...over,
      }),
    );
  type Fake = ReturnType<typeof jobbed>;
  const job = (fake: Fake) => forge.job(ref(name), "nuxi-typecheck", "/w", fake.run);
  /** Each operation moved onto HTTP, and whether the forge answered it. */
  const asked = {
    job: (fake: Fake) => Effect.map(job(fake), (read) => read.ok),
    baseJob: (fake: Fake) =>
      Effect.map(forge.baseJob(ref(name), "nuxi-typecheck", "/w", fake.run), (read) => read.ok),
    retryJob: (fake: Fake) =>
      Effect.map(forge.retryJob(ref(name), jobId(name, 1), "/w", fake.run), (read) => read.ok),
    runStatus: (fake: Fake) =>
      Effect.map(forge.runStatus(URLS[name].run, "/w", fake.run), (status) => status !== null),
    details: (fake: Fake) =>
      Effect.map(forge.details(ref(name), "/w", fake.run), (panel) => panel._tag === "Details"),
    forBranch: (fake: Fake) =>
      Effect.map(
        forge.forBranch(PROJECT[name], "me/x", "/w", fake.run),
        (found) => found.ok && found.open?.iid === "30",
      ),
    fromBranch: (fake: Fake) =>
      Effect.map(
        forge.fromBranch(PROJECT[name], "me/x", "/w", fake.run),
        (listed) => listed.ok && listed.mrs.length === 1,
      ),
  };

  describe(`the ${name} forge over HTTP`, () => {
    for (const [operation, ask] of Object.entries(asked))
      test(`answers ${operation} from a cold start with requests, running only credential reads`, () => {
        const fake = jobbed();
        return runEffect(
          Effect.gen(function* () {
            expect(yield* ask(fake)).toBe(true);
            expect(fake.requests.length).toBeGreaterThan(0);
            expect(fake.calls.filter((call) => !CREDENTIAL_READ.test(call))).toEqual([]);
          }).pipe(Effect.provide(fake.layer)),
        );
      });

    test("answers a 404 as unavailable, naming the status", () => {
      const fake = jobbed();
      return runEffect(
        Effect.gen(function* () {
          const read = yield* forge.job(
            { ...ref(name), iid: "99" },
            "nuxi-typecheck",
            "/w",
            fake.run,
          );
          expect(read.ok).toBe(false);
          if (!read.ok) expect(read.reason).toContain("404");
        }).pipe(Effect.provide(fake.layer)),
      );
    });

    test("after a 401 reads the token once more and resends the request with it, once", () => {
      const fake = jobbed();
      return runEffect(
        Effect.gen(function* () {
          const before = yield* job(fake);
          fake.set({ ...fake.model(), token: "rotated" });
          fake.calls.length = 0;
          fake.requests.length = 0;
          expect(yield* job(fake)).toEqual(before);
          expect(fake.calls).toEqual([...READ_ONCE[name]]);
          const [refused, resent, ...rest] = fake.requests;
          expect(resent?.url).toBe(refused?.url);
          expect([refused?.token, resent?.token, ...rest.map((one) => one.token)]).toEqual([
            FIRST_TOKEN[name],
            ...Array.from({ length: rest.length + 1 }, () => "rotated"),
          ]);
        }).pipe(Effect.provide(fake.layer)),
      );
    });

    test("a second 401 answers unavailable, naming the login command, with no third request", () => {
      const fake = jobbed({ revoked: true });
      return runEffect(
        Effect.gen(function* () {
          const read = yield* job(fake);
          expect(read.ok).toBe(false);
          if (!read.ok) expect(read.reason).toContain(RELOGIN[name]);
          expect(fake.requests).toHaveLength(2);
          expect(fake.calls).toEqual([...READ_ONCE[name], ...READ_ONCE[name]]);
        }).pipe(Effect.provide(fake.layer)),
      );
    });

    test("a retry refused with a 401 once is resent once, and runs", () => {
      const fake = jobbed();
      return runEffect(
        Effect.gen(function* () {
          yield* job(fake);
          fake.set({ ...fake.model(), token: "rotated" });
          fake.requests.length = 0;
          expect(yield* forge.retryJob(ref(name), jobId(name, 1), "/w", fake.run)).toEqual({
            ok: true,
            reason: "",
          });
          expect(fake.requests.map((one) => [one.method, one.token])).toEqual([
            ["POST", FIRST_TOKEN[name]],
            ["POST", "rotated"],
          ]);
          expect(yield* job(fake)).toMatchObject({ state: "passed" });
        }).pipe(Effect.provide(fake.layer)),
      );
    });

    test("a retry that fails with a 5xx is sent exactly once", () => {
      const fake = jobbed({ httpFault: { status: 502 } });
      return runEffect(
        Effect.gen(function* () {
          const retried = yield* forge.retryJob(ref(name), jobId(name, 1), "/w", fake.run);
          expect(retried.ok).toBe(false);
          expect(retried.reason).toContain("502");
          expect(fake.requests).toHaveLength(1);
        }).pipe(Effect.provide(fake.layer)),
      );
    });

    test("a rate limit answers unavailable until its reset", () => {
      const fake = jobbed({
        httpFault: {
          status: 429,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(epochMs("2026-10-23T12:00:00Z") / 1000),
          },
        },
      });
      return runEffect(
        Effect.gen(function* () {
          const read = yield* job(fake);
          expect(read.ok).toBe(false);
          if (!read.ok) expect(read.reason).toContain("2026-10-23T12:00:00.000Z");
        }).pipe(Effect.provide(fake.layer)),
      );
    });

    test("a network failure answers unavailable", () => {
      const fake = jobbed({ httpFault: "network" });
      return runEffect(
        Effect.gen(function* () {
          const read = yield* job(fake);
          expect(read.ok).toBe(false);
          if (!read.ok) expect(read.reason).toContain("could not be reached");
        }).pipe(Effect.provide(fake.layer)),
      );
    });

    test("two calls on a cold cache make one credential read", () => {
      const fake = jobbed();
      return runEffect(
        Effect.gen(function* () {
          const [one, two] = yield* Effect.all([job(fake), job(fake)], { concurrency: 2 });
          expect(one.ok && two.ok).toBe(true);
          expect(fake.calls).toEqual([...READ_ONCE[name]]);
        }).pipe(Effect.provide(fake.layer)),
      );
    });

    test("interrupting a read aborts the request the forge holds open", () => {
      const fake = jobbed({ httpFault: "hold" });
      return runEffect(
        Effect.gen(function* () {
          const reading = yield* Effect.forkChild(job(fake));
          yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => fake.requests.length > 0 }));
          yield* Fiber.interrupt(reading);
          expect(fake.aborted).toEqual([fake.requests[0]!.url]);
        }).pipe(Effect.provide(fake.layer)),
      );
    });
  });
}

/** `read` against a fake forge over HTTP, which must run nothing but credential reads. */
const overHttp = <A>(
  forge: MrForge,
  over: Partial<ForgeModel>,
  read: (fake: ReturnType<typeof fakeForge>) => Effect.Effect<A, never, ForgeHttp>,
) => {
  const fake = fakeForge(forge, model(forge, over));
  return Effect.gen(function* () {
    const answer = yield* read(fake);
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.calls.filter((call) => !CREDENTIAL_READ.test(call))).toEqual([]);
    return answer;
  }).pipe(Effect.provide(fake.layer));
};

describe("GitHub's pull request reads over HTTP", () => {
  const github = FORGES.github;

  test("a pull request with auto-merge on is found from its branch with auto-merge on", () =>
    runEffect(
      Effect.gen(function* () {
        const found = yield* overHttp(
          "github",
          { mrs: [mr("github", { sourceBranch: "me/x", autoMerge: true })] },
          (fake) => github.forBranch(PROJECT.github, "me/x", "/w", fake.run),
        );
        expect(found).toEqual({
          ok: true,
          open: { iid: "30", url: "https://github.com/owner/repo/pull/30", autoMerge: true },
        });
      }),
    ));

  test("a draft that changes were requested on reads as a draft with changes requested", () =>
    runEffect(
      Effect.gen(function* () {
        const panel = yield* overHttp(
          "github",
          {
            reviewsRequired: { classic: 1 },
            mrs: [
              mr("github", {
                draft: true,
                reviews: [
                  { id: 1, author: "ann", state: "CHANGES_REQUESTED", at: "2026-10-20T12:00:00Z" },
                ],
              }),
            ],
          },
          (fake) => github.details(ref("github"), "/w", fake.run),
        );
        expect(panel).toMatchObject({ state: "draft", approvals: "changes requested" });
      }),
    ));

  test("a merged pull request reads with its merge commit", () =>
    runEffect(
      Effect.gen(function* () {
        const panel = yield* overHttp(
          "github",
          {
            mrs: [
              mr("github", {
                state: "merged",
                mergedSha: MERGED,
                mergedAt: "2026-10-15T08:00:00Z",
              }),
            ],
          },
          (fake) => github.details(ref("github"), "/w", fake.run),
        );
        expect(panel).toMatchObject({
          state: "merged",
          mergedSha: MERGED,
          mergedAt: "2026-10-15T08:00:00Z",
        });
      }),
    ));
});

describe("GitLab's merge request reads over HTTP", () => {
  test("a merge request whose discussions are unresolved reads as unresolved", () =>
    runEffect(
      Effect.gen(function* () {
        const panel = yield* overHttp(
          "gitlab",
          {
            mrs: [
              mr("gitlab", {
                comments: [
                  {
                    id: 7,
                    author: "ann",
                    body: "Rename this",
                    at: "2026-10-20T12:00:00Z",
                    thread: "t1",
                    file: "src/a.ts",
                    line: 3,
                  },
                ],
              }),
            ],
          },
          (fake) => gitlab.details(ref("gitlab"), "/w", fake.run),
        );
        expect(panel).toMatchObject({ _tag: "Details", unresolved: true });
      }),
    ));

  test("a branch with more than a page of merge requests has one on the second page found", () =>
    runEffect(
      Effect.gen(function* () {
        const closed = Array.from({ length: 100 }, (_, at) =>
          mr("gitlab", {
            iid: String(100 + at),
            state: "closed",
            sourceBranch: "me/x",
            createdAt: "2026-10-01T08:00:00Z",
            closedAt: "2026-10-01T09:00:00Z",
          }),
        );
        const listed = yield* overHttp(
          "gitlab",
          {
            mrs: [
              ...closed,
              mr("gitlab", {
                iid: "300",
                state: "merged",
                sourceBranch: "me/x",
                createdAt: "2026-10-15T08:00:00Z",
                mergedAt: "2026-10-15T08:40:00Z",
              }),
            ],
          },
          (fake) => gitlab.fromBranch(PROJECT.gitlab, "me/x", "/w", fake.run),
        );
        expect(listed.ok && listed.mrs.length).toBe(101);
        expect(listed.ok && listed.mrs.find((one) => one.iid === "300")).toEqual({
          iid: "300",
          url: "https://gitlab.example.com/group/app/-/merge_requests/300",
          state: "merged",
          created: "2026-10-15T08:00:00Z",
          ended: "2026-10-15T08:40:00Z",
        });
      }),
    ));
});

test("GitHub reads its panel through the served HTTP face", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bin = yield* FakeBin.make(yield* fs.makeTempDirectoryScoped({ prefix: "forge-http-" }));
      try {
        const fake = yield* forgeOnPath(
          bin,
          "github",
          model("github", { mrs: [mr("github", { draft: true, title: "Release health" })] }),
        );
        const api = yield* serveForges(fake);
        const panel = yield* FORGES.github
          .details(ref("github"), bin.dir, shell)
          .pipe(
            Effect.provide(forgeHttpLayer),
            Effect.provide(
              ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ COLLIE_FORGE_API: api })),
            ),
          );
        expect(panel).toMatchObject({ _tag: "Details", title: "Release health", state: "draft" });
        expect(yield* fake.calls()).toEqual([...READ_ONCE.github]);
      } finally {
        yield* bin.restore();
      }
    }),
  ));

for (const name of ["gitlab", "github"] as const)
  describe(`the ${name} forge's protection over HTTP`, () => {
    test("reads protection for an unpushed branch from a cold start, running only credential reads", () => {
      const fake = fakeForge(name, model(name, { protectedBranches: [{ name: "release/*" }] }));
      return runEffect(
        Effect.gen(function* () {
          expect(yield* FORGES[name].protects(PROJECT[name], "release/2.0", "/w", fake.run)).toBe(
            true,
          );
          expect(fake.requests.length).toBeGreaterThan(0);
          expect(fake.calls).toEqual([...READ_ONCE[name]]);
        }).pipe(Effect.provide(fake.layer)),
      );
    });

    for (const [failure, fault] of [
      ["403", { status: 403 }],
      ["network", "network"],
    ] as const)
      test(`answers unknown protection on ${failure}, never unprotected`, () =>
        runEffect(
          overHttp(name, { httpFault: fault }, (fake) =>
            FORGES[name].protects(PROJECT[name], "me/x", "/w", fake.run),
          ).pipe(Effect.map((protectedBranch) => expect(protectedBranch).toBeNull())),
        ));
  });

for (const name of ["gitlab", "github"] as const) {
  test(`the ${name} forge reads deployed over HTTP from a cold login`, () => {
    const fake = fakeForge(
      name,
      model(name, {
        environments: [
          { name: "production", tier: "production", deployed: "child", failed: "newer-failed" },
        ],
      }),
    );
    return runEffect(
      Effect.gen(function* () {
        expect(yield* FORGES[name].deployed(ref(name), "production", "/w", fake.run)).toEqual({
          ok: true,
          sha: "child",
        });
        expect(fake.requests.length).toBeGreaterThan(0);
        expect(fake.calls).toEqual([...READ_ONCE[name]]);
      }).pipe(Effect.provide(fake.layer)),
    );
  });

  test(`the ${name} forge reads liveTier over HTTP from a cold start, running only credential reads`, () => {
    const fake = fakeForge(
      name,
      model(name, {
        environments: [{ name: "production", tier: "production", deployed: "child" }],
        ancestry: { child: [MERGED] },
      }),
    );
    return runEffect(
      Effect.gen(function* () {
        expect(yield* FORGES[name].liveTier(ref(name), MERGED, "/w", fake.run)).toBe("production");
        expect(fake.requests.length).toBeGreaterThan(0);
        expect(fake.calls).toEqual([...READ_ONCE[name]]);
      }).pipe(Effect.provide(fake.layer)),
    );
  });
}

test("GitLab reads protection beyond the first page over HTTP", () =>
  runEffect(
    Effect.gen(function* () {
      const protectedBranch = yield* overHttp(
        "gitlab",
        {
          protectedBranches: [
            ...Array.from({ length: 100 }, (_, at) => ({ name: `preview-${at}` })),
            { name: "release/*" },
          ],
        },
        (fake) => FORGES.gitlab.protects(PROJECT.gitlab, "release/2.0", "/w", fake.run),
      );
      expect(protectedBranch).toBe(true);
    }),
  ));

describe("GitLab's OAuth login over HTTP", () => {
  test("glab's stored expiry is read in the zone it names, and one Collie cannot read is none", () => {
    expect(glabExpiry("23 Oct 26 10:00 UTC")).toBe(epochMs("2026-10-23T10:00:00Z"));
    expect(glabExpiry("23 Oct 26 12:00 +0200")).toBe(epochMs("2026-10-23T10:00:00Z"));
    expect(glabExpiry("23 Oct 26 05:30 -0430")).toBe(epochMs("2026-10-23T10:00:00Z"));
    expect(glabExpiry("2026-10-23T10:00:00Z")).toBeNull();
    expect(glabExpiry("23 Okt 26 10:00 UTC")).toBeNull();
  });

  const oauth = (expiry: number, over: Partial<ForgeModel> = {}) =>
    fakeForge(
      "gitlab",
      model("gitlab", {
        mrs: [mr("gitlab", { jobs: [{ name: "nuxi-typecheck", state: "passed" }] })],
        oauth: { token: "oauth-1", expiry: rfc822(expiry) },
        ...over,
      }),
    );
  const job = (fake: ReturnType<typeof oauth>) =>
    gitlab.job(ref("gitlab"), "nuxi-typecheck", "/w", fake.run);

  test("normal and stored-login reads serialize an expired host's credentials", () => {
    const start = epochMs("2026-10-23T10:00:00Z");
    const fake = oauth(start - 3_600_000, {
      runs: { "7": { status: "success", ref: "v1.2.0", sha: MERGED, jobs: [] } },
    });
    let active = 0;
    let mostActive = 0;
    const run: Runner = (cmd, args, cwd) =>
      Effect.gen(function* () {
        active++;
        mostActive = Math.max(mostActive, active);
        yield* Effect.yieldNow;
        const ran = yield* fake.run(cmd, args, cwd);
        active--;
        return ran;
      });
    return runEffect(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        yield* clock.setTime(start);
        const [job, status, pipeline] = yield* Effect.all(
          [
            gitlab.job(ref("gitlab"), "nuxi-typecheck", "/w", run),
            gitlab.runStatus(URLS.gitlab.run, "/w", run),
            gitlab.pipeline(URLS.gitlab.run, "/w", run),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.provideService(Clock.Clock, clock));
        expect(job).toMatchObject({ ok: true, state: "passed" });
        expect(status).toBe("success");
        expect(pipeline).toMatchObject({ ok: true, succeeded: true });
        expect(mostActive).toBe(1);
        expect(new Set(fake.requests.map((one) => one.token))).toEqual(
          new Set(["oauth-1-refreshed"]),
        );
      }).pipe(Effect.provide(forgeHttpTest(run, fake.fetch))),
    );
  });

  test("an expired token is refreshed through glab before the token is read, and only the new one is sent", () => {
    const start = epochMs("2026-10-23T10:00:00Z");
    const fake = oauth(start - 3_600_000);
    return runEffect(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        yield* clock.setTime(start);
        expect(yield* job(fake).pipe(Effect.provideService(Clock.Clock, clock))).toMatchObject({
          ok: true,
          state: "passed",
        });
        const refreshed = fake.calls.indexOf("glab auth status --hostname gitlab.example.com");
        expect(refreshed).toBeGreaterThanOrEqual(0);
        expect(refreshed).toBeLessThan(
          fake.calls.indexOf("glab config get token --host gitlab.example.com"),
        );
        expect(new Set(fake.requests.map((one) => one.token))).toEqual(
          new Set(["oauth-1-refreshed"]),
        );
      }).pipe(Effect.provide(fake.layer)),
    );
  });

  test("a cached token whose expiry passes is refreshed before the next request, with no 401 first", () => {
    const start = epochMs("2026-10-23T10:00:00Z");
    const fake = oauth(start + 1_800_000);
    return runEffect(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        yield* clock.setTime(start);
        yield* Effect.gen(function* () {
          expect(yield* job(fake)).toMatchObject({ ok: true });
          const first = fake.requests.length;
          yield* clock.adjust(3_600_000);
          fake.requests.length = 0;
          expect(yield* job(fake)).toMatchObject({ ok: true });
          expect(fake.calls).toContain("glab auth status --hostname gitlab.example.com");
          expect(fake.requests).toHaveLength(first);
          expect(new Set(fake.requests.map((one) => one.token))).toEqual(
            new Set(["oauth-1-refreshed"]),
          );
        }).pipe(Effect.provideService(Clock.Clock, clock));
      }).pipe(Effect.provide(fake.layer)),
    );
  });

  test("a pipeline on a host glab holds no login for is never asked about, whatever token the environment holds", () => {
    const fake = fakeForge("gitlab", model("gitlab", { envToken: "from-the-environment" }));
    return runEffect(
      Effect.gen(function* () {
        expect(
          (yield* fake.run("glab", ["config", "get", "token", "--host", "elsewhere.example"], "/w"))
            .stdout,
        ).toBe("from-the-environment\n");
        expect(
          yield* gitlab.runStatus("https://elsewhere.example/x/y/-/pipelines/1", "/w", fake.run),
        ).toBeNull();
        expect(fake.requests).toEqual([]);
      }).pipe(Effect.provide(fake.layer)),
    );
  });
});

const gated = () =>
  fakeForge(
    "github",
    model("github", {
      mrs: [
        mr("github", {
          jobs: [
            { name: "suite (1)", state: "failed", retried: "passed" },
            { name: "suite (2)", state: "passed" },
            { name: "test", state: "failed", retried: "passed" },
          ],
        }),
      ],
    }),
  );

const gateId = (fake: ReturnType<typeof gated>) =>
  Effect.map(FORGES.github.job(ref("github"), "test", "/w", fake.run), (read) =>
    read.ok && read.id !== null ? read.id : "unread",
  );

test("a failed GitHub gate job is retried by rerunning its workflow run's failed jobs", () => {
  const github = FORGES.github;
  const fake = gated();
  return runEffect(
    Effect.gen(function* () {
      const job = (name: string) => github.job(ref("github"), name, "/w", fake.run);
      expect(yield* github.retryJob(ref("github"), yield* gateId(fake), "/w", fake.run)).toEqual({
        ok: true,
        reason: "",
      });
      expect(yield* job("suite (1)")).toMatchObject({ state: "passed" });
      expect(yield* job("test")).toMatchObject({ state: "passed" });
      expect(
        fake.requests
          .filter((one) => one.method === "POST")
          .map((one) => new URL(one.url).pathname),
      ).toEqual(["/repos/owner/repo/actions/runs/4030/rerun-failed-jobs"]);
    }).pipe(Effect.provide(fake.layer)),
  );
});

test("a failed GitHub job's log command prints its workflow run's failed jobs", () => {
  const fake = gated();
  return runEffect(
    Effect.gen(function* () {
      expect(FORGES.github.jobLog(ref("github"), yield* gateId(fake))).toBe(
        "gh run view 4030 --log-failed --repo owner/repo",
      );
    }).pipe(Effect.provide(fake.layer)),
  );
});
