import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema, flow as Schemaflow, Result } from "effect";
import { Flow } from "../src/board-model";
import { readEnv } from "../src/env";
import { asksRun } from "../src/lifecycle";
import { peersOf } from "../src/peers";
import { RunLinkNotice } from "../src/run-links";
import { everyRegistered } from "../src/registry";
import { connect } from "../src/host";
import { runEffect } from "./support/effect";
import { stopHost, until } from "./support/host";
import { type Side, twoMachines } from "./support/peers";

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
      Arr.findFirst(yield* everyRegistered(side.world.state), (one) => one.runId === runId),
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
              () => everyRegistered(second.world.state),
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
              Arr.findFirst(yield* everyRegistered(second.world.state), (one) => one.runId === b),
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
              () => everyRegistered(second.world.state),
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
            const before = Option.getOrUndefined(
              Option.flatMap(
                Option.fromNullishOr(
                  Option.getOrUndefined(
                    Arr.findFirst((yield* flowOf(first, a)).lanes, (lane) => lane.run === a),
                  ),
                ),
                (present___________) =>
                  Option.flatMap(
                    Option.fromNullishOr(
                      Option.getOrUndefined(
                        Arr.findFirst(present___________.nodes, (node) => node.id === "build"),
                      ),
                    ),
                    (present____________) =>
                      Option.map(
                        Option.fromNullishOr(present____________.links),
                        (present_____________) =>
                          Option.getOrUndefined(
                            Arr.findFirst(
                              present_____________,
                              (node) =>
                                Option.getOrUndefined(
                                  Option.map(
                                    Option.fromNullishOr(node.link),
                                    (present______________) => present______________.run,
                                  ),
                                ) === d,
                            ),
                          ),
                      ),
                  ),
              ),
            );
            yield* until(
              () => everyRegistered(second.world.state),
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
            yield* first.cli(["--machine", "second", "board"]);
            const saved = Option.getOrUndefined(
              Option.flatMap(
                Option.fromNullishOr(
                  Option.getOrUndefined(
                    Arr.findFirst((yield* flowOf(first, a)).lanes, (lane) => lane.run === a),
                  ),
                ),
                (present_______________) =>
                  Option.flatMap(
                    Option.fromNullishOr(
                      Option.getOrUndefined(
                        Arr.findFirst(present_______________.nodes, (node) => node.id === "build"),
                      ),
                    ),
                    (present________________) =>
                      Option.map(
                        Option.fromNullishOr(present________________.links),
                        (present_________________) =>
                          Option.getOrUndefined(
                            Arr.findFirst(
                              present_________________,
                              (node) =>
                                Option.getOrUndefined(
                                  Option.map(
                                    Option.fromNullishOr(node.link),
                                    (present__________________) => present__________________.run,
                                  ),
                                ) === d,
                            ),
                          ),
                      ),
                  ),
              ),
            );
            expect(saved).toMatchObject({ state: "running", link: { asOf: before?.link?.asOf } });
          }),
        ["stepped.workflow.ts", "completed-agent.workflow.ts", "failing-agent.workflow.ts"],
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
              () => everyRegistered(first.world.state),
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
