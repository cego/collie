import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Rec from "effect/Record";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Option, Schedule, Schema, flow, Result } from "effect";
import { connect, ownerOf } from "../src/host";
import { holderLives } from "../src/lock";
import { readAudit } from "../src/audit";
import { HealOutput } from "../src/heal";
import { herdOf } from "../src/steering";
import { newsPath, pending, read as readNews } from "../src/news";
import { collie, proves, type World } from "./support/world";
import { until } from "./support/host";

const asJson = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

const FINDING = {
  collie_defect: true,
  key: "output-absent",
  root_cause: "An agent's turn can end with its verdict only in chat.",
  fix: "Remind it with its Output path.",
  regression: "A turn that ends without its Output gets a reminder.",
};

/** A Run started on `id` with these inputs, and a client of the host that took it. */
const started = (world: World, id: string, inputs: Record<string, string>, extra = {}) =>
  Effect.gen(function* () {
    const said = yield* collie(
      world,
      [
        "run",
        "start",
        id,
        ...Arr.flatMap(Rec.toEntries(inputs), ([k, v]) => ["--input", `${k}=${v}`]),
      ],
      { COLLIE_RECOVERY_EVERY: "100 millis", ...extra },
    );
    expect(said.envelope).toMatchObject({ ok: true });
    const { runId } = yield* Schema.decodeUnknownEffect(Schema.Struct({ runId: Schema.String }))(
      said.envelope.data,
    ).pipe(Effect.orDie);
    const client = yield* connect(world.state).pipe(Effect.orDie);
    return { runId, client };
  });

type Client = Effect.Success<ReturnType<typeof started>>["client"];

/** The Heals started for `runId`, as the host lists them. */
const healsOf = (client: Client, runId: string) =>
  client.runs({ task: null }).pipe(
    Effect.map((views) => Arr.filter(views, (view) => view.heals === runId)),
    Effect.orDie,
  );

const notified = (world: World, runId: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${world.state}/notified.${runId}`)),
    Effect.map((text) => Arr.filter(Str.split(text, "\n"), (line) => line !== "")),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

/** Until `wanted` holds, over the minute an agent's reminders take at the host's own poll. */
const slowly = <A, E, R>(read: () => Effect.Effect<A, E, R>, wanted: (value: A) => boolean) =>
  Effect.suspend(read).pipe(
    Effect.filterOrFail(wanted, (value) => value),
    Effect.retry({ times: 900, schedule: Schedule.spaced("100 millis") }),
    Effect.catch((last) => Effect.die(new Error(`never got there: ${Bun.inspect(last)}`))),
  );

const queued = (world: World, outputs: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const path = `${world.home}/outputs.json`;
    yield* (yield* FileSystem.FileSystem).writeFileString(path, asJson(outputs)).pipe(Effect.orDie);
    return path;
  });

test(
  "a Heal that says resumed while the Run is still parked is a false recovery, and the park needs you with its diagnosis",
  () =>
    proves(
      "collie-heal-claims-",
      (world) =>
        Effect.gen(function* () {
          const outputs = yield* queued(world, [
            {
              diagnosis: "The Run waits on nothing I can see.",
              actions: ["read its record"],
              result: "resumed",
              needs_person: "Only you know what it parked on.",
              finding: FINDING,
            },
          ]);
          const { runId, client } = yield* started(
            world,
            "parks-for",
            { causes: "unknown", entries: `${world.home}/entries` },
            { FAKE_HERDR_OUTPUTS: outputs },
          );
          const lines = yield* until(
            () => client.runMetrics({ runId }).pipe(Effect.orDie),
            (lines) =>
              Arr.some(
                lines,
                (line) => line.action === "healed" && line.outcome === "false-recovery",
              ),
          );
          const heals = yield* healsOf(client, runId);
          expect(heals).toHaveLength(1);
          const park = Arr.findFirst(lines, (line) => line.kind === "halt");
          expect(park._tag).toBe("Some");
          const healStart = Arr.findFirst(
            yield* readAudit(`${world.state}/runs/${heals[0]!.runId}`).pipe(Effect.orDie),
            (line) => line.operation === "start",
          );
          expect(healStart._tag === "Some" && healStart.value).toMatchObject({
            request: `heal:${runId}:${park._tag === "Some" ? park.value.park : ""}`,
            actor: { origin: "host" },
          });
          const view = yield* client.run({ runId }).pipe(Effect.orDie);
          expect(view?.status.status).toBe("suspended");
          expect(view?.park?.kind).toBe("needs-you");
          const told = yield* until(
            () => notified(world, runId),
            (lines) => lines.length > 0,
          );
          expect(told).toEqual([`needs-you:heal:${park._tag === "Some" ? park.value.park : ""}`]);
          expect(Arr.join(view?.park?.history ?? [], "\n")).toContain(
            "The Run waits on nothing I can see.",
          );
          const report = yield* collie(world, ["run", "report"]);
          expect(report.envelope.data).toMatchObject({
            measures: {
              recoveries: {
                byCause: expect.arrayContaining([
                  expect.objectContaining({
                    cause: "unknown",
                    action: "healed",
                    count: 1,
                    recovered: 0,
                    falseRecoveries: 1,
                    escalations: 1,
                  }),
                ]),
              },
            },
          });
        }),
      ["parks-for.workflow.ts", "mender.workflow.ts"],
    ),
  120_000,
);

/** Does what a Heal's agent asks `collie_do` for, as that agent. */
const asHealer = (
  world: World,
  heal: { runId: string; agent: string },
  actions: ReadonlyArray<unknown>,
) =>
  collie(world, ["tools", "call", "collie_do", "--input", asJson({ actions })], {
    COLLIE_RUN: heal.runId,
    COLLIE_AGENT: heal.agent,
  }).pipe(
    Effect.flatMap((said) => {
      expect(said.envelope.ok).toBe(true);
      return Schema.decodeUnknownEffect(Schema.Struct({ text: Schema.String }))(said.envelope.data);
    }),
    Effect.map((said) => said.text),
    Effect.orDie,
  );

/** The one launch of `runId`'s agent, once it has one. */
const launchOf = (client: Client, runId: string) =>
  until(
    () => client.launches({ run: runId }).pipe(Effect.orDie),
    (launches) => launches.length > 0,
  ).pipe(Effect.map((launches) => launches[0]!));

test(
  "a Heal whose agent asks the reviewer for its Output recovers an output-absent park, and nobody is told it needed them",
  () =>
    proves(
      "collie-heal-fixes-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const status = `${world.home}/status`;
          yield* fs.writeFileString(status, "idle").pipe(Effect.orDie);
          const working = { writes: [{ path: status, text: "working" }], output: null };
          const outputs = yield* queued(world, [
            working,
            working,
            working,
            working,
            { verdict: "clean" },
          ]);
          const { runId, client } = yield* started(
            world,
            "silent-review",
            { target: "the diff" },
            { FAKE_HERDR_OUTPUTS: outputs, FAKE_HERDR_AGENT_STATUS_FILE: status },
          );
          const statusReads = fs.readFileString(`${world.state}/../herdr-calls.jsonl`).pipe(
            Effect.map((calls) => Str.split(calls, '"cmd":"agent get"').length),
            Effect.orElseSucceed(() => 0),
          );
          /** The reviewer's turn, once the host has read it working, ended. */
          const turnEnds = Effect.gen(function* () {
            yield* slowly(
              () => fs.readFileString(status).pipe(Effect.orElseSucceed(() => "")),
              (said) => Str.trim(said) === "working",
            );
            const from = yield* statusReads;
            yield* slowly(
              () => statusReads,
              (reads) => reads >= from + 2,
            );
            yield* fs.writeFileString(status, "idle").pipe(Effect.orDie);
          });
          const reminders = (n: number) =>
            slowly(
              () => client.runMetrics({ runId }).pipe(Effect.orDie),
              (lines) => Arr.filter(lines, (line) => line.action === "reminded").length >= n,
            );
          yield* launchOf(client, runId);
          yield* turnEnds;
          yield* reminders(1);
          yield* turnEnds;
          yield* reminders(2);
          yield* turnEnds;
          const heals = yield* slowly(
            () => healsOf(client, runId),
            (heals) => heals.length > 0,
          );
          const reviewer = yield* launchOf(client, runId);
          const healer = { ...(yield* launchOf(client, heals[0]!.runId)), runId: heals[0]!.runId };
          const parked = yield* client.run({ runId }).pipe(Effect.orDie);
          expect(parked?.park).toMatchObject({ cause: "output-absent", healing: healer.runId });
          // The Heal's agent is at work; the reviewer it asks is not.
          yield* fs.writeFileString(`${status}.${reviewer.agent}`, "idle").pipe(Effect.orDie);
          expect(
            yield* asHealer(world, healer, [
              {
                kind: "deliver",
                run: runId,
                agent: reviewer.agent,
                text: `Your verdict is in chat, not in your Output. Write it.\nOUTPUT_PATH: ${reviewer.output}`,
              },
            ]),
          ).toContain("deliver: applied");
          const done = yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => view?.status.status === "complete",
          );
          expect(done?.status).toEqual({ status: "complete", value: "clean" });
          yield* asHealer(world, healer, [{ kind: "resume", run: runId }]);
          yield* fs
            .writeFileString(
              healer.output,
              asJson({
                diagnosis: "The reviewer's verdict was in chat, not in its Output.",
                actions: ["asked the reviewer to write its Output", "resumed the Run"],
                result: "resumed",
                finding: FINDING,
              }),
            )
            .pipe(Effect.orDie);
          const lines = yield* until(
            () => client.runMetrics({ runId }).pipe(Effect.orDie),
            (lines) =>
              Arr.some(
                lines,
                (line) =>
                  line.action === "healed" &&
                  line.outcome !== "claimed" &&
                  line.outcome !== "started",
              ),
          );
          const judged = Arr.filter(
            lines,
            (line) =>
              line.action === "healed" && line.outcome !== "claimed" && line.outcome !== "started",
          );
          expect(judged).toEqual([
            expect.objectContaining({
              cause: "output-absent",
              outcome: "recovered",
              heal: healer.runId,
              recoveryId: `heal:${runId}:${parked?.park?.id}`,
              finding: FINDING,
            }),
          ]);
          const told = yield* until(
            () => notified(world, runId),
            (lines) => lines.length > 0,
          );
          expect(Arr.filter(told, (line) => Str.startsWith("needs-you")(line))).toEqual([]);
          expect(told).toContain(`run-healed:heal:${parked?.park?.id}`);
        }),
      ["silent-review.workflow.ts", "mender.workflow.ts"],
    ),
  180_000,
);

test(
  "a Heal's agent may deliver to and resume the Run it heals, and nothing else: answering, releasing, stopping, taking an offer and another Run are refused",
  () =>
    proves(
      "collie-heal-authority-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const status = `${world.home}/status`;
          yield* fs.writeFileString(status, "working").pipe(Effect.orDie);
          const outputs = yield* queued(world, [null]);
          const extra = { FAKE_HERDR_OUTPUTS: outputs, FAKE_HERDR_AGENT_STATUS_FILE: status };
          const other = yield* started(world, "asks", { goal: "ask" }, extra);
          yield* until(
            () => other.client.run({ runId: other.runId }).pipe(Effect.orDie),
            (view) => Arr.some(view?.waiting ?? [], (one) => one.answer === null),
          );
          expect(
            (yield* collie(world, ["run", "hold", other.runId, "--request-id", "held"])).envelope
              .ok,
          ).toBe(true);
          const { runId, client } = yield* started(
            world,
            "parks-for",
            { causes: "unknown", entries: `${world.home}/entries` },
            extra,
          );
          const heals = yield* until(
            () => healsOf(client, runId),
            (heals) => heals.length > 0,
          );
          const healer = { ...(yield* launchOf(client, heals[0]!.runId)), runId: heals[0]!.runId };
          const refused = [
            { kind: "answer", run: other.runId, choiceId: "q1", answer: "yes" },
            { kind: "release", run: other.runId },
            { kind: "stop", run: runId },
            { kind: "take_offer", run: runId, offer: "carry-on" },
            { kind: "deliver", run: other.runId, text: "Carry on." },
          ];
          for (const action of refused)
            expect(yield* asHealer(world, healer, [action])).toContain(
              `${healer.runId} is a Heal of ${runId}`,
            );
          const controls = client.run({ runId }).pipe(
            Effect.map((view) => view?.controls),
            Effect.orDie,
          );
          expect(
            (yield* collie(world, ["run", "stop", runId, "--request-id", "stopped"])).envelope.ok,
          ).toBe(true);
          expect(yield* asHealer(world, healer, [{ kind: "resume", run: runId }])).toContain(
            "a person stopped it",
          );
          const resumed = yield* collie(world, ["run", "resume", runId], {
            COLLIE_RUN: healer.runId,
            COLLIE_AGENT: healer.agent,
          });
          expect(resumed.envelope).toMatchObject({ ok: false });
          expect(yield* controls).toContain("stop");
          yield* collie(world, ["run", "resume", runId]);
          expect(yield* controls).not.toContain("stop");
          expect(yield* asHealer(world, healer, [{ kind: "resume", run: runId }])).not.toContain(
            "is a Heal of",
          );
          const asked = yield* client.run({ runId: other.runId }).pipe(Effect.orDie);
          expect(Arr.filter(asked?.waiting ?? [], (one) => one.answer !== null)).toEqual([]);
          expect(asked?.controls).toContain("hold");
        }),
      ["asks.workflow.ts", "parks-for.workflow.ts", "mender.workflow.ts"],
    ),
  120_000,
);

test(
  "a park whose Run is held, stopped or waiting on a Decision needs you at once and starts no Heal",
  () =>
    proves(
      "collie-heal-yours-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const runs: Array<{ runId: string; client: Client; cue: string }> = [];
          for (const [name, asks] of [
            ["held", "no"],
            ["stopped", "no"],
            ["asking", "yes"],
          ] as const) {
            const cue = `${world.home}/${name}`;
            runs.push({
              ...(yield* started(world, "parks-on-cue", { cue, cause: "unknown", asks })),
              cue,
            });
          }
          const [held, stopped, asking] = runs;
          yield* until(
            () => asking!.client.run({ runId: asking!.runId }).pipe(Effect.orDie),
            (view) => Arr.some(view?.waiting ?? [], (one) => one.answer === null),
          );
          expect(
            (yield* collie(world, ["run", "hold", held!.runId, "--request-id", "held"])).envelope
              .ok,
          ).toBe(true);
          expect(
            (yield* collie(world, ["run", "stop", stopped!.runId, "--request-id", "stopped"]))
              .envelope.ok,
          ).toBe(true);
          for (const one of runs) yield* fs.writeFileString(one.cue, "now").pipe(Effect.orDie);
          for (const one of runs) {
            const lines = yield* until(
              () => one.client.runMetrics({ runId: one.runId }).pipe(Effect.orDie),
              (lines) => Arr.some(lines, (line) => line.action === "healed"),
            );
            expect(Arr.filter(lines, (line) => line.action === "healed")).toEqual([
              expect.objectContaining({ outcome: "skipped", note: "it already waits on you" }),
            ]);
            yield* until(
              () => notified(world, one.runId),
              (told) => told.includes("needs-you:parked:unknown"),
            );
          }
          const listed = yield* held!.client.runs({ task: null }).pipe(Effect.orDie);
          expect(Arr.filter(listed, (view) => view.heals !== undefined)).toEqual([]);
        }),
      ["parks-on-cue.workflow.ts", "mender.workflow.ts"],
    ),
  120_000,
);

test(
  "a park only a person can act on, or one raised while recovery.heal is off, needs you at once and starts no Heal",
  () =>
    proves(
      "collie-heal-passed-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const passed = (cause: string, note: string) =>
            Effect.gen(function* () {
              const cue = `${world.home}/${cause}`;
              const { runId, client } = yield* started(world, "parks-on-cue", {
                cue,
                cause,
                asks: "no",
              });
              yield* fs.writeFileString(cue, "now").pipe(Effect.orDie);
              const lines = yield* until(
                () => client.runMetrics({ runId }).pipe(Effect.orDie),
                (lines) => Arr.some(lines, (line) => line.action === "healed"),
              );
              expect(Arr.filter(lines, (line) => line.action === "healed")).toEqual([
                expect.objectContaining({ outcome: "skipped", note }),
              ]);
              yield* until(
                () => notified(world, runId),
                (told) => told.includes(`needs-you:parked:${cause}`),
              );
              return client;
            });
          yield* passed("login-missing", "only a person can act on its cause");
          expect(
            (yield* collie(world, ["settings", "set", "recovery.heal", "false"])).envelope.ok,
          ).toBe(true);
          const client = yield* passed("unknown", "recovery.heal is off");
          const listed = yield* client.runs({ task: null }).pipe(Effect.orDie);
          expect(Arr.filter(listed, (view) => view.heals !== undefined)).toEqual([]);
        }),
      ["parks-on-cue.workflow.ts", "mender.workflow.ts"],
    ),
  120_000,
);

test(
  "one Heal runs at a time on a Machine: the next park waits until the first Heal settles, and a stopped Heal is failed and needs you",
  () =>
    proves(
      "collie-heal-storm-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const status = `${world.home}/status`;
          yield* fs.writeFileString(status, "working").pipe(Effect.orDie);
          const extra = {
            FAKE_HERDR_OUTPUTS: yield* queued(world, [null, null]),
            FAKE_HERDR_AGENT_STATUS_FILE: status,
          };
          const parked = [];
          for (const name of ["first", "second"])
            parked.push(
              yield* started(
                world,
                "parks-for",
                { causes: "unknown", entries: `${world.home}/${name}` },
                extra,
              ),
            );
          const { client } = parked[0]!;
          const allHeals = client.runs({ task: null }).pipe(
            Effect.map((views) => Arr.filter(views, (view) => view.heals !== undefined)),
            Effect.orDie,
          );
          const [first] = yield* until(
            () => allHeals,
            (heals) => heals.length > 0,
          );
          yield* Effect.sleep("2 seconds");
          expect((yield* allHeals).length).toBe(1);
          expect(
            (yield* collie(world, ["run", "stop", first!.runId, "--request-id", "stop-heal"]))
              .envelope.ok,
          ).toBe(true);
          yield* until(
            () => allHeals,
            (heals) => heals.length === 2,
          );
          const lines = yield* client.runMetrics({ runId: first!.heals! }).pipe(Effect.orDie);
          const failed = Arr.filter(
            lines,
            (line) => line.action === "healed" && line.outcome === "failed",
          );
          expect(failed).toEqual([expect.objectContaining({ heal: first!.runId })]);
          expect(yield* notified(world, first!.heals!)).toEqual([
            `needs-you:heal:${failed[0]!.park}`,
          ]);
        }),
      ["parks-for.workflow.ts", "mender.workflow.ts"],
    ),
  120_000,
);

test(
  "a Heal that parks gets no Heal of its own, and the Run it was healing needs you at once",
  () =>
    proves(
      "collie-heal-recursion-",
      (world) =>
        Effect.gen(function* () {
          const { runId, client } = yield* started(world, "parks-for", {
            causes: "unknown",
            entries: `${world.home}/entries`,
          });
          const lines = yield* until(
            () => client.runMetrics({ runId }).pipe(Effect.orDie),
            (lines) =>
              Arr.some(lines, (line) => line.action === "healed" && line.outcome === "failed"),
          );
          const failed = Arr.filter(
            lines,
            (line) => line.action === "healed" && line.outcome === "failed",
          );
          const [heal] = yield* healsOf(client, runId);
          expect(failed).toEqual([expect.objectContaining({ heal: heal!.runId })]);
          expect(yield* notified(world, runId)).toEqual([`needs-you:heal:${failed[0]!.park}`]);
          const healLines = yield* client.runMetrics({ runId: heal!.runId }).pipe(Effect.orDie);
          expect(Arr.filter(healLines, (line) => line.action === "healed")).toEqual([
            expect.objectContaining({ outcome: "skipped", note: "it is itself a Heal" }),
          ]);
          expect(yield* healsOf(client, heal!.runId)).toEqual([]);
        }),
      ["parks-for.workflow.ts", "parking-healer.workflow.ts"],
    ),
  120_000,
);

test("a Heal's Output that escalates must say why a person is needed", () => {
  const escalated = {
    diagnosis: "It waits on a release date.",
    actions: [],
    result: "escalate",
    finding: FINDING,
  };
  expect(Option.isNone(Schema.decodeUnknownOption(HealOutput)(escalated))).toBe(true);
  expect(
    Option.isSome(
      Schema.decodeUnknownOption(HealOutput)({ ...escalated, needs_person: "Pick the date." }),
    ),
  ).toBe(true);
});

test(
  "the third Heal in a row to fail raises the recovery-failing News as it is judged",
  () =>
    proves(
      "collie-heal-failing-",
      (world) =>
        Effect.gen(function* () {
          const socket = `${world.home}/herdr.sock`;
          const runs: Array<{ runId: string; client: Client }> = [];
          for (const name of ["first", "second", "third"])
            runs.push(
              yield* started(
                world,
                "parks-for",
                { causes: "unknown", entries: `${world.home}/${name}` },
                { HERDR_SOCKET_PATH: socket },
              ),
            );
          const failedOf = (one: { runId: string; client: Client }) =>
            one.client.runMetrics({ runId: one.runId }).pipe(
              Effect.map((lines) =>
                Arr.some(lines, (line) => line.action === "healed" && line.outcome === "failed"),
              ),
              Effect.orDie,
            );
          for (const one of runs)
            yield* until(
              () => failedOf(one),
              (failed) => failed,
            );
          const file = yield* newsPath(world.state, yield* herdOf(socket).pipe(Effect.orDie));
          yield* until(
            () => readNews(file),
            (news) =>
              Arr.some(pending(news).items, (item) =>
                Str.startsWith("recovery-failing:")(item.key),
              ),
          );
        }),
      ["parks-for.workflow.ts", "parking-healer.workflow.ts"],
    ),
  120_000,
);

test(
  "a host killed between starting a Heal and recording it starts no second Heal when it comes back",
  () =>
    proves(
      "collie-heal-crash-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const status = `${world.home}/status`;
          yield* fs.writeFileString(status, "working").pipe(Effect.orDie);
          const extra = {
            FAKE_HERDR_OUTPUTS: yield* queued(world, [null, null]),
            FAKE_HERDR_AGENT_STATUS_FILE: status,
          };
          const { runId } = yield* started(
            world,
            "parks-for",
            { causes: "unknown", entries: `${world.home}/entries` },
            { ...extra, COLLIE_RECOVERY_CRASH_AT: "heal-claimed" },
          );
          yield* until(
            () =>
              ownerOf(world.state).pipe(
                Effect.flatMap((owner) =>
                  owner === null ? Effect.succeed(false) : holderLives(owner),
                ),
              ),
            (alive) => !alive,
          );
          expect(
            (yield* collie(world, ["run", "show", runId], {
              COLLIE_RECOVERY_EVERY: "100 millis",
              ...extra,
            })).envelope.ok,
          ).toBe(true);
          const again = yield* connect(world.state).pipe(Effect.orDie);
          const lines = yield* until(
            () => again.runMetrics({ runId }).pipe(Effect.orDie),
            (lines) => Arr.some(lines, (line) => line.outcome === "started"),
          );
          yield* Effect.sleep("1 second");
          const heals = yield* healsOf(again, runId);
          expect(heals.length).toBe(1);
          expect(Arr.filter(lines, (line) => line.outcome === "started")).toEqual([
            expect.objectContaining({ heal: heals[0]!.runId }),
          ]);
        }),
      ["parks-for.workflow.ts", "mender.workflow.ts"],
    ),
  120_000,
);
