import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema, flow as Schemaflow, Result } from "effect";
import * as Str from "effect/String";
import { Flow, type FlowRun } from "../src/board-model";
import { readAudit } from "../src/audit";
import { runDir } from "../src/engine";
import { readEnv } from "../src/env";
import { asksRun } from "../src/lifecycle";
import { peersOf } from "../src/peers";
import { RunLinkNotice } from "../src/run-links";
import { connect } from "../src/host";
import { runEffect } from "./support/effect";
import { stopHost, until } from "./support/host";
import { type Side, twoMachines } from "./support/peers";
import { registeredAt } from "./support/records";

const encode = Schemaflow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);
const runIdOf = Schemaflow(
  Schema.decodeUnknownResult(Schema.Struct({ runId: Schema.String })),
  Result.getOrThrow,
);
const flowOf = (side: Side, run: string) =>
  side
    .cli(["run", "show", run])
    .pipe(
      Effect.map(
        (shown) =>
          Schemaflow(
            Schema.decodeUnknownResult(Schema.Struct({ flow: Flow })),
            Result.getOrThrow,
          )(shown.envelope.data).flow,
      ),
    );

const Machines = Schema.Struct({
  machines: Schema.Array(
    Schema.Struct({ name: Schema.String, failure: Schema.NullOr(Schema.String) }),
  ),
});

const linksTo = (side: Side, requester: string, run: string) =>
  flowOf(side, requester).pipe(
    Effect.map((flow) => {
      const links: Array<FlowRun> = [];
      for (const lane of flow.lanes)
        if (lane.run === requester)
          for (const node of lane.nodes)
            for (const link of node.links ?? []) if (link.link?.run === run) links.push(link);
      return links;
    }),
  );

/** How many of `run`'s reports `side`'s herdr was asked to show its agents. */
const reportsTo = (side: Side, run: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(side.herdrLog)),
    Effect.orDie,
    Effect.map(
      (log) =>
        Arr.filter(Str.split(log, "\n"), (line) => Str.includes(` of ${run} on `)(line)).length,
    ),
  );

const requesterOn = (side: Side) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const outputs = `${side.world.home}/outputs.json`;
    yield* fs.writeFileString(outputs, encode([{ verdict: "done" }, null]));
    const started = yield* side.cli(
      [
        "run",
        "start",
        "stepped",
        "--input",
        "mode=declared",
        "--input",
        `gates=${side.world.home}/gates`,
      ],
      { FAKE_HERDR_OUTPUTS: outputs },
    );
    const { runId } = runIdOf(started.envelope.data);
    const host = yield* connect(side.world.state);
    yield* until(
      () => host.run({ runId }),
      (view) =>
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(view), (present) =>
            Arr.some(present.waiting, (one) => one.answer === null),
          ),
        ) === true,
    );
    const agent = Option.getOrUndefined(
      Arr.findFirst(yield* registeredAt(side.world.state), (one) => one.runId === runId),
    )!;
    return { runId, agent };
  });

test(
  "a plain client cannot write a paired Machine's Run link notice",
  () =>
    runEffect(
      twoMachines(
        "collie-link-forged-",
        (first) =>
          Effect.gen(function* () {
            yield* first.cli(["board"]);
            const host = yield* connect(first.world.state);
            const refused = yield* Effect.flip(
              host.linkNotice({
                request: "forged-notice",
                notice: {
                  requestedBy: {
                    run: "target",
                    agent: "agent",
                    machine: { installation: "local", name: "first" },
                  },
                  run: "run-child",
                  workflow: "investigate",
                  machine: { installation: "peer", name: "second" },
                  phase: "admitted",
                  state: "running",
                  said: null,
                  at: "2026-10-23T09:00:00.000Z",
                },
              }),
            );
            expect(refused.reason).toBe("only a paired Machine can send a Run link notice");
          }),
        [],
      ),
    ),
  180_000,
);

test(
  "a Run started on a paired Machine links from the requesting Step and names its requester",
  () =>
    runEffect(
      twoMachines(
        "collie-linked-runs-",
        (first, second) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const { runId: a, agent } = yield* requesterOn(first);
            const outputs = `${second.world.home}/outputs.json`;
            yield* fs.writeFileString(outputs, encode([null]));
            yield* second.cli(["board"], { FAKE_HERDR_OUTPUTS: outputs });
            yield* first.lists([second]);
            const started = yield* first.cli(
              [
                "--machine",
                "second",
                "run",
                "start",
                "completed-agent",
                "--input",
                `workspace=${second.world.project}`,
                "--input",
                "goal=investigate",
              ],
              { HERDR_PANE_ID: agent.paneId },
            );
            const { runId: b } = runIdOf(started.envelope.data);
            const flow = yield* flowOf(first, a);
            const build = Option.getOrUndefined(
              Option.map(
                Option.fromNullishOr(
                  Option.getOrUndefined(Arr.findFirst(flow.lanes, (lane) => lane.run === a)),
                ),
                (present_) =>
                  Option.getOrUndefined(
                    Arr.findFirst(present_.nodes, (node) => node.id === "build"),
                  ),
              ),
            );
            const admittedAt = build?.links?.[0]?.link?.asOf;
            expect(admittedAt).toBeTypeOf("string");
            expect(build).toMatchObject({
              links: [
                {
                  title: "Completed-agent on second",
                  kind: "link",
                  state: "running",
                  link: { run: b, machine: "second" },
                },
              ],
            });
            const target = yield* flowOf(second, b);
            expect(target.lanes[0]?.requestedBy).toMatchObject({ run: a, agent: agent.agent });
            yield* until(
              () => registeredAt(second.world.state),
              (rows) => Arr.some(rows, (one) => one.runId === b),
            );
            yield* fs.writeFileString(
              `${second.world.state}/agents/${b}/build.json`,
              encode({ verdict: "done" }),
            );
            const host = yield* connect(second.world.state);
            yield* until(
              () => host.run({ runId: b }),
              (view) => view?.status.status === "complete" && view.report !== undefined,
            );
            const settled = Option.getOrUndefined(
              Option.map(
                Option.fromNullishOr(
                  Option.getOrUndefined(
                    Arr.findFirst((yield* flowOf(first, a)).lanes, (lane) => lane.run === a),
                  ),
                ),
                (present__) =>
                  Option.getOrUndefined(
                    Arr.findFirst(present__.nodes, (node) => node.id === "build"),
                  ),
              ),
            );
            expect(settled?.links).toMatchObject([{ state: "done", said: "under a minute" }]);
            expect(settled?.links?.[0]?.link?.asOf).not.toBe(admittedAt);
            const who = target.lanes[0]!.requestedBy!;
            const identity = yield* host.identity();
            const sourceAgent = Option.getOrUndefined(
              Arr.findFirst(yield* registeredAt(second.world.state), (one) => one.runId === b),
            )!;
            const peer = Option.getOrUndefined(
              Arr.findFirst(
                yield* peersOf(second.world.state),
                (one) => one.installation === who.machine.installation,
              ),
            )!;
            const notice = yield* Schema.decodeEffect(RunLinkNotice)({
              requestedBy: who,
              run: b,
              workflow: "completed-agent",
              machine: { installation: identity.installation!, name: "second" },
              phase: "admitted" as const,
              state: "running" as const,
              said: build?.links?.[0]?.said ?? null,
              at: admittedAt!,
            }).pipe(Effect.orDie);
            for (let attempt = 0; attempt < 2; attempt++) {
              const delivered = yield* asksRun(
                { ...readEnv(second.env), machine: peer.name, pairs: false },
                a,
                (client) => client.linkNotice({ notice, request: "repeat-admission" }),
                {
                  origin: "agent",
                  from: { run: b, agent: sourceAgent.agent, machine: notice.machine },
                },
              );
              expect(delivered).toMatchObject({ ok: true, value: true });
            }
            const repeated = Option.getOrUndefined(
              Option.flatMap(
                Option.fromNullishOr(
                  Option.getOrUndefined(
                    Arr.findFirst((yield* flowOf(first, a)).lanes, (lane) => lane.run === a),
                  ),
                ),
                (present___) =>
                  Option.flatMap(
                    Option.fromNullishOr(
                      Option.getOrUndefined(
                        Arr.findFirst(present___.nodes, (node) => node.id === "build"),
                      ),
                    ),
                    (present____) =>
                      Option.map(Option.fromNullishOr(present____.links), (present_____) =>
                        Arr.filter(
                          present_____,
                          (node) =>
                            Option.getOrUndefined(
                              Option.map(
                                Option.fromNullishOr(node.link),
                                (present______) => present______.run,
                              ),
                            ) === b,
                        ),
                      ),
                  ),
              ),
            );
            expect(repeated).toHaveLength(1);
            expect(repeated?.[0]?.state).toBe("done");
            const failing = yield* first.cli(
              [
                "--machine",
                "second",
                "run",
                "start",
                "failing-agent",
                "--input",
                `workspace=${second.world.project}`,
                "--input",
                "goal=find the cause",
              ],
              { HERDR_PANE_ID: agent.paneId },
            );
            expect(failing.envelope).toMatchObject({ ok: true });
            const { runId: c } = runIdOf(failing.envelope.data);
            yield* until(
              () => registeredAt(second.world.state),
              (rows) => Arr.some(rows, (one) => one.runId === c),
            );
            yield* fs.writeFileString(
              `${second.world.state}/agents/${c}/build.json`,
              encode({ verdict: "done" }),
            );
            yield* until(
              () => host.run({ runId: c }),
              (view) => view?.status.status === "failed" && view.report !== undefined,
            );
            const failed = Option.getOrUndefined(
              Option.flatMap(
                Option.fromNullishOr(
                  Option.getOrUndefined(
                    Arr.findFirst((yield* flowOf(first, a)).lanes, (lane) => lane.run === a),
                  ),
                ),
                (present_______) =>
                  Option.flatMap(
                    Option.fromNullishOr(
                      Option.getOrUndefined(
                        Arr.findFirst(present_______.nodes, (node) => node.id === "build"),
                      ),
                    ),
                    (present________) =>
                      Option.map(Option.fromNullishOr(present________.links), (present_________) =>
                        Option.getOrUndefined(
                          Arr.findFirst(
                            present_________,
                            (node) =>
                              Option.getOrUndefined(
                                Option.map(
                                  Option.fromNullishOr(node.link),
                                  (present__________) => present__________.run,
                                ),
                              ) === c,
                          ),
                        ),
                      ),
                  ),
              ),
            );
            expect(failed).toMatchObject({ state: "failed", said: "Cannot reproduce this goal" });
            const waiting = yield* first.cli(
              [
                "--machine",
                "second",
                "run",
                "start",
                "completed-agent",
                "--input",
                `workspace=${second.world.project}`,
                "--input",
                "goal=work while the requester is away",
              ],
              { HERDR_PANE_ID: agent.paneId },
            );
            const { runId: d } = runIdOf(waiting.envelope.data);
            yield* until(
              () => registeredAt(second.world.state),
              (rows) => Arr.some(rows, (one) => one.runId === d),
            );
            yield* stopHost(first.world.state);
            yield* fs.writeFileString(
              `${second.world.state}/agents/${d}/build.json`,
              encode({ verdict: "done" }),
            );
            yield* until(
              () => host.run({ runId: d }),
              (view) => view?.status.status === "complete" && view.report !== undefined,
            );
            const undelivered = yield* second.cli(["run", "show", d]);
            expect(undelivered.envelope.data).toMatchObject({
              run: {
                linkNotices: [
                  { phase: "admitted", state: "delivered" },
                  { phase: "settled", state: "undelivered" },
                ],
              },
            });
            yield* first.cli(["board"]);
            // The notice is sent again before the report.
            yield* until(
              () => reportsTo(first, d),
              (count) => count > 0,
            );
            expect(yield* linksTo(first, a, d)).toMatchObject([{ state: "done" }]);
            const tried = yield* second.cli(["run", "show", d]);
            expect(tried.envelope.data).toMatchObject({
              run: {
                linkNotices: [
                  { phase: "admitted", state: "delivered" },
                  { phase: "settled", state: "undelivered" },
                  { phase: "settled", state: "delivered" },
                ],
                report: { state: "delivered", tries: [{ state: "undelivered" }] },
              },
            });
            const asked = yield* readAudit(runDir(first.world.state, a));
            const askedFor = (request: string) =>
              Option.getOrUndefined(Arr.findFirst(asked, (one) => one.request === request))?.asked;
            const settledNotice = yield* Schema.decodeUnknownEffect(RunLinkNotice)(
              askedFor(`link-${identity.installation}-${d}-settled`),
            ).pipe(Effect.orDie);
            const report = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ text: Schema.String }),
            )(askedFor(`report-${d}`)).pipe(Effect.orDie);
            const dAgent = Option.getOrUndefined(
              Arr.findFirst(yield* registeredAt(second.world.state), (one) => one.runId === d),
            )!;
            const fromD = {
              origin: "agent" as const,
              from: { run: d, agent: dAgent.agent, machine: settledNotice.machine },
            };
            const reached = { ...readEnv(second.env), machine: peer.name, pairs: false };
            for (let attempt = 0; attempt < 2; attempt++) {
              expect(
                yield* asksRun(
                  reached,
                  a,
                  (client) =>
                    client.linkNotice({
                      notice: settledNotice,
                      request: `link-${identity.installation}-${d}-settled`,
                    }),
                  fromD,
                ),
              ).toMatchObject({ ok: true, value: true });
              expect(
                yield* asksRun(
                  reached,
                  a,
                  (client) =>
                    client.steer({
                      runId: a,
                      agent: who.agent,
                      text: report.text,
                      request: `report-${d}`,
                      mode: "boundary",
                    }),
                  fromD,
                ),
              ).toMatchObject({ ok: true, value: { delivered: true } });
            }
            expect(yield* reportsTo(first, d)).toBe(1);
            expect(yield* linksTo(first, a, d)).toMatchObject([{ state: "done" }]);
          }),
        ["stepped.workflow.ts", "completed-agent.workflow.ts", "failing-agent.workflow.ts"],
      ),
    ),
  180_000,
);

test(
  "a notice and a report are not sent again to a Machine unpaired while it was away",
  () =>
    runEffect(
      twoMachines(
        "collie-link-unpaired-",
        (first, second) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const { agent } = yield* requesterOn(first);
            const outputs = `${second.world.home}/outputs.json`;
            yield* fs.writeFileString(outputs, encode([null]));
            yield* second.cli(["board"], { FAKE_HERDR_OUTPUTS: outputs });
            yield* first.lists([second]);
            const started = yield* first.cli(
              [
                "--machine",
                "second",
                "run",
                "start",
                "completed-agent",
                "--input",
                `workspace=${second.world.project}`,
                "--input",
                "goal=work while the requester is unpaired",
              ],
              { HERDR_PANE_ID: agent.paneId },
            );
            const { runId: d } = runIdOf(started.envelope.data);
            yield* until(
              () => registeredAt(second.world.state),
              (rows) => Arr.some(rows, (one) => one.runId === d),
            );
            yield* stopHost(first.world.state);
            yield* fs.writeFileString(
              `${second.world.state}/agents/${d}/build.json`,
              encode({ verdict: "done" }),
            );
            const host = yield* connect(second.world.state);
            yield* until(
              () => host.run({ runId: d }),
              (view) => view?.status.status === "complete" && view.report !== undefined,
            );
            const [requester] = yield* peersOf(second.world.state);
            expect((yield* second.cli(["machine", "forget", requester!.name])).envelope.ok).toBe(
              true,
            );
            const away = (yield* second.cli(["run", "show", d])).envelope.data;
            expect(away).toMatchObject({
              run: {
                linkNotices: [
                  { phase: "admitted", state: "delivered" },
                  { phase: "settled", state: "undelivered" },
                ],
                report: { state: "undelivered" },
              },
            });
            yield* first.cli(["board"]);
            // Its dial is refused, which is as far as the link gets.
            yield* until(
              () =>
                first
                  .cli(["machine", "list"])
                  .pipe(
                    Effect.map((read) =>
                      Arr.findFirst(
                        Schemaflow(
                          Schema.decodeUnknownResult(Machines),
                          Result.getOrThrow,
                        )(read.envelope.data).machines,
                        (one) => one.name === "second" && one.failure !== null,
                      ),
                    ),
                  ),
              Option.isSome,
            );
            expect((yield* second.cli(["run", "show", d])).envelope.data).toEqual(away);
            expect(yield* reportsTo(first, d)).toBe(0);
          }),
        ["stepped.workflow.ts", "completed-agent.workflow.ts"],
      ),
    ),
  180_000,
);

test(
  "a Run started on the same host has its live state linked from its requesting Step",
  () =>
    runEffect(
      twoMachines(
        "collie-local-link-",
        (first) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const { runId: a, agent } = yield* requesterOn(first);
            const started = yield* first.cli(
              [
                "run",
                "start",
                "completed-agent",
                "--input",
                `workspace=${first.world.project}`,
                "--input",
                "goal=investigate",
              ],
              { HERDR_PANE_ID: agent.paneId },
            );
            const { runId: b } = runIdOf(started.envelope.data);
            const linked = Option.getOrUndefined(
              Option.flatMap(
                Option.fromNullishOr(
                  Option.getOrUndefined(
                    Arr.findFirst((yield* flowOf(first, a)).lanes, (lane) => lane.run === a),
                  ),
                ),
                (present___________________) =>
                  Option.map(
                    Option.fromNullishOr(
                      Option.getOrUndefined(
                        Arr.findFirst(
                          present___________________.nodes,
                          (node) => node.id === "build",
                        ),
                      ),
                    ),
                    (present____________________) => present____________________.links,
                  ),
              ),
            );
            expect(linked).toMatchObject([{ state: "running", link: { run: b, asOf: null } }]);
            expect(linked?.[0]?.link?.asOf).toBeNull();
            yield* until(
              () => registeredAt(first.world.state),
              (rows) => Arr.some(rows, (one) => one.runId === b),
            );
            yield* fs.writeFileString(
              `${first.world.state}/agents/${b}/build.json`,
              encode({ verdict: "done" }),
            );
            const host = yield* connect(first.world.state);
            yield* until(
              () => host.run({ runId: b }),
              (view) => view?.status.status === "complete",
            );
            const finished = Option.getOrUndefined(
              Option.flatMap(
                Option.fromNullishOr(
                  Option.getOrUndefined(
                    Arr.findFirst((yield* flowOf(first, a)).lanes, (lane) => lane.run === a),
                  ),
                ),
                (present_____________________) =>
                  Option.map(
                    Option.fromNullishOr(
                      Option.getOrUndefined(
                        Arr.findFirst(
                          present_____________________.nodes,
                          (node) => node.id === "build",
                        ),
                      ),
                    ),
                    (present______________________) => present______________________.links,
                  ),
              ),
            );
            expect(finished).toMatchObject([{ state: "done", link: { run: b, asOf: null } }]);
          }),
        ["stepped.workflow.ts", "completed-agent.workflow.ts"],
      ),
    ),
  180_000,
);
