import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Rec from "effect/Record";
import { expect, test } from "bun:test";
import {
  Config,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Schedule,
  Schema,
  Stream,
  flow,
  Result,
} from "effect";
import { exec } from "./support/command";
import { connect, ownerOf, frontDoor, socketOf } from "../src/host";
import { holderLives } from "../src/lock";
import { readAudit } from "../src/audit";
import { HealOutput, passedOver } from "../src/heal";
import { healOwed, healNth, parkOf, parkWithRecovery } from "../src/park-cause";
import { herdOf } from "../src/steering";
import { newsPath, pending, read as readNews } from "../src/news";
import { collie, proves } from "./support/world";
import type { World } from "./support/world";
import { until } from "./support/host";
import { hostRecords } from "./support/records";
import { NOTIFIED, RunRecords } from "../src/run-records";

const asJson = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
const reportReader = Option.getOrUndefined(
  Effect.runSync(Config.option(Config.String("COLLIE_REPORT_READER"))),
);

const FINDING = {
  collie_defect: true,
  key: "output-absent",
  root_cause: "An agent's turn can end with its verdict only in chat.",
  fix: "Remind it with its Output path.",
  regression: "A turn that ends without its Output gets a reminder.",
};

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

const healsOf = (client: Client, runId: string) =>
  client.runs({ task: null }).pipe(
    Effect.map((views) => Arr.filter(views, (view) => view.heals === runId)),
    Effect.orDie,
  );

const noneNotified: ReadonlyArray<string> = [];

const notified = (world: World, runId: string) =>
  hostRecords(
    world.state,
    RunRecords.use((records) => records.controlsOf(NOTIFIED, runId)),
  ).pipe(
    Effect.map(Arr.map((row) => row.key)),
    Effect.orElseSucceed(() => noneNotified),
  );

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

test("a Heal that says resumed while the Run is still parked is a false recovery, and the park needs you with its diagnosis", () =>
  proves(
    "collie-heal-claims-",
    (world) =>
      Effect.gen(function* () {
        yield* queued(world, [
          {
            diagnosis:
              "# Diagnosis\n\nThe Run waits on a missing socket.\n\nThe restart succeeded, but the login still fails.\n\n```text\nECONNREFUSED\n```",
            actions: ["read its record", "retried the socket", "checked the login"],
            result: "resumed",
            needs_person: "Only you know what it parked on.",
            finding: FINDING,
          },
        ]);
        const { runId, client } = yield* started(world, "parks-for", {
          causes: "unknown",
          entries: `${world.home}/entries`,
        });
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
        const door = yield* frontDoor(socketOf(world.state));
        const registeredReports = Arr.filter(
          (yield* door.artefacts({
            runId: heals[0]!.runId,
            refresh: true,
          })).items,
          (item) => item.role === "report",
        );
        expect(registeredReports).toHaveLength(1);
        const retainedReport = registeredReports[0]!;
        const content = Buffer.from(
          (yield* door.artefactRead({
            runId: heals[0]!.runId,
            id: retainedReport.id,
            revision: retainedReport.revision,
            offset: 0,
          })).content,
          "base64",
        ).toString();
        expect(content).toContain("The restart succeeded, but the login still fails.");
        expect(content).toContain("checked the login");
        expect(content).toContain("An agent's turn can end with its verdict only in chat.");
        expect(content).toContain("Only you know what it parked on.");
        const concluded = Option.getOrThrow(
          Arr.findFirst(lines, (line) => line.outcome === "false-recovery"),
        );
        expect(concluded.report).toMatchObject({
          run: heals[0]!.runId,
          id: retainedReport.id,
          revision: retainedReport.revision,
          step: "mend",
        });
        expect(concluded.blocker).toBe("Only you know what it parked on.");
        yield* door.artefacts({ runId, refresh: true });
        const projected = yield* client.run({ runId });
        expect(
          Option.getOrUndefined(
            Arr.findFirst(
              projected?.narratives ?? [],
              (one) => one.address?.run === heals[0]!.runId,
            ),
          ),
        ).toMatchObject({
          state: "ready",
          blocker: "Only you know what it parked on.",
          nextAction: "Only you know what it parked on.",
        });
        const reader = reportReader;
        if (reader !== undefined) {
          const fs = yield* FileSystem.FileSystem;
          const snapshot = yield* door.board().pipe(
            Stream.filter((message) => message._tag === "Snapshot"),
            Stream.runHead,
          );
          const fixture = `${world.home}/accepted-report.json`;
          const nativeDetail = yield* door
            .runDetail({ runId: heals[0]!.runId, tail: false, pages: 1, refreshMr: false })
            .pipe(Stream.runHead);
          yield* fs.writeFileString(
            fixture,
            asJson({
              snapshot: Option.getOrThrow(snapshot),
              parent: runId,
              detail: {
                detail: Option.getOrThrow(nativeDetail),
                asOf: null,
                bytes: content.length,
              },
              item: retainedReport,
              body: content,
              diagnosis: "The restart succeeded, but the login still fails.",
              action: "checked the login",
              next: "Only you know what it parked on.",
            }),
          );
          const native = yield* exec(
            [reader, "accepted_producer_fixture", "--ignored", "--exact"],
            {
              cwd: new URL("../desktop/", import.meta.url).pathname,
              env: { ...process.env, COLLIE_REPORT_FIXTURE: fixture },
            },
          );
          expect(native.exitCode, native.stderr + native.stdout).toBe(0);
        }
        const park = Arr.findFirst(lines, (line) => line.kind === "halt");
        expect(park._tag).toBe("Some");
        const healStart = Arr.findFirst(
          yield* hostRecords(
            world.state,
            readAudit(`${world.state}/runs/${heals[0]!.runId}`).pipe(
              Effect.provideService(FileSystem.FileSystem, yield* FileSystem.FileSystem),
            ),
          ).pipe(Effect.orDie),
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
          "The Run waits on a missing socket.",
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
  ));

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

const launchOf = (client: Client, runId: string) =>
  until(
    () => client.launches({ run: runId }).pipe(Effect.orDie),
    (launches) => launches.length > 0,
  ).pipe(Effect.map((launches) => launches[0]!));

test("a Heal whose agent asks the reviewer for its Output recovers an output-absent park, and nobody is told it needed them", () =>
  proves(
    "collie-heal-fixes-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* queued(world, [
          null,
          null,
          null,
          { writes: [], output: null, status: "working" },
          { verdict: "clean" },
        ]);
        const { runId, client } = yield* started(world, "silent-review", { target: "the diff" });
        const reminders = (n: number) =>
          slowly(
            () => client.runMetrics({ runId }).pipe(Effect.orDie),
            (lines) => Arr.filter(lines, (line) => line.action === "reminded").length >= n,
          );
        yield* launchOf(client, runId);
        yield* reminders(1);
        yield* reminders(2);
        const heals = yield* slowly(
          () => healsOf(client, runId),
          (heals) => heals.length > 0,
        );
        const reviewer = yield* launchOf(client, runId);
        const healer = { ...(yield* launchOf(client, heals[0]!.runId)), runId: heals[0]!.runId };
        const parked = yield* client.run({ runId }).pipe(Effect.orDie);
        expect(parked?.park).toMatchObject({ cause: "output-absent", healing: healer.runId });
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
        const healed = `run-healed:heal:${parked?.park?.id}`;
        const told = yield* until(
          () => notified(world, runId),
          (lines) => lines.includes(healed),
        );
        expect(Arr.filter(told, (line) => Str.startsWith("needs-you")(line))).toEqual([]);
        expect(told).toContain(healed);
      }),
    ["silent-review.workflow.ts", "mender.workflow.ts"],
  ));

test("a Heal's agent may deliver to and resume the Run it heals, and nothing else: answering, releasing, stopping, taking an offer and another Run are refused", () =>
  proves(
    "collie-heal-authority-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* queued(world, [{ writes: [], output: null, status: "working" }]);
        const other = yield* started(world, "asks", { goal: "ask" });
        yield* until(
          () => other.client.run({ runId: other.runId }).pipe(Effect.orDie),
          (view) => Arr.some(view?.waiting ?? [], (one) => one.answer === null),
        );
        expect(
          (yield* collie(world, ["run", "hold", other.runId, "--request-id", "held"])).envelope.ok,
        ).toBe(true);
        const { runId, client } = yield* started(world, "parks-for", {
          causes: "unknown",
          entries: `${world.home}/entries`,
        });
        const heals = yield* until(
          () => healsOf(client, runId),
          (heals) => heals.length > 0,
        );
        const healer = { ...(yield* launchOf(client, heals[0]!.runId)), runId: heals[0]!.runId };
        const ownReport = `${world.state}/runs/${healer.runId}/handoffs/diagnosis.md`;
        yield* fs.makeDirectory(`${world.state}/runs/${healer.runId}/handoffs`, {
          recursive: true,
        });
        yield* fs.writeFileString(
          ownReport,
          "# Diagnosis\n\nOnly a person can restore the login.\n",
        );
        expect(
          yield* asHealer(world, healer, [
            { kind: "artefact_register", run: healer.runId, path: ownReport, role: "report" },
          ]),
        ).toContain("artefact_register: applied");
        const refused = [
          { kind: "artefact_register", run: runId, path: ownReport, role: "report" },
          {
            kind: "artefact_register",
            run: healer.runId,
            path: `${world.project}/foreign.md`,
            role: "report",
          },
          { kind: "answer", run: other.runId, choiceId: "q1", answer: "yes" },
          { kind: "release", run: other.runId },
          { kind: "stop", run: runId },
          { kind: "take_offer", run: runId, offer: "carry-on" },
          { kind: "deliver", run: other.runId, text: "Carry on." },
        ];
        for (const action of refused) {
          expect(yield* asHealer(world, healer, [action])).toContain(
            `${healer.runId} is a Heal of ${runId}`,
          );
        }
        const controls = client.run({ runId }).pipe(
          Effect.map((view) => view?.controls),
          Effect.orDie,
        );
        const stopping = yield* Effect.forkChild(
          collie(world, ["run", "stop", runId, "--request-id", "stopped"]),
        );
        yield* until(
          () => controls,
          (now) => now?.includes("stop") === true,
        );
        expect(yield* asHealer(world, healer, [{ kind: "resume", run: runId }])).toContain(
          "a person stopped it",
        );
        expect((yield* Fiber.join(stopping)).envelope.ok).toBe(true);
        const resumed = yield* collie(world, ["run", "resume", runId], {
          COLLIE_RUN: healer.runId,
          COLLIE_AGENT: healer.agent,
        });
        expect(resumed.envelope).toMatchObject({ ok: false });
        expect(yield* controls).toContain("stop");
        const asked = yield* client.run({ runId: other.runId }).pipe(Effect.orDie);
        expect(Arr.filter(asked?.waiting ?? [], (one) => one.answer !== null)).toEqual([]);
        expect(asked?.controls).toContain("hold");
      }),
    ["asks.workflow.ts", "parks-for.workflow.ts", "mender.workflow.ts"],
  ));

test("a Heal's resume applies while the Run is at the park its Heal was started for, and is refused once the Run has left it", () =>
  proves(
    "collie-heal-park-",
    (world) =>
      Effect.gen(function* () {
        yield* queued(world, [{ writes: [], output: null, status: "working" }]);
        const { runId, client } = yield* started(world, "parks-for", {
          causes: "unknown,step-failed",
          entries: `${world.home}/entries`,
        });
        const heals = yield* until(
          () => healsOf(client, runId),
          (heals) => heals.length > 0,
        );
        const healer = { ...(yield* launchOf(client, heals[0]!.runId)), runId: heals[0]!.runId };
        const parkOf = client.run({ runId }).pipe(
          Effect.map((view) => view?.park?.id),
          Effect.orDie,
        );
        const first = yield* parkOf;
        expect(heals[0]!.input).toMatchObject({ park: first });
        expect(yield* asHealer(world, healer, [{ kind: "resume", run: runId }])).toContain(
          "resume: applied",
        );
        const second = yield* until(
          () => parkOf,
          (park) => park !== undefined && park !== first,
        );
        expect(yield* asHealer(world, healer, [{ kind: "resume", run: runId }])).toContain(
          `has left park ${first}`,
        );
        expect(yield* parkOf).toBe(second);
      }),
    ["parks-for.workflow.ts", "mender.workflow.ts"],
  ));

test("a park whose Run is held, stopped or waiting on a Decision needs you at once and starts no Heal", () =>
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
          (yield* collie(world, ["run", "hold", held!.runId, "--request-id", "held"])).envelope.ok,
        ).toBe(true);
        expect(
          (yield* collie(world, ["run", "stop", stopped!.runId, "--request-id", "stopped"]))
            .envelope.ok,
        ).toBe(true);
        for (const one of runs) {
          yield* fs.writeFileString(one.cue, "now").pipe(Effect.orDie);
        }
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
  ));

test("a ci-failed park whose three resumes ran out needs you and is still never healed", () => {
  const resumed = (park: string) => ({
    at: `2026-11-13T00:00:0${park}Z`,
    kind: "recovery" as const,
    subject: "r",
    value: 0,
    note: "",
    cause: "ci-failed" as const,
    action: "resumed" as const,
    outcome: "resumed" as const,
    park,
  });
  const recoveries = Arr.map(["1", "2", "3"], resumed);
  const park = parkWithRecovery({ ...parkOf("ci-failed"), id: "4" }, recoveries);
  expect(park.kind).toBe("needs-you");
  expect(
    passedOver({ cause: park.cause, isHeal: false, on: true, waitsOnYou: false, recoveries }),
  ).toBe("only what its recheck reads can clear its cause");
});

const healLine = (recoveryId: string, outcome: "claimed" | "started" | "skipped", at: string) => ({
  at,
  kind: "recovery" as const,
  subject: "r",
  value: 0,
  note: "",
  cause: "step-failed" as const,
  action: "healed" as const,
  outcome,
  recoveryId,
  park: "p",
});

test("a park whose only Heal was skipped before it started is still owed one, numbered after it", () => {
  const recoveries = [
    healLine("heal:r:p", "claimed", "2026-11-13T00:00:01Z"),
    healLine("heal:r:p", "skipped", "2026-11-13T00:00:02Z"),
  ];
  expect(healOwed(["p"], recoveries)).toBe(true);
  expect(healNth("p", recoveries)).toBe(2);
});

test("a park whose Heal started is not owed another, and its next one is the second", () => {
  const recoveries = [
    healLine("heal:r:p", "claimed", "2026-11-13T00:00:01Z"),
    healLine("heal:r:p", "started", "2026-11-13T00:00:02Z"),
  ];
  expect(healOwed(["p"], recoveries)).toBe(false);
  expect(healNth("p", recoveries)).toBe(2);
});

test("a herdr-unavailable park whose three resumes ran out needs you and is never healed", () => {
  const resumed = (park: string) => ({
    at: `2026-11-13T00:00:0${park}Z`,
    kind: "recovery" as const,
    subject: "r",
    value: 0,
    note: "",
    cause: "herdr-unavailable" as const,
    action: "resumed" as const,
    outcome: "resumed" as const,
    park,
  });
  const recoveries = Arr.map(["1", "2", "3"], resumed);
  const park = parkWithRecovery({ ...parkOf("herdr-unavailable"), id: "4" }, recoveries);
  expect(park.kind).toBe("needs-you");
  expect(
    passedOver({ cause: park.cause, isHeal: false, on: true, waitsOnYou: false, recoveries }),
  ).toBe("only what its recheck reads can clear its cause");
});

test("a park only a person can act on, or one raised while recovery.heal is off, needs you at once and starts no Heal", () =>
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
            return { client, runId };
          });
        yield* passed("login-missing", "only a person can act on its cause");
        const blocked = yield* passed("review-blocked", "only a person can act on its cause");
        expect(
          Arr.filter(
            yield* notified(world, blocked.runId),
            (line) => line === "needs-you:parked:review-blocked",
          ),
        ).toHaveLength(1);
        expect(
          (yield* collie(world, ["settings", "set", "recovery.heal", "false"])).envelope.ok,
        ).toBe(true);
        const { client } = yield* passed("unknown", "recovery.heal is off");
        const listed = yield* client.runs({ task: null }).pipe(Effect.orDie);
        expect(Arr.filter(listed, (view) => view.heals !== undefined)).toEqual([]);
      }),
    ["parks-on-cue.workflow.ts", "mender.workflow.ts"],
  ));

test("one Heal runs at a time on a Machine: the next park waits until the first Heal settles, and a stopped Heal is failed and needs you", () =>
  proves(
    "collie-heal-storm-",
    (world) =>
      Effect.gen(function* () {
        yield* queued(world, [
          { writes: [], output: null, status: "working" },
          { writes: [], output: null, status: "working" },
        ]);
        const parked = [];
        for (const name of ["first", "second"]) {
          parked.push(
            yield* started(world, "parks-for", {
              causes: "unknown",
              entries: `${world.home}/${name}`,
            }),
          );
        }
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
  ));

test("a Heal that parks gets no Heal of its own, and the Run it was healing needs you at once", () =>
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
  ));

test("a Heal's Output may say whether its diagnosis is complete, and only as a boolean", () => {
  const resumed = { diagnosis: "It waits.", actions: [], result: "resumed", finding: FINDING };
  const decoded = (said: { diagnosis_complete?: unknown }) =>
    Schema.decodeUnknownOption(HealOutput)({ ...resumed, ...said });
  expect(Option.getOrThrow(decoded({})).diagnosis_complete).toBeUndefined();
  expect(Option.getOrThrow(decoded({ diagnosis_complete: true })).diagnosis_complete).toBe(true);
  expect(Option.getOrThrow(decoded({ diagnosis_complete: false })).diagnosis_complete).toBe(false);
  expect(Option.isNone(decoded({ diagnosis_complete: "no" }))).toBe(true);
});

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

test("the third Heal in a row to fail raises the recovery-failing News as it is judged", () =>
  proves(
    "collie-heal-failing-",
    (world, core) =>
      Effect.gen(function* () {
        const runs: Array<{ runId: string; client: Client }> = [];
        for (const name of ["first", "second", "third"]) {
          runs.push(
            yield* started(world, "parks-for", {
              causes: "unknown",
              entries: `${world.home}/${name}`,
            }),
          );
        }
        const failedOf = (one: { runId: string; client: Client }) =>
          one.client.runMetrics({ runId: one.runId }).pipe(
            Effect.map((lines) =>
              Arr.some(lines, (line) => line.action === "healed" && line.outcome === "failed"),
            ),
            Effect.orDie,
          );
        for (const one of runs) {
          yield* until(
            () => failedOf(one),
            (failed) => failed,
          );
        }
        const file = yield* newsPath(
          world.state,
          yield* herdOf(core.socketPath).pipe(Effect.orDie),
        );
        yield* until(
          () => readNews(file),
          (news) =>
            Arr.some(pending(news).items, (item) => Str.startsWith("recovery-failing:")(item.key)),
        );
      }),
    ["parks-for.workflow.ts", "parking-healer.workflow.ts"],
  ));

test("a host killed between starting a Heal and recording it starts no second Heal when it comes back", () =>
  proves(
    "collie-heal-crash-",
    (world) =>
      Effect.gen(function* () {
        yield* queued(world, [{ writes: [], output: null, status: "working" }]);
        const { runId } = yield* started(
          world,
          "parks-for",
          { causes: "unknown", entries: `${world.home}/entries` },
          { COLLIE_RECOVERY_CRASH_AT: "heal-claimed" },
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
  ));
