import { createServer } from "node:net";
import { fakeHerdr } from "./support/fake-herdr-core";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { writeConfigValue } from "../src/config";
import { connect, frontDoor, socketOf, ownerOf } from "../src/host";
import { runDir } from "../src/engine";
import { readEnv } from "../src/env";
import { Herdr } from "../src/herdr";
import { peersOf } from "../src/peers";
import { everyRegistered } from "../src/registry";
import { holderLives } from "../src/lock";
import { readTask } from "../src/task";
import { runEffect } from "./support/effect";
import { exec } from "./support/command";
import { stopHost, until } from "./support/host";
import { twoMachines } from "./support/peers";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const result = {
  summary: "The Machines page uses the last peer build.",
  findings: [{ what: "The cached build is stale", evidence: "desktop/src/shared/in-sync.ts" }],
};
const root = new URL("../", import.meta.url).pathname;

type Case =
  | "delivered"
  | "human-pane"
  | "gone"
  | "away"
  | "restart"
  | "upstream"
  | "stale"
  | "sibling"
  | "failed"
  | "cli-path";
const story = (mode: Case, harness = "claude") =>
  runEffect(
    twoMachines(
      "collie-report-",
      (first, second) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const remote = `${first.world.home}/repository.git`;
          yield* exec(["git", "init", "--bare", "-q", remote]);
          for (const side of [first, second]) {
            yield* fs.writeFileString(`${side.world.project}/source.txt`, side.name);
            yield* exec(["git", "add", "source.txt"], { cwd: side.world.project });
            yield* exec(
              [
                "git",
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.test",
                "commit",
                "-qm",
                "Initial checkout",
              ],
              { cwd: side.world.project },
            );
            yield* exec(["git", "remote", "add", "origin", "git@github.com:cego/collie.git"], {
              cwd: side.world.project,
            });
            yield* exec(
              ["git", "config", `url.${remote}.insteadOf`, "git@github.com:cego/collie.git"],
              { cwd: side.world.project },
            );
            yield* fs.writeFileString(
              `${side.env.PATH!.split(":")[0]}/claude`,
              "#!/bin/sh\necho 2.1.300\n",
              { mode: 0o755 },
            );
            yield* writeConfigValue(side.world.config, "projects.root", side.world.project);
          }
          yield* exec(["git", "switch", "-qc", "shared-topic"], { cwd: second.world.project });
          yield* exec(["git", "push", "-q", "origin", "shared-topic"], {
            cwd: second.world.project,
          });
          yield* fs.copyFile(
            `${root}workflows/investigate.workflow.ts`,
            `${first.world.install}/workflows/investigate.workflow.ts`,
          );
          yield* fs.copyFile(
            `${root}workflows/investigate.md`,
            `${first.world.install}/workflows/investigate.md`,
          );
          yield* fs.makeDirectory(`${first.world.install}/personas`, { recursive: true });
          yield* fs.copyFile(
            `${root}personas/investigator.md`,
            `${first.world.install}/personas/investigator.md`,
          );
          if (mode === "failed")
            yield* fs.writeFileString(
              `${first.world.install}/workflows/investigate.workflow.ts`,
              `import {defineWorkflow,WorkflowError} from "collie"; import {Effect,Schema} from "effect";
export default defineWorkflow({id:"investigate",title:"Failed investigation",description:"Fails before launch",input:Schema.Struct({goal:Schema.String}),hints:{goal:"goal"},checkout:"branch",closes:"reported",run:()=>Effect.fail(new WorkflowError({reason:"The laptop cannot reproduce this goal"}))});`,
            );
          const reportText =
            mode === "failed" ? "The laptop cannot reproduce this goal" : result.summary;
          const socket = `${first.world.home}/herdr.sock`;
          const server = createServer((connection) => {
            let pending = "";
            connection.on("data", (chunk) => {
              pending += chunk.toString();
              for (let newline; (newline = pending.indexOf("\n")) !== -1;) {
                const line = pending.slice(0, newline);
                pending = pending.slice(newline + 1);
                const request = Schema.decodeUnknownSync(
                  Schema.fromJsonString(
                    Schema.Struct({
                      id: Schema.Unknown,
                      method: Schema.String,
                      params: Schema.optionalKey(
                        Schema.Struct({ workspace_id: Schema.optionalKey(Schema.String) }),
                      ),
                    }),
                  ),
                )(line);
                const answer =
                  request.method === "workspace.close"
                    ? runEffect(
                        fakeHerdr(
                          ["workspace", "close", "--workspace", request.params?.workspace_id ?? ""],
                          first.env,
                        ),
                      )
                    : Promise.resolve({ code: 0, stdout: "", stderr: "" });
                void answer.then((reply) =>
                  connection.write(
                    `${encode(reply.code === 0 ? { id: request.id, result: { type: "ok" } } : { id: request.id, error: { message: reply.stderr } })}\n`,
                  ),
                );
              }
            });
          });
          yield* Effect.callback<void>((resume) => {
            server.listen(socket, () => resume(Effect.void));
          });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              server.close();
            }),
          );
          const boot = {
            FAKE_HERDR_STATUS_SOCKET: socket,
          };
          const launch = mode === "restart" ? { ...boot, COLLIE_HOST_CRASH_AT: "reported" } : boot;
          if (mode === "upstream") {
            yield* exec(["git", "remote", "rename", "origin", "upstream"], {
              cwd: first.world.project,
            });
            yield* exec(["git", "remote", "add", "origin", "git@github.com:mk/fork.git"], {
              cwd: first.world.project,
            });
          }
          if (mode === "stale")
            yield* exec(["git", "branch", "shared-topic"], { cwd: first.world.project });
          const localOutputs = `${first.world.home}/outputs.json`;
          const farOutputs = `${second.world.home}/outputs.json`;
          yield* fs.writeFileString(localOutputs, encode([null]));
          yield* fs.writeFileString(farOutputs, encode([{ verdict: "done" }]));
          expect(
            (yield* first.cli(["machine", "list"], {
              ...launch,
              FAKE_HERDR_OUTPUTS: localOutputs,
            })).envelope.ok,
          ).toBe(true);
          const requesterStart = yield* second.cli(
            [
              "run",
              "start",
              "attended",
              "--harness",
              harness,
              "--model",
              "default",
              "--input",
              "work=ask a laptop",
            ],
            { FAKE_HERDR_OUTPUTS: farOutputs },
          );
          const { runId: requesterRun } = Schema.decodeUnknownSync(
            Schema.Struct({ runId: Schema.String }),
          )(requesterStart.envelope.data);
          const secondHost = yield* connect(second.world.state);
          yield* until(
            () => secondHost.run({ runId: requesterRun }),
            (view) => (view?.waiting ?? []).some((one) => one.answer === null),
          );
          const requester = (yield* everyRegistered(second.world.state)).find(
            (one) => one.runId === requesterRun,
          )!;
          yield* first.lists([second]);
          expect((yield* first.cli(["--machine", "second", "board"])).envelope).toMatchObject({
            ok: true,
          });
          const [peer] = yield* peersOf(second.world.state);
          const caller = `${second.world.home}/caller-only`;
          if (mode === "cli-path") yield* fs.makeDirectory(caller);
          const asked =
            mode === "cli-path"
              ? yield* second.cli(
                  [
                    "--machine",
                    peer!.name,
                    "run",
                    "start",
                    "investigate",
                    "--input",
                    `workspace=${first.world.project}`,
                    "--input",
                    "branch=shared-topic",
                    "--input",
                    "goal=Why is the Machines page behind?",
                  ],
                  {
                    COLLIE_CWD: caller,
                    COLLIE_RUN: requesterRun,
                    COLLIE_AGENT: requester.agent,
                    HERDR_PANE_ID: requester.paneId,
                  },
                )
              : yield* second.cli(
                  [
                    "tools",
                    "call",
                    "collie_do",
                    "--input",
                    encode({
                      actions: [
                        {
                          kind: "start",
                          workflow: "investigate",
                          machine: peer!.name,
                          workspace: "cego/collie",
                          inputs: {
                            goal: "Why is the Machines page behind?",
                            branch: "shared-topic",
                          },
                        },
                      ],
                    }),
                  ],
                  { COLLIE_RUN: requesterRun, COLLIE_AGENT: requester.agent },
                );
          const text =
            mode === "cli-path"
              ? asked.envelope.ok
                ? `start: applied; started ${Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }))(asked.envelope.data).runId}`
                : encode(asked.envelope)
              : Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(
                  asked.envelope.data,
                ).text;
          if (mode === "stale") {
            expect(text).toContain("differs from the fetched revision");
            expect(
              (yield* exec(["git", "rev-parse", "shared-topic"], { cwd: first.world.project }))
                .stdout,
            ).toBe(
              (yield* exec(["git", "rev-parse", "HEAD"], { cwd: first.world.project })).stdout,
            );
            expect(yield* everyRegistered(first.world.state)).toHaveLength(0);
            return;
          }
          expect(text).toContain("start: applied");
          const runId = /started (run-[a-z0-9]+)/.exec(text)?.[1];
          expect(runId).toBeDefined();
          if (runId === undefined) return;
          const firstHost = yield* connect(first.world.state);
          const view = yield* until(
            () => firstHost.run({ runId }),
            (view) => view !== null,
          );
          expect(view).toMatchObject({
            project: first.world.project,
            branch: "shared-topic",
            requestedBy: { run: requesterRun, agent: requester.agent, machine: { name: "second" } },
            closes: "reported",
          });
          expect(view!.cwd).not.toBe(first.world.project);
          expect(
            (yield* exec(["git", "rev-parse", "HEAD"], { cwd: view!.cwd })).stdout.trim(),
          ).toBe(
            (yield* exec(["git", "rev-parse", "HEAD"], {
              cwd: second.world.project,
            })).stdout.trim(),
          );
          expect(
            (yield* exec(
              ["git", "rev-parse", `${mode === "upstream" ? "upstream" : "origin"}/shared-topic`],
              { cwd: first.world.project },
            )).stdout.trim(),
          ).toBe(
            (yield* exec(["git", "rev-parse", "HEAD"], {
              cwd: second.world.project,
            })).stdout.trim(),
          );
          const ready = yield* until(
            () =>
              Effect.all({
                rows: everyRegistered(first.world.state),
                view: firstHost.run({ runId }),
              }),
            (read) =>
              read.rows.some((one) => one.runId === runId) ||
              read.view?.status.status === "failed" ||
              read.view?.parked != null,
          );
          const entry = ready.rows.find((one) => one.runId === runId);
          if (entry === undefined && mode !== "failed")
            throw new Error(
              encode({
                view: ready.view,
                log: yield* fs
                  .readFileString(`${first.world.state}/agents/${runId}/agents.log`)
                  .pipe(Effect.orElseSucceed(() => "")),
              }),
            );
          const task = yield* readTask(first.world.state, view!.task!);
          let human: string | undefined;
          let sibling: string | undefined;
          if (mode === "sibling") {
            yield* fs.writeFileString(localOutputs, encode([null, { verdict: "done" }]));
            const started = yield* first.cli(
              [
                "run",
                "start",
                "completed-agent",
                "--task",
                task!.id,
                "--input",
                "goal=keep planner",
              ],
              { ...boot, FAKE_HERDR_OUTPUTS: localOutputs },
            );
            expect(started.envelope.ok).toBe(true);
            const other = Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }))(
              started.envelope.data,
            ).runId;
            yield* until(
              () => firstHost.run({ runId: other }),
              (row) => row?.status.status === "complete",
            );
            sibling = (yield* everyRegistered(first.world.state)).find(
              (one) => one.runId === other,
            )?.paneId;
            expect(sibling).toBeDefined();
          }
          if (mode === "human-pane")
            human = (yield* new Herdr(readEnv(first.env)).tabCreate({
              workspace: task!.workspace,
              cwd: view!.cwd,
              label: "my shell",
            })).paneId;
          if (mode === "gone") yield* new Herdr(readEnv(second.env)).paneClose(requester.paneId);
          if (mode === "away") yield* stopHost(second.world.state);
          const before = mode === "restart" ? yield* ownerOf(first.world.state) : null;
          if (mode !== "failed")
            yield* fs.writeFileString(
              `${first.world.state}/agents/${runId}/investigate.json`,
              encode(result),
            );
          if (mode === "restart") {
            yield* until(
              () => fs.readFileString(second.herdrLog),
              (log) => log.includes(` of ${runId} on `),
            );
            yield* until(
              () => (before === null ? Effect.succeed(false) : holderLives(before)),
              (alive) => !alive,
            );
            expect(
              (yield* first.cli(["machine", "list"], { ...boot, FAKE_HERDR_OUTPUTS: localOutputs }))
                .envelope.ok,
            ).toBe(true);
          }
          const readReport = () =>
            fs.readFileString(`${runDir(first.world.state, runId)}/report.json`).pipe(
              Effect.map((text) =>
                Schema.decodeUnknownSync(
                  Schema.fromJsonString(
                    Schema.Struct({
                      state: Schema.String,
                      closed: Schema.Boolean,
                      note: Schema.String,
                    }),
                  ),
                )(text),
              ),
              Effect.orElseSucceed(() => null),
            );
          const report = yield* until(readReport, (report) => report?.closed === true).pipe(
            Effect.catchCause(() =>
              Effect.gen(function* () {
                throw new Error(
                  encode({
                    report: yield* readReport(),
                    view: yield* firstHost.run({ runId }),
                    log: yield* fs
                      .readFileString(`${first.world.state}/agents/${runId}/agents.log`)
                      .pipe(Effect.orElseSucceed(() => "")),
                    host: yield* fs
                      .readFileString(`${first.world.state}/host.log`)
                      .pipe(Effect.orElseSucceed(() => "")),
                    calls: (yield* fs.readFileString(first.herdrLog)).split("\n").slice(-15),
                  }),
                );
              }),
            ),
          );

          expect(report!.state).toBe(
            mode === "gone" || mode === "away" ? "undelivered" : "delivered",
          );
          if (report!.state === "undelivered") expect(report!.note.length).toBeGreaterThan(0);
          const panes = yield* new Herdr(readEnv(first.env)).paneList();
          expect(panes.some((pane) => pane.paneId === entry?.paneId)).toBe(false);
          const workspaces = yield* new Herdr(readEnv(first.env)).workspaceList();
          expect(workspaces.some((workspace) => workspace.workspaceId === task!.workspace)).toBe(
            mode === "human-pane" || mode === "sibling",
          );
          if (sibling !== undefined)
            expect(panes.some((pane) => pane.paneId === sibling)).toBe(true);
          if (human !== undefined) expect(panes.some((pane) => pane.paneId === human)).toBe(true);
          // Three lines and a sender line are over the paste budget, so a report is kept as a file.
          const reports = (yield* fs.readFileString(second.herdrLog))
            .split("\n")
            .filter((line) => line.includes(`From ${entry?.agent ?? "host"} of ${runId} on `));
          expect(reports).toHaveLength(mode === "gone" || mode === "away" ? 0 : 1);
          if (reports[0] !== undefined) {
            const kept = /Their message is in (\S+)\. Read it whole/.exec(reports[0])?.[1] ?? "";
            const report = yield* fs.readFileString(kept);
            expect(report).toContain(reportText);
            expect(report).toContain(`collie run show ${runId}`);
            expect(report).toContain(mode === "failed" ? "failed" : "complete");
          }
          const door = yield* frontDoor(socketOf(first.world.state));
          const detail = yield* door
            .runDetail({ runId, tail: false, pages: 1, refreshMr: false })
            .pipe(Stream.runHead);
          expect(Option.getOrNull(detail)).toMatchObject({
            requestedBy: { run: requesterRun, agent: requester.agent },
            report: { state: report!.state, closed: true },
          });
          const shown = yield* first.cli(["run", "show", runId]);
          expect(shown.envelope.data).toMatchObject({
            run: {
              requestedBy: { run: requesterRun, agent: requester.agent },
              report: { state: report!.state, closed: true },
            },
          });
        }),
      ["attended.workflow.ts", "completed-agent.workflow.ts"],
    ),
  );

test(
  "a Run started by an agent on another Machine reports back and closes",
  () => story("delivered"),
  180_000,
);
test(
  "a reported Run closes its agent while a human pane keeps its workspace",
  () => story("human-pane"),
  180_000,
);
test(
  "a report to a gone agent is recorded undelivered and still closes",
  () => story("gone"),
  180_000,
);
test(
  "a report to an away Machine is bounded, recorded and never queued",
  () => story("away"),
  180_000,
);
test(
  "a host restarting after delivery records one report and closes",
  () => story("restart"),
  180_000,
);

for (const harness of ["codex", "pi", "opencode"])
  test(
    `a report reaches a ${harness} requester without immediate-delivery capability`,
    () => story("delivered", harness),
    180_000,
  );
test(
  "a remote investigation cuts its checkout from upstream's fetched branch",
  () => story("upstream"),
  180_000,
);
test(
  "a remote start refuses a stale local branch without replacing local work",
  () => story("stale"),
  180_000,
);
test(
  "a finished sibling Run's live agent keeps the reported Run's workspace",
  () => story("sibling"),
  180_000,
);

test(
  "a failed remote Run reports its reason and closes without a launched agent",
  () => story("failed"),
  180_000,
);

test(
  "a direct remote CLI start fetches in its named checkout instead of the caller directory",
  () => story("cli-path"),
  180_000,
);
