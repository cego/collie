import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import type { PlatformServices } from "../src/platform";
import { Effect, FileSystem, type Scope } from "effect";
import { connect, ownerOf } from "../src/host";
import { deliveriesOf } from "../src/steering";
import { until, stopHost } from "./support/host";
import { collie, proves, type World } from "./support/world";
import { settledRun } from "./support/hosted";
import { signalProcess } from "../src/lock";

const stopCompletely = (state: string) =>
  Effect.gen(function* () {
    const owner = yield* ownerOf(state);
    yield* stopHost(state);
    if (owner !== null)
      yield* until(
        () => signalProcess(owner.pid),
        (alive) => !alive,
      );
  });

const withLostPrompt = <A, E>(
  prefix: string,
  body: (world: World) => Effect.Effect<A, E, PlatformServices | Scope.Scope>,
  extra: Readonly<Record<string, string>> = {},
) =>
  withHerdr(prefix, body, {
    FAKE_HERDR_PROMPT_LOST: "text",
    FAKE_HERDR_PROMPT_LOST_TIMES: "1",
    FAKE_HERDR_AGENT_STATUS: "working,idle",
    ...extra,
  });

const withHerdr = <A, E>(
  prefix: string,
  body: (world: World) => Effect.Effect<A, E, PlatformServices | Scope.Scope>,
  fake: Readonly<Record<string, string>>,
) =>
  proves(
    prefix,
    (world) =>
      Effect.gen(function* () {
        const set = {
          HERDR_PLUGIN_STATE_DIR: world.state,
          COLLIE_USER_DIR: world.config,
          ...fake,
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const before = Rec.fromEntries(
              Arr.map(Rec.keys(set), (key) => [key, Bun.env[key]] as const),
            );
            Object.assign(Bun.env, set);
            return before;
          }),
          (before) =>
            Effect.sync(() => {
              for (const [key, value] of Rec.toEntries(before))
                if (value === undefined) delete Bun.env[key];
                else Bun.env[key] = value;
            }),
        );
        return yield* body(world).pipe(Effect.scoped, Effect.ensuring(stopCompletely(world.state)));
      }),
    ["told.workflow.ts"],
  );

const parkedAgent = Effect.fn("test.parkedAgent")(function* (world: World) {
  const client = yield* connect(world.state).pipe(Effect.orDie);
  const { runId } = yield* client
    .start({
      project: world.project,
      id: "told",
      request: "start",
      input: { work: "resume" },
      options: { harness: "claude" },
    })
    .pipe(Effect.orDie);
  const view = yield* until(
    () => client.run({ runId }).pipe(Effect.orDie),
    (one) => one?.status.status === "suspended" && one.parked !== null,
  );
  const found = yield* deliveriesOf(world.state, runId);
  if (found.length === 0) throw new Error(`parked before delivery: ${view?.parked}`);
  const [delivery] = found;
  expect(view?.parked).toContain(delivery!.delivery.id);
  return { client, runId, delivery: delivery!, old: view!.parked };
});

test(
  "a start that timed out parks naming its work, and a resume starts it and completes the step",
  () =>
    withHerdr(
      "collie-resume-start-",
      (world) =>
        Effect.gen(function* () {
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const { runId } = yield* client
            .start({
              project: world.project,
              id: "told",
              request: "start",
              input: { work: "resume" },
              options: { harness: "claude" },
            })
            .pipe(Effect.orDie);
          const parked = yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (one) => one?.status.status !== "pending",
          );
          expect(parked?.status.status).toBe("suspended");
          expect(parked?.parked).toContain("timed out");
          expect(parked?.parked).toContain(`${world.state}/agents/${runId}/build.prompt.md`);
          expect(yield* deliveriesOf(world.state, runId)).toEqual([]);

          expect(
            (yield* client.resume({ runId, request: "resume" }).pipe(Effect.orDie)).applied,
          ).toBe(true);
          yield* until(
            () => deliveriesOf(world.state, runId),
            (one) => one.length === 1,
          );
          yield* (yield* FileSystem.FileSystem)
            .writeFileString(`${world.state}/agents/${runId}/build.json`, '{"verdict":"built"}')
            .pipe(Effect.orDie);
          const done = yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (one) => one?.status.status !== "pending",
          );
          expect(done?.status.status).toBe("complete");
        }),
      { FAKE_HERDR_FAIL: `{"agent start":"timed out"}`, FAKE_HERDR_FAIL_TIMES: "1" },
    ),
  120_000,
);

test(
  "resume clears a collection's old note before Output, journals take-up, and refuses no-ops",
  () =>
    withLostPrompt("collie-resume-collection-", (world) =>
      Effect.gen(function* () {
        const { client, runId, delivery } = yield* parkedAgent(world);
        yield* client
          .settleDelivery({
            runId,
            delivery: delivery.delivery.id,
            as: "not-sent",
            request: "not-sent",
          })
          .pipe(Effect.orDie);
        const replies = yield* Effect.all(
          [
            client.resume({ runId, request: "resume-1" }),
            client.resume({ runId, request: "resume-racing" }),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.orDie);
        expect(Arr.filter(replies, (one) => one.applied)).toHaveLength(1);
        const request = replies[0].applied ? "resume-1" : "resume-racing";
        const first = Option.getOrUndefined(Arr.findFirst(replies, (one) => one.applied))!;
        const waiting = yield* client.run({ runId }).pipe(Effect.orDie);
        expect(waiting?.status.status).toBe("pending");
        expect(waiting?.parked).toBeNull();
        const sent = yield* until(
          () => deliveriesOf(world.state, runId),
          (one) => one.length === 2,
        );
        expect(Arr.map(sent, (one) => one.delivery.attempt)).toEqual([1, 2]);
        expect(new Set(Arr.map(sent, (one) => one.delivery.id)).size).toBe(2);
        expect(yield* client.resume({ runId, request }).pipe(Effect.orDie)).toEqual(first);
        expect(yield* deliveriesOf(world.state, runId)).toHaveLength(2);
        const noOp = yield* client.resume({ runId, request: "resume-2" }).pipe(Effect.orDie);
        expect(noOp.applied).toBe(false);
        expect(noOp.detail).toContain("already running");
        const refused = yield* collie(world, ["run", "resume", runId]);
        expect(refused.exit).not.toBe(0);
        expect(refused.envelope.error?.code).toBe("operation_failed");
        expect(refused.envelope.error?.message).toContain("already running");
        yield* (yield* FileSystem.FileSystem)
          .writeFileString(`${world.state}/agents/${runId}/build.json`, '{"verdict":"built"}')
          .pipe(Effect.orDie);
        yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (one) => one?.status.status === "complete",
        );
        const finished = yield* client.resume({ runId, request: "resume-3" }).pipe(Effect.orDie);
        expect(finished.applied).toBe(false);
        expect(finished.detail).toContain("finished");
        expect(yield* client.resume({ runId, request }).pipe(Effect.orDie)).toEqual(first);
        expect(yield* deliveriesOf(world.state, runId)).toHaveLength(2);
      }),
    ),
  120_000,
);

test(
  "resume takes up uncertain work without resending, then retains a rejected resend's new park",
  () =>
    withLostPrompt(
      "collie-resume-repark-",
      (world) =>
        Effect.gen(function* () {
          const { client, runId, delivery, old } = yield* parkedAgent(world);
          expect(
            (yield* client.resume({ runId, request: "uncertain" }).pipe(Effect.orDie)).applied,
          ).toBe(true);
          const uncertain = yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (one) => one?.status.status === "suspended" && one.parked !== null,
          );
          expect(uncertain?.parked).toContain(delivery.delivery.id);
          expect(yield* deliveriesOf(world.state, runId)).toHaveLength(1);
          yield* client
            .settleDelivery({
              runId,
              delivery: delivery.delivery.id,
              as: "not-sent",
              request: "not-sent",
            })
            .pipe(Effect.orDie);
          expect(
            (yield* client.resume({ runId, request: "rejected" }).pipe(Effect.orDie)).applied,
          ).toBe(true);
          const again = yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (one) =>
              one?.status.status === "suspended" && one.parked !== null && one.parked !== old,
          );
          expect(again?.parked).toContain("could not be sent");
          expect(again?.parked).toContain("tries again");
          expect(
            (yield* client.resume({ runId, request: "rejected" }).pipe(Effect.orDie)).applied,
          ).toBe(true);
          expect((yield* client.run({ runId }).pipe(Effect.orDie))?.parked).toBe(again?.parked);
          yield* client
            .control({ runId, control: "stop", set: true, request: "stop" })
            .pipe(Effect.orDie);
          expect((yield* client.run({ runId }).pipe(Effect.orDie))?.parked).toBeNull();
        }),
      { FAKE_HERDR_FAIL_PROMPT_FROM: "2" },
    ),
  120_000,
);

test(
  "sent reconciliation resumes collection without another delivery",
  () =>
    withLostPrompt("collie-resume-sent-", (world) =>
      Effect.gen(function* () {
        const { client, runId, delivery } = yield* parkedAgent(world);
        yield* client
          .settleDelivery({
            runId,
            delivery: delivery.delivery.id,
            as: "sent",
            request: "sent-reconciliation",
          })
          .pipe(Effect.orDie);
        yield* client
          .control({ runId, control: "hold", set: true, request: "hold" })
          .pipe(Effect.orDie);
        expect(
          (yield* client
            .control({ runId, control: "hold", set: false, request: "release" })
            .pipe(Effect.orDie)).applied,
        ).toBe(true);
        expect((yield* client.run({ runId }).pipe(Effect.orDie))?.parked).toBeNull();
        expect(yield* deliveriesOf(world.state, runId)).toHaveLength(1);
      }),
    ),
  120_000,
);

test(
  "resume refuses failed work without changing its result",
  () =>
    proves(
      "collie-resume-failed-",
      (world) =>
        Effect.gen(function* () {
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const { id: runId } = yield* settledRun(world, "retains");
          const refused = yield* client.resume({ runId, request: "failed" }).pipe(Effect.orDie);
          expect(refused.applied).toBe(false);
          expect(refused.detail).toContain("failed");
          expect((yield* client.run({ runId }).pipe(Effect.orDie))?.status.status).toBe("failed");
        }),
      ["retains.workflow.ts"],
    ),
  120_000,
);

test(
  "a no-op resume preserves a pending Run's park note",
  () =>
    proves(
      "collie-resume-note-",
      (world) =>
        Effect.gen(function* () {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const client = yield* connect(world.state).pipe(Effect.orDie);
              const { runId } = yield* client
                .start({
                  project: world.project,
                  id: "noted",
                  request: "start",
                  input: { note: "another seat is parked" },
                })
                .pipe(Effect.orDie);
              yield* until(
                () => client.run({ runId }).pipe(Effect.orDie),
                (one) => one !== null && one.parked !== null,
              );
              expect(
                (yield* client.resume({ runId, request: "no-op" }).pipe(Effect.orDie)).applied,
              ).toBe(false);
              expect((yield* client.run({ runId }).pipe(Effect.orDie))?.parked).toBe(
                "another seat is parked",
              );
            }),
          );
          yield* stopCompletely(world.state);
        }),
      ["noted.workflow.ts"],
    ),
  120_000,
);

for (const next of ["complete", "park"]) {
  test(
    `restored pending work is taken up once when recovery makes it ${next}`,
    () =>
      proves(
        "collie-resume-restored-",
        (world) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const file = `${world.project}/output`;
            const runId = yield* Effect.scoped(
              Effect.gen(function* () {
                const first = yield* connect(world.state).pipe(Effect.orDie);
                const started = yield* first
                  .start({
                    project: world.project,
                    id: "recovering",
                    request: "start",
                    input: { file },
                  })
                  .pipe(Effect.orDie);
                yield* until(
                  () => first.run({ runId: started.runId }).pipe(Effect.orDie),
                  (one) => one?.parked === "old reason",
                );
                return started.runId;
              }),
            );
            yield* stopCompletely(world.state);
            yield* fs.remove(`${world.state}/host.sock`, { force: true }).pipe(Effect.orDie);
            const module = `${world.user}/recovering.workflow.ts`;
            const source = yield* fs.readFileString(module).pipe(Effect.orDie);
            yield* fs.remove(module).pipe(Effect.orDie);
            yield* Effect.scoped(
              Effect.gen(function* () {
                const client = yield* connect(world.state).pipe(Effect.orDie);
                expect(
                  (yield* client.resume({ runId, request: "missing" }).pipe(Effect.orDie)).applied,
                ).toBe(false);
                expect((yield* client.run({ runId }).pipe(Effect.orDie))?.parked).toBe(
                  "old reason",
                );
                yield* fs.writeFileString(file, next).pipe(Effect.orDie);
                yield* fs.writeFileString(module, source).pipe(Effect.orDie);
                const resumed = yield* client
                  .resume({ runId, request: "restored" })
                  .pipe(Effect.orDie);
                expect(resumed.applied).toBe(true);
                const view = yield* until(
                  () => client.run({ runId }).pipe(Effect.orDie),
                  (one) =>
                    next === "complete"
                      ? one?.status.status === "complete"
                      : one?.parked === "current recovery reason",
                );
                expect(view?.parked).toBe(next === "complete" ? null : "current recovery reason");
                const log = yield* fs
                  .readFileString(`${world.state}/runs/${runId}/log.txt`)
                  .pipe(Effect.orDie);
                expect(
                  Arr.filter(Str.split(log, "\n"), (line) => line === `entered ${next}`),
                ).toHaveLength(1);
              }),
            );
            yield* stopCompletely(world.state);
          }),
        ["recovering.workflow.ts"],
      ),
    120_000,
  );
}
