import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { beforeEach, afterEach, expect, test } from "bun:test";
import { ConfigProvider, Duration, Effect, FileSystem, Result, Schema, flow } from "effect";
import { Rig, FakeHerdr } from "./support/recorder";
import { runEffect } from "./support/effect";
import { exec } from "./support/command";
import { FakeBin } from "./support/bin";
import { forgeOnPath, serveForges, PROJECT, FORGE_HOST } from "./support/forge";
import { foundationLayer, registryLayer, Registry, evidenceDir, runDir } from "../src/engine";
import { recordAudit } from "../src/audit";
import { noteContext } from "../src/metrics";
import { until } from "./support/host";
import { nowIso } from "../src/time";
import { agentsLayer } from "../src/agents";
import { WorkflowError } from "../src/sdk";
import * as Layer from "effect/Layer";

let rig: Rig;
let forgeApi = "";
beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      forgeApi = "";
    }),
  ),
);
afterEach(() => runEffect(rig.close()));

const json = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Json)), Result.getOrThrow);
const fakeAgents = () =>
  agentsLayer({
    dir: rig.stateDir,
    env: rig.pluginEnv(),
    herdr: new FakeHerdr(rig.pluginEnv()),
    harness: "claude",
    model: "opus",
    permissions: "auto",
    compactAtTokens: 0,
    help: () => Effect.succeed("--autocompact"),
  });
const withMachine = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  issuePrivacyBudget?: Duration.Input,
) =>
  effect.pipe(
    Effect.provide(
      registryLayer(rig.stateDir, {
        userDir: rig.userDir,
        placing: {
          herdr: new FakeHerdr(rig.pluginEnv()),
          env: rig.pluginEnv(),
        },
      }).pipe(
        Layer.provideMerge(fakeAgents()),
        Layer.provideMerge(
          foundationLayer({
            dir: rig.stateDir,
            userDir: rig.userDir,
            placing: {
              herdr: new FakeHerdr(rig.pluginEnv()),
              env: rig.pluginEnv(),
            },
            issuePrivacyBudget,
          }),
        ),
        Layer.provideMerge(
          ConfigProvider.layerAdd(
            ConfigProvider.fromUnknown({
              COLLIE_FORGE_API: forgeApi,
            }),
            {
              asPrimary: true,
            },
          ),
        ),
      ),
    ),
    Effect.scoped,
  );
const repository = (cwd: string, remote: string) =>
  Effect.gen(function* () {
    expect((yield* exec(["git", "init", "--quiet", cwd])).exitCode).toBe(0);
    expect((yield* exec(["git", "-C", cwd, "remote", "add", "origin", remote])).exitCode).toBe(0);
  });

test(
  "a Workflow reads its Machine's report inclusively since a moment, with parent and status",
  () =>
    runEffect(
      Effect.gen(function* () {
        const registry = yield* Registry;
        const generation = yield* registry.load(
          new URL("./fixtures/workflows/issues.workflow.ts", import.meta.url).pathname,
        );
        const old = yield* registry.start({
          generation,
          runId: "old",
          request: "old",
          project: rig.projectDir,
          input: { operation: "report", text: "2000-01-01T00:00:00Z" },
          handsOver: true,
        });
        const before = yield* registry.view(old.runId);
        if (before === null) throw new Error("old Run is missing");
        yield* until(
          () => nowIso,
          (now) => now > before.created,
        );
        const child = yield* registry.start({
          generation,
          runId: "child",
          request: "child",
          parent: old.runId,
          project: rig.projectDir,
          input: { operation: "report", text: "2000-01-01T00:00:00Z" },
          handsOver: true,
        });
        const childView = yield* registry.view(child.runId);
        if (childView === null) throw new Error("child Run is missing");
        const since = childView.created;
        const reading = yield* registry.start({
          generation,
          runId: "reader",
          request: "reader",
          project: rig.projectDir,
          input: { operation: "report", text: since },
          handsOver: true,
        });
        expect(yield* registry.result(reading.runId)).toMatchObject({
          since,
          total: 2,
          runs: [
            {
              runId: "child",
              workflow: "issues",
              parent: "old",
              project: rig.projectDir,
              status: "pending",
              created: since,
            },
            {
              runId: "reader",
              workflow: "issues",
              parent: null,
              project: rig.projectDir,
              status: "pending",
            },
          ],
          workflows: [{ workflow: "issues", total: 2, pending: 2 }],
        });
      }).pipe(withMachine),
    ),
  30_000,
);

test(
  "a Workflow's report measures what each Run recorded, as the CLI's does",
  () =>
    runEffect(
      Effect.gen(function* () {
        const registry = yield* Registry;
        const generation = yield* registry.load(
          new URL("./fixtures/workflows/issues.workflow.ts", import.meta.url).pathname,
        );
        const subject = yield* registry.start({
          generation,
          runId: "subject",
          request: "subject",
          project: rig.projectDir,
          input: { operation: "report", text: "2000-01-01T00:00:00Z" },
          handsOver: true,
        });
        yield* recordAudit(runDir(rig.stateDir, subject.runId), {
          operation: "steer",
          request: "s-1",
          origin: "chat",
          result: Schema.String,
          value: "steered",
        });
        yield* noteContext(
          evidenceDir(rig.stateDir, subject.runId),
          yield* nowIso,
          "subject-build",
          123_456,
        );
        const reading = yield* registry.start({
          generation,
          runId: "reader",
          request: "reader",
          project: rig.projectDir,
          input: { operation: "report", text: "2000-01-01T00:00:00Z" },
          handsOver: true,
        });
        expect(yield* registry.result(reading.runId)).toMatchObject({
          measures: {
            steering: {
              runs: expect.arrayContaining([
                expect.objectContaining({ runId: "subject", steer: 1 }),
              ]),
            },
            peakContext: expect.arrayContaining([
              { runId: "subject", tokens: 123_456, agent: "subject-build" },
            ]),
          },
        });
      }).pipe(withMachine),
    ),
  30_000,
);

test(
  "an unrelated source project is private when the Run works in another checkout",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* repository(rig.projectDir, `https://${PROJECT.github}.git`);
        const source = `${rig.root}/source`;
        yield* repository(source, "https://gitlab.example.com/private/source.git");
        yield* fs.writeFileString(
          `${rig.userDir}/config.json`,
          json({ projects: { root: rig.root } }),
        );
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        try {
          const fake = yield* forgeOnPath(bin, "github", {
            installed: true,
            loggedIn: [FORGE_HOST.github],
            login: "me",
            mrs: [],
          });
          forgeApi = yield* serveForges(fake);
          yield* Effect.gen(function* () {
            const registry = yield* Registry;
            const generation = yield* registry.load(
              new URL("./fixtures/workflows/issues.workflow.ts", import.meta.url).pathname,
            );
            for (const text of [source, "private/source"]) {
              const run = yield* registry.start({
                generation,
                request: text,
                project: source,
                options: { workspace: rig.projectDir },
                input: { operation: "file", text },
                handsOver: true,
              });
              expect((yield* registry.view(run.runId))?.cwd).toBe(rig.projectDir);
              const answer = yield* registry.result(run.runId).pipe(Effect.result);
              expect(
                Arr.filter(fake.requests(), (one) => /\/issues(?:[/?]|$)/.test(one.url)),
              ).toEqual([]);
              expect(Result.isFailure(answer)).toBe(true);
              if (Result.isFailure(answer)) expect(answer.failure.reason).toContain(source);
            }
          }).pipe(withMachine);
          expect(
            Arr.filter(yield* fake.calls(), (line) => pipe_(line, Str.startsWith("gh issue"))),
          ).toEqual([]);
          expect(Arr.filter(fake.requests(), (one) => /\/issues(?:[/?]|$)/.test(one.url))).toEqual(
            [],
          );
        } finally {
          yield* bin.restore();
        }
      }),
    ),
  30_000,
);

test(
  "a directory under the Projects root that Git cannot open does not block filing, unless the text names it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* repository(rig.projectDir, `https://${PROJECT.github}.git`);
        const notRepository = `${rig.root}/.tool/cache/copied`;
        yield* fs.makeDirectory(`${notRepository}/.git`, { recursive: true });
        const brokenGit = `${rig.root}/.tool/cache/plugin`;
        yield* fs.makeDirectory(brokenGit, { recursive: true });
        yield* fs.writeFileString(`${brokenGit}/.git`, "gitdir: ../../.git/modules/plugin\n");
        yield* fs.writeFileString(
          `${rig.userDir}/config.json`,
          json({ projects: { root: rig.root } }),
        );
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        try {
          const fake = yield* forgeOnPath(bin, "github", {
            installed: true,
            loggedIn: [FORGE_HOST.github],
            login: "me",
            mrs: [],
          });
          forgeApi = yield* serveForges(fake);
          yield* Effect.gen(function* () {
            const registry = yield* Registry;
            const generation = yield* registry.load(
              new URL("./fixtures/workflows/issues.workflow.ts", import.meta.url).pathname,
            );
            const filed = yield* registry.start({
              generation,
              request: "file",
              project: rig.projectDir,
              input: { operation: "file", text: "Evidence" },
              handsOver: true,
            });
            expect(yield* registry.result(filed.runId)).toMatchObject({ number: 1 });
            for (const named of [notRepository, brokenGit]) {
              const run = yield* registry.start({
                generation,
                request: named,
                project: rig.projectDir,
                input: { operation: "file", text: `Seen in ${named}/file` },
                handsOver: true,
              });
              const answer = yield* registry.result(run.runId).pipe(Effect.result);
              expect(Result.isFailure(answer)).toBe(true);
              if (Result.isFailure(answer))
                expect(answer.failure.reason).toBe(`issue text names another checkout: ${named}`);
            }
          }).pipe(withMachine);
          expect((yield* fake.model()).issues).toHaveLength(1);
        } finally {
          yield* bin.restore();
        }
      }),
    ),
  30_000,
);

for (const state of ["bare", "unreadable"] as const) {
  test(
    `a real repository Git calls ${state} under the Projects root still guards its remote`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* repository(rig.projectDir, `https://${PROJECT.github}.git`);
          const other = `${rig.root}/private`;
          yield* repository(other, "https://gitlab.example.com/private/service.git");
          if (state === "bare")
            expect(
              (yield* exec(["git", "-C", other, "config", "core.bare", "true"])).exitCode,
            ).toBe(0);
          else yield* fs.writeFileString(`${other}/.git/config`, "[broken\n");
          yield* fs.writeFileString(
            `${rig.userDir}/config.json`,
            json({ projects: { root: rig.root } }),
          );
          const bin = yield* FakeBin.make(`${rig.root}/bin`);
          try {
            const fake = yield* forgeOnPath(bin, "github", {
              installed: true,
              loggedIn: [FORGE_HOST.github],
              login: "me",
              mrs: [],
            });
            forgeApi = yield* serveForges(fake);
            yield* Effect.gen(function* () {
              const registry = yield* Registry;
              const generation = yield* registry.load(
                new URL("./fixtures/workflows/issues.workflow.ts", import.meta.url).pathname,
              );
              const run = yield* registry.start({
                generation,
                request: "file",
                project: rig.projectDir,
                input: { operation: "file", text: "Seen in private/service" },
                handsOver: true,
              });
              const answer = yield* registry.result(run.runId).pipe(Effect.result);
              expect(
                Arr.filter(fake.requests(), (one) => /\/issues(?:[/?]|$)/.test(one.url)),
              ).toEqual([]);
              expect(Result.isFailure(answer)).toBe(true);
              if (Result.isFailure(answer))
                expect(answer.failure.reason).toBe(
                  state === "bare"
                    ? `issue text names another checkout: ${other}`
                    : `issue privacy check could not read remotes: ${other}`,
                );
            }).pipe(withMachine);
            expect(
              Arr.filter(yield* fake.calls(), (line) => pipe_(line, Str.startsWith("gh issue"))),
            ).toEqual([]);
            expect(
              Arr.filter(fake.requests(), (one) => /\/issues(?:[/?]|$)/.test(one.url)),
            ).toEqual([]);
          } finally {
            yield* bin.restore();
          }
        }),
      ),
    30_000,
  );
}

for (const metadata of [" metadata", "metadata "]) {
  test(
    `a real repository whose gitfile names ${JSON.stringify(metadata)} still guards its remote`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* repository(rig.projectDir, `https://${PROJECT.github}.git`);
          const other = `${rig.root}/private`;
          yield* repository(other, "https://gitlab.example.com/private/service.git");
          yield* fs.rename(`${other}/.git`, `${other}/${metadata}`);
          yield* fs.writeFileString(`${other}/.git`, `gitdir: ${metadata}\n`);
          expect((yield* exec(["git", "-C", other, "remote", "-v"])).exitCode).toBe(0);
          yield* fs.writeFileString(
            `${rig.userDir}/config.json`,
            json({ projects: { root: rig.root } }),
          );
          const bin = yield* FakeBin.make(`${rig.root}/bin`);
          try {
            const fake = yield* forgeOnPath(bin, "github", {
              installed: true,
              loggedIn: [FORGE_HOST.github],
              login: "me",
              mrs: [],
            });
            forgeApi = yield* serveForges(fake);
            yield* Effect.gen(function* () {
              const registry = yield* Registry;
              const generation = yield* registry.load(
                new URL("./fixtures/workflows/issues.workflow.ts", import.meta.url).pathname,
              );
              const run = yield* registry.start({
                generation,
                request: "file",
                project: rig.projectDir,
                input: { operation: "file", text: "Seen in private/service" },
                handsOver: true,
              });
              const answer = yield* registry.result(run.runId).pipe(Effect.result);
              expect(
                Arr.filter(fake.requests(), (one) => /\/issues(?:[/?]|$)/.test(one.url)),
              ).toEqual([]);
              expect(Result.isFailure(answer)).toBe(true);
              if (Result.isFailure(answer))
                expect(answer.failure.reason).toBe(`issue text names another checkout: ${other}`);
            }).pipe(withMachine);
            expect(
              Arr.filter(yield* fake.calls(), (line) => pipe_(line, Str.startsWith("gh issue"))),
            ).toEqual([]);
            expect(
              Arr.filter(fake.requests(), (one) => /\/issues(?:[/?]|$)/.test(one.url)),
            ).toEqual([]);
          } finally {
            yield* bin.restore();
          }
        }),
      ),
    30_000,
  );
}

test(
  "the Run's own checkout, linked and with a relative gitfile, may be named by its link",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* repository(rig.projectDir, `https://${PROJECT.github}.git`);
        yield* fs.rename(`${rig.projectDir}/.git`, `${rig.root}/meta`);
        yield* fs.writeFileString(`${rig.projectDir}/.git`, "gitdir: ../meta\n");
        const alias = `${rig.root}/links/project`;
        yield* fs.makeDirectory(`${rig.root}/links`);
        yield* fs.symlink(rig.projectDir, alias);
        yield* fs.writeFileString(
          `${rig.userDir}/config.json`,
          json({ projects: { root: rig.root } }),
        );
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        try {
          const fake = yield* forgeOnPath(bin, "github", {
            installed: true,
            loggedIn: [FORGE_HOST.github],
            login: "me",
            mrs: [],
          });
          forgeApi = yield* serveForges(fake);
          yield* Effect.gen(function* () {
            const registry = yield* Registry;
            const generation = yield* registry.load(
              new URL("./fixtures/workflows/issues.workflow.ts", import.meta.url).pathname,
            );
            const run = yield* registry.start({
              generation,
              request: "file",
              project: rig.projectDir,
              input: { operation: "file", text: `Seen in ${alias}/file` },
              handsOver: true,
            });
            expect(yield* registry.result(run.runId)).toMatchObject({ number: 1 });
          }).pipe(withMachine);
          expect((yield* fake.model()).issues).toHaveLength(1);
        } finally {
          yield* bin.restore();
        }
      }),
    ),
  30_000,
);

for (const failure of ["configuration", "inventory"] as const) {
  test(
    `the host refuses with a recordable error when its ${failure} cannot be inspected`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* repository(rig.projectDir, `https://${PROJECT.github}.git`);
          const bin = yield* FakeBin.make(`${rig.root}/bin`);
          try {
            const fake = yield* forgeOnPath(bin, "github", {
              installed: true,
              loggedIn: [FORGE_HOST.github],
              login: "me",
              mrs: [],
            });
            forgeApi = yield* serveForges(fake);
            yield* Effect.gen(function* () {
              const registry = yield* Registry;
              const generation = yield* registry.load(
                new URL("./fixtures/workflows/issues.workflow.ts", import.meta.url).pathname,
              );
              const run = yield* registry.start({
                generation,
                request: "file",
                project: rig.projectDir,
                input: { operation: "file", text: "Evidence" },
                handsOver: true,
              });
              yield* fs.writeFileString(
                `${rig.userDir}/config.json`,
                failure === "configuration"
                  ? "invalid JSON"
                  : json({ projects: { root: `${rig.root}/absent` } }),
              );
              const answer = yield* registry.result(run.runId).pipe(Effect.result);
              expect(
                Arr.filter(fake.requests(), (one) => /\/issues(?:[/?]|$)/.test(one.url)),
              ).toEqual([]);
              expect(Result.isFailure(answer)).toBe(true);
              if (Result.isFailure(answer)) {
                expect(Schema.is(WorkflowError)(answer.failure)).toBe(true);
                expect(answer.failure.reason).toContain(
                  failure === "configuration" ? "configuration" : "privacy check failed",
                );
              }
            }).pipe(withMachine);
            expect(
              Arr.filter(yield* fake.calls(), (line) => pipe_(line, Str.startsWith("gh issue"))),
            ).toEqual([]);
            expect(
              Arr.filter(fake.requests(), (one) => /\/issues(?:[/?]|$)/.test(one.url)),
            ).toEqual([]);
          } finally {
            yield* bin.restore();
          }
        }),
      ),
    30_000,
  );
}

for (const forge of ["github", "gitlab"] as const) {
  test(
    `a Workflow files and comments on ${forge} issues with its host's redaction`,
    () =>
      runEffect(
        Effect.gen(function* () {
          yield* repository(rig.projectDir, `https://${PROJECT[forge]}.git`);
          const bin = yield* FakeBin.make(`${rig.root}/bin`);
          try {
            const fake = yield* forgeOnPath(bin, forge, {
              installed: true,
              loggedIn: [FORGE_HOST[forge]],
              login: "me",
              mrs: [],
              issues: [
                {
                  project: PROJECT[forge],
                  number: 1,
                  title: "Existing",
                  body: "Earlier",
                  state: "open",
                },
              ],
            });
            forgeApi = yield* serveForges(fake);
            const answers = yield* Effect.gen(function* () {
              const registry = yield* Registry;
              const generation = yield* registry.load(
                new URL("./fixtures/workflows/issues.workflow.ts", import.meta.url).pathname,
              );
              const results: unknown[] = [];
              for (const operation of ["file", "comment", "list"]) {
                const run = yield* registry.start({
                  generation,
                  request: operation,
                  project: rig.projectDir,
                  input: {
                    operation,
                    text: `Found ghp_abcdefghijklmnopqrstu in ${PROJECT[forge]}`,
                  },
                  handsOver: true,
                });
                results.push(yield* registry.result(run.runId));
              }
              return results;
            }).pipe(withMachine);
            expect(answers[0]).toMatchObject({ number: 2 });
            expect((yield* fake.model()).issues?.at(-1)?.body).toBe(
              `Found <github token> in ${PROJECT[forge]}`,
            );
            expect((yield* fake.model()).issueNotes).toEqual({
              [`${PROJECT[forge]}#1`]: [`Found <github token> in ${PROJECT[forge]}`],
            });
            expect(answers[2]).toMatchObject([{ number: 1 }, { number: 2 }]);
          } finally {
            yield* bin.restore();
          }
        }),
      ),
    30_000,
  );
}

test(
  "a stopped Run files nothing, and its forge hears nothing of it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* repository(rig.projectDir, `https://${PROJECT.github}.git`);
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        try {
          const fake = yield* forgeOnPath(bin, "github", {
            installed: true,
            loggedIn: [FORGE_HOST.github],
            login: "me",
            mrs: [],
          });
          forgeApi = yield* serveForges(fake);
          const gate = `${rig.root}/gate`;
          const answer = yield* Effect.gen(function* () {
            const registry = yield* Registry;
            const generation = yield* registry.load(
              new URL("./fixtures/workflows/issues.workflow.ts", import.meta.url).pathname,
            );
            const run = yield* registry.start({
              generation,
              request: "gated",
              project: rig.projectDir,
              input: { operation: "file-when-open", text: gate },
              handsOver: true,
            });
            yield* registry.control({ runId: run.runId, control: "stop", set: true });
            yield* fs.writeFileString(gate, "");
            return yield* registry.result(run.runId).pipe(Effect.result);
          }).pipe(withMachine);
          expect(Result.isFailure(answer)).toBe(true);
          if (Result.isFailure(answer)) expect(answer.failure.reason).toContain("stopped");
          expect(Arr.filter(fake.requests(), (one) => /\/issues(?:[/?]|$)/.test(one.url))).toEqual(
            [],
          );
          expect((yield* fake.model()).issues ?? []).toEqual([]);
        } finally {
          yield* bin.restore();
        }
      }),
    ),
  30_000,
);

test(
  "the host refuses another checkout's path and remote before filing or commenting",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* repository(rig.projectDir, `https://${PROJECT.github}.git`);
        const other = `${rig.root}/private`;
        yield* repository(other, "https://gitlab.example.com/private/service.git");
        const hidden = `${rig.root}/.private/service`;
        yield* repository(hidden, "https://gitlab.example.com/private/hidden.git");
        expect(
          (yield* exec([
            "git",
            "-C",
            hidden,
            "remote",
            "add",
            "secondary",
            "ssh://git@internal:2222/private/secondary.git",
          ])).exitCode,
        ).toBe(0);
        const deep = `${rig.root}/a/b/c/d/e/service`;
        yield* repository(deep, "https://internal:8443/private/deep.git");
        const samePath = `${rig.root}/same-path`;
        const ownPath = Arr.join(Str.split(PROJECT.github, "/").slice(1), "/");
        yield* repository(samePath, `git@internal:${ownPath}.git`);
        const nested = `${rig.projectDir}/nested`;
        yield* repository(nested, "https://gitlab.example.com/private/nested.git");
        const alias = `${rig.root}/alias`;
        yield* fs.symlink(`${rig.root}/.private`, alias);
        yield* fs.writeFileString(
          `${rig.userDir}/config.json`,
          json({ projects: { root: rig.root } }),
        );
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        try {
          const fake = yield* forgeOnPath(bin, "github", {
            installed: true,
            loggedIn: [FORGE_HOST.github],
            login: "me",
            mrs: [],
            issues: [
              {
                project: PROJECT.github,
                number: 1,
                title: "Existing",
                body: "Earlier",
                state: "open",
              },
            ],
          });
          forgeApi = yield* serveForges(fake);
          yield* Effect.gen(function* () {
            const registry = yield* Registry;
            const generation = yield* registry.load(
              new URL("./fixtures/workflows/issues.workflow.ts", import.meta.url).pathname,
            );
            for (const operation of ["file", "comment"]) {
              yield* Effect.forEach(
                [
                  [other, other],
                  ["private/service", other],
                  [hidden, hidden],
                  ["private/hidden", hidden],
                  ["private/secondary", hidden],
                  [deep, deep],
                  ["private/deep", deep],
                  [`internal/${ownPath}`, samePath],
                  [`git@internal:${ownPath}.git`, samePath],
                  [nested, nested],
                  ["private/nested", nested],
                  [`${alias}/service`, hidden],
                ] as const,
                ([text, checkout]) =>
                  Effect.gen(function* () {
                    const run = yield* registry.start({
                      generation,
                      request: `${operation}-${text}`,
                      project: rig.projectDir,
                      input: { operation, text },
                      handsOver: true,
                    });
                    const answer = yield* registry.result(run.runId).pipe(Effect.result);
                    expect(
                      Arr.filter(fake.requests(), (one) => /\/issues(?:[/?]|$)/.test(one.url)),
                    ).toEqual([]);
                    expect(Result.isFailure(answer)).toBe(true);
                    if (Result.isFailure(answer)) expect(answer.failure.reason).toContain(checkout);
                  }),
                { concurrency: 3 },
              );
            }
          }).pipe(withMachine);
          expect(
            Arr.filter(yield* fake.calls(), (line) => pipe_(line, Str.startsWith("gh issue"))),
          ).toEqual([]);
          expect(Arr.filter(fake.requests(), (one) => /\/issues(?:[/?]|$)/.test(one.url))).toEqual(
            [],
          );
          expect((yield* fake.model()).issues).toHaveLength(1);
          expect((yield* fake.model()).issueNotes).toBeUndefined();
        } finally {
          yield* bin.restore();
        }
      }),
    ),
  30_000,
);

test(
  "a sibling checkout outside the Projects root that another Run worked in is still private",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* repository(rig.projectDir, `https://${PROJECT.github}.git`);
        const sibling = `${rig.root}/sibling`;
        yield* repository(sibling, "https://gitlab.example.com/private/sibling.git");
        yield* fs.makeDirectory(`${rig.root}/projects`);
        yield* fs.writeFileString(
          `${rig.userDir}/config.json`,
          json({ projects: { root: `${rig.root}/projects` } }),
        );
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        try {
          const fake = yield* forgeOnPath(bin, "github", {
            installed: true,
            loggedIn: [FORGE_HOST.github],
            login: "me",
            mrs: [],
          });
          forgeApi = yield* serveForges(fake);
          yield* Effect.gen(function* () {
            const registry = yield* Registry;
            const generation = yield* registry.load(
              new URL("./fixtures/workflows/issues.workflow.ts", import.meta.url).pathname,
            );
            yield* registry.start({
              generation,
              request: "elsewhere",
              project: sibling,
              input: { operation: "report", text: "2000-01-01T00:00:00Z" },
              handsOver: true,
            });
            const run = yield* registry.start({
              generation,
              request: "file",
              project: rig.projectDir,
              input: { operation: "file", text: "Seen in private/sibling" },
              handsOver: true,
            });
            const answer = yield* registry.result(run.runId).pipe(Effect.result);
            expect(
              Arr.filter(fake.requests(), (one) => /\/issues(?:[/?]|$)/.test(one.url)),
            ).toEqual([]);
            expect(Result.isFailure(answer)).toBe(true);
            if (Result.isFailure(answer))
              expect(answer.failure.reason).toBe(`issue text names another checkout: ${sibling}`);
          }).pipe(withMachine);
          expect(
            Arr.filter(yield* fake.calls(), (line) => pipe_(line, Str.startsWith("gh issue"))),
          ).toEqual([]);
          expect(Arr.filter(fake.requests(), (one) => /\/issues(?:[/?]|$)/.test(one.url))).toEqual(
            [],
          );
        } finally {
          yield* bin.restore();
        }
      }),
    ),
  30_000,
);

test(
  "findings filed one after another share one walk of the Projects root",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* repository(rig.projectDir, `https://${PROJECT.github}.git`);
        yield* fs.writeFileString(
          `${rig.userDir}/config.json`,
          json({ projects: { root: rig.root } }),
        );
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        try {
          const fake = yield* forgeOnPath(bin, "github", {
            installed: true,
            loggedIn: [FORGE_HOST.github],
            login: "me",
            mrs: [],
          });
          forgeApi = yield* serveForges(fake);
          yield* Effect.gen(function* () {
            const registry = yield* Registry;
            const generation = yield* registry.load(
              new URL("./fixtures/workflows/issues.workflow.ts", import.meta.url).pathname,
            );
            const file = (text: string) =>
              registry
                .start({
                  generation,
                  request: text,
                  project: rig.projectDir,
                  input: { operation: "file", text },
                  handsOver: true,
                })
                .pipe(Effect.flatMap((run) => registry.result(run.runId)));
            yield* file("First finding");
            yield* repository(
              `${rig.root}/unwalked`,
              "https://gitlab.example.com/private/unwalked.git",
            );
            yield* file("Seen in private/unwalked");
          }).pipe(withMachine);
          expect((yield* fake.model()).issues).toHaveLength(2);
        } finally {
          yield* bin.restore();
        }
      }),
    ),
  30_000,
);

test(
  "an inventory that outlasts its budget refuses the issue with a recordable error",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* repository(rig.projectDir, `https://${PROJECT.github}.git`);
        yield* fs.writeFileString(
          `${rig.userDir}/config.json`,
          json({ projects: { root: rig.root } }),
        );
        const git = Bun.which("git");
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        try {
          const fake = yield* forgeOnPath(bin, "github", {
            installed: true,
            loggedIn: [FORGE_HOST.github],
            login: "me",
            mrs: [],
          });
          forgeApi = yield* serveForges(fake);
          yield* bin.add("git", `[ "$*" = "remote -v" ] && exec sleep 5\nexec "${git}" "$@"`);
          yield* Effect.gen(function* () {
            const registry = yield* Registry;
            const generation = yield* registry.load(
              new URL("./fixtures/workflows/issues.workflow.ts", import.meta.url).pathname,
            );
            const run = yield* registry.start({
              generation,
              request: "file",
              project: rig.projectDir,
              input: { operation: "file", text: "Evidence" },
              handsOver: true,
            });
            const answer = yield* registry.result(run.runId).pipe(Effect.result);
            expect(
              Arr.filter(fake.requests(), (one) => /\/issues(?:[/?]|$)/.test(one.url)),
            ).toEqual([]);
            expect(Result.isFailure(answer)).toBe(true);
            if (Result.isFailure(answer)) {
              expect(Schema.is(WorkflowError)(answer.failure)).toBe(true);
              expect(answer.failure.reason).toBe("issue privacy check did not finish within 200ms");
            }
          }).pipe((effect) => withMachine(effect, "200 millis"));
          expect(
            Arr.filter(yield* fake.calls(), (line) => pipe_(line, Str.startsWith("gh issue"))),
          ).toEqual([]);
          expect(Arr.filter(fake.requests(), (one) => /\/issues(?:[/?]|$)/.test(one.url))).toEqual(
            [],
          );
        } finally {
          yield* bin.restore();
        }
      }),
    ),
  30_000,
);

test(
  "a checkout recorded, or a remote added or included, after an inventory was read is still private",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* repository(rig.projectDir, `https://${PROJECT.github}.git`);
        const walked = `${rig.root}/projects/walked`;
        yield* repository(walked, "https://gitlab.example.com/private/walked.git");
        const included = `${rig.root}/included.config`;
        yield* fs.writeFileString(included, "");
        expect(
          (yield* exec(["git", "-C", walked, "config", "include.path", included])).exitCode,
        ).toBe(0);
        yield* fs.writeFileString(
          `${rig.userDir}/config.json`,
          json({ projects: { root: `${rig.root}/projects` } }),
        );
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        try {
          const fake = yield* forgeOnPath(bin, "github", {
            installed: true,
            loggedIn: [FORGE_HOST.github],
            login: "me",
            mrs: [],
          });
          forgeApi = yield* serveForges(fake);
          yield* Effect.gen(function* () {
            const registry = yield* Registry;
            const generation = yield* registry.load(
              new URL("./fixtures/workflows/issues.workflow.ts", import.meta.url).pathname,
            );
            const file = (text: string) =>
              registry
                .start({
                  generation,
                  request: text,
                  project: rig.projectDir,
                  input: { operation: "file", text },
                  handsOver: true,
                })
                .pipe(Effect.flatMap((run) => registry.result(run.runId).pipe(Effect.result)));
            expect(Result.isSuccess(yield* file("Warm"))).toBe(true);
            const late = `${rig.root}/late`;
            yield* repository(late, "https://gitlab.example.com/private/late.git");
            yield* registry.start({
              generation,
              request: "late",
              project: late,
              input: { operation: "report", text: "2000-01-01T00:00:00Z" },
              handsOver: true,
            });
            expect(
              (yield* exec([
                "git",
                "-C",
                walked,
                "remote",
                "add",
                "added",
                "https://gitlab.example.com/private/added.git",
              ])).exitCode,
            ).toBe(0);
            const refused = (text: string, checkout: string) =>
              Effect.gen(function* () {
                const answer = yield* file(text);
                expect(Result.isFailure(answer)).toBe(true);
                if (Result.isFailure(answer))
                  expect(answer.failure.reason).toBe(
                    `issue text names another checkout: ${checkout}`,
                  );
              });
            yield* refused("Seen in private/late", late);
            yield* refused("Seen in private/added", walked);
            yield* fs.writeFileString(
              included,
              '[remote "included"]\n\turl = https://gitlab.example.com/private/included.git\n',
            );
            yield* refused("Seen in private/included", walked);
          }).pipe(withMachine);
          expect((yield* fake.model()).issues).toHaveLength(1);
        } finally {
          yield* bin.restore();
        }
      }),
    ),
  30_000,
);

test(
  "remotes that could not be read once are read again on the next finding",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* repository(rig.projectDir, `https://${PROJECT.github}.git`);
        yield* fs.writeFileString(
          `${rig.userDir}/config.json`,
          json({ projects: { root: rig.root } }),
        );
        const git = Bun.which("git");
        const once = `${rig.root}/fail-once`;
        yield* fs.writeFileString(once, "");
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        try {
          const fake = yield* forgeOnPath(bin, "github", {
            installed: true,
            loggedIn: [FORGE_HOST.github],
            login: "me",
            mrs: [],
          });
          forgeApi = yield* serveForges(fake);
          yield* bin.add(
            "git",
            `[ "$*" = "remote -v" ] && [ -e "${once}" ] && rm "${once}" && exit 1\nexec "${git}" "$@"`,
          );
          yield* Effect.gen(function* () {
            const registry = yield* Registry;
            const generation = yield* registry.load(
              new URL("./fixtures/workflows/issues.workflow.ts", import.meta.url).pathname,
            );
            const answers = [];
            for (const text of ["First finding", "Second finding"]) {
              const run = yield* registry.start({
                generation,
                request: text,
                project: rig.projectDir,
                input: { operation: "file", text },
                handsOver: true,
              });
              answers.push(yield* registry.result(run.runId).pipe(Effect.result));
            }
            expect(Result.isFailure(answers[0]!)).toBe(true);
            if (Result.isFailure(answers[0]!))
              expect(answers[0].failure.reason).toBe(
                `issue privacy check could not read remotes: ${rig.projectDir}`,
              );
            expect(Result.isSuccess(answers[1]!)).toBe(true);
          }).pipe(withMachine);
          expect((yield* fake.model()).issues).toHaveLength(1);
        } finally {
          yield* bin.restore();
        }
      }),
    ),
  30_000,
);
