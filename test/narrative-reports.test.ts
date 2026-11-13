import { afterEach, beforeEach, expect, test } from "bun:test";
import { Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option } from "effect";
import { StoreWrites } from "../src/store-writes";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Artefacts } from "../src/artefacts";
import { appendMetric } from "../src/metrics";
import { sha256Hex } from "../src/attachments";
import { appendCard, type Card } from "../src/cards";
import * as PlatformError from "effect/PlatformError";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { madeRun, recordsAt } from "./support/records";

let rig: Rig;
beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
    }),
  ),
);
afterEach(() => runEffect(rig.close()));

const legacyCard = (run: string, id: string): Card => ({
  id,
  run,
  kind: "slice",
  at: "",
  step: "investigate",
  iteration: 0,
  intent_version: 1,
  revision: { branch: null, head_sha: "old", fingerprint: "old", dirty: false },
  changes: { files: [], commits: [] },
  requested: { goal: null, constraints: [] },
  readiness: "claimed",
  verifications: [],
  claims: [],
  missing: [],
  inspect: [],
  links: {},
  drift: [],
  deliveries: [],
  narrative:
    `# ${id}\n\n` +
    Str.repeat(30)(
      "The socket still refuses connections.\n\nAttempted restart, retry, and a clean client.\n\nRun collie doctor on the owning Machine.\n",
    ),
  aligned: "unverified",
  cross_run: "none",
  significance: "routine",
});

test("a retained recovery report keeps every episode and full source text without rewriting evidence", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const catalogue = yield* Artefacts;
      const run = yield* madeRun(rig.stateDir);
      yield* fs.writeFileString(`${rig.stateDir}/installation`, "host-a");
      for (let n = 0; n < 24; n++) {
        yield* appendMetric(run.evidence, {
          at: `2026-11-01T00:${Str.padStart(2, "0")(String(n))}:00Z`,
          kind: "recovery",
          subject: run.id,
          value: 0,
          recoveryId: `episode-${n}`,
          park: "p1",
          action: "healed",
          outcome: "escalated",
          cause: "unknown",
          note: `## Diagnosis ${n}\n\nThe socket still refuses connections.\n\nAttempted restart, retry, and a clean client.\n\nOnly the operator can restore the login.\n\nRun collie doctor on the owning Machine.`,
        });
      }
      yield* appendCard(run.dir, legacyCard(run.id, "first-finding"));
      yield* appendCard(run.dir, legacyCard(run.id, "second-finding"));
      const hidden = yield* madeRun(rig.stateDir, {
        id: "retained-without-card",
        state: "succeeded",
      });
      yield* appendCard(hidden.dir, legacyCard(hidden.id, "historical-finding"));
      const original = yield* fs.readFileString(`${run.evidence}/metrics.jsonl`);
      const cards = yield* fs.readFileString(`${run.dir}/steering/cards.jsonl`);
      yield* fs.writeFileString(
        `${run.dir}/earlier-output.json`,
        '{"summary":"original Output"}\n',
      );
      yield* fs.writeFileString(`${run.evidence}/proof.txt`, "original evidence\n");
      yield* catalogue.reconcile(run);
      const reports = yield* catalogue.reports(run.id);
      expect(reports).toHaveLength(26);
      for (const report of reports) {
        expect(report.state).toBe("ready");
        expect(Array.from(report.summary).length).toBeLessThanOrEqual(360);
        expect(report.address).toMatchObject({ installation: "host-a", run: run.id, revision: 1 });
        const address = report.address!;
        const read = yield* catalogue.read(run, address.id, address.revision, 0);
        const body = Buffer.from(read.content, "base64").toString();
        expect(body).toContain("Attempted restart, retry, and a clean client.");
        expect(body).toContain("Run collie doctor on the owning Machine.");
        expect(body).toContain(Str.replace("recovery:", "")(report.key));
      }
      expect(yield* fs.readFileString(`${run.evidence}/metrics.jsonl`)).toBe(original);
      expect(yield* fs.readFileString(`${run.dir}/steering/cards.jsonl`)).toBe(cards);
      expect(yield* fs.readFileString(`${run.dir}/earlier-output.json`)).toBe(
        '{"summary":"original Output"}\n',
      );
      expect(yield* fs.readFileString(`${run.evidence}/proof.txt`)).toBe("original evidence\n");
      yield* catalogue.index([hidden]);
      expect((yield* catalogue.reports(hidden.id))[0]?.state).toBe("ready");
    }).pipe(Effect.provide(recordsAt(rig.stateDir))),
  ));

test("an interrupted report resumes with one identity and a later episode update stays unseen", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const service = Layer.build(recordsAt(rig.stateDir)).pipe(
        Effect.map((built) => Context.get(built, Artefacts)),
      );
      const catalogue = yield* service;
      const run = yield* madeRun(rig.stateDir);
      yield* fs.writeFileString(`${rig.stateDir}/installation`, "host-a");
      const line = {
        at: "",
        kind: "recovery",
        subject: run.id,
        value: 0,
        recoveryId: "same-episode",
        action: "healed",
        outcome: "escalated",
        note: "First full diagnosis.",
      } as const;
      yield* appendMetric(run.evidence, line);
      const entered = yield* Deferred.make<void>();
      const work = yield* catalogue.reconcile(run).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) =>
            fs
              .rename(from, to)
              .pipe(
                Effect.andThen(
                  Str.includes("/.reports/")(to)
                    ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                    : Effect.void,
                ),
              ),
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(work);
      const restarted = yield* service;
      yield* restarted.reconcile(run);
      const first = (yield* restarted.reports(run.id))[0]!;
      const item = Option.getOrThrow(
        Arr.findFirst(yield* restarted.list(run.id), (one) => one.id === first.address?.id),
      );
      expect(item.created).toBeNull();
      expect(first.at).toBeNull();
      expect(first.observedAt).toBeTruthy();
      yield* restarted.seen(run.id, item.id, 1, "read-first", {
        origin: "cli",
        requestId: "read-first",
      });
      yield* appendMetric(run.evidence, {
        ...line,
        at: "2026-11-13T12:00:00Z",
        note: "Second diagnosis after checking the socket.",
      });
      yield* restarted.reconcile(run);
      const updated = (yield* restarted.reports(run.id))[0]!;
      expect(updated.address).toMatchObject({ id: item.id, revision: 2 });
      expect(
        Arr.filter(yield* restarted.list(run.id), (one) => one.role === "report"),
      ).toHaveLength(1);
      expect(
        Option.getOrUndefined(
          Arr.findFirst(yield* restarted.list(run.id), (one) => one.id === item.id),
        )?.seen?.revision,
      ).toBe(1);
      const body = Buffer.from(
        (yield* restarted.read(run, item.id, 2, 0)).content,
        "base64",
      ).toString();
      expect(Option.getOrThrow(Str.indexOf("First full diagnosis.")(body))).toBeLessThan(
        Option.getOrThrow(Str.indexOf("Second diagnosis")(body)),
      );
      expect(body).toContain("Original date unknown");
      const registeredRun = yield* madeRun(rig.stateDir, { id: "interrupted-after-registration" });
      yield* appendMetric(registeredRun.evidence, { ...line, subject: registeredRun.id });
      let stopped = false;
      const crashing = yield* Layer.build(recordsAt(rig.stateDir)).pipe(
        Effect.map((built) => Context.get(built, Artefacts)),
        Effect.provideService(StoreWrites, () => {
          if (!stopped) {
            stopped = true;
            throw new Error("crash after registration committed");
          }
        }),
      );
      expect(Exit.isFailure(yield* crashing.reconcile(registeredRun).pipe(Effect.exit))).toBe(true);
      const persisted = (yield* crashing.list(registeredRun.id))[0]!;
      expect(persisted.revision).toBe(1);
      const resumed = yield* service;
      yield* resumed.reconcile(registeredRun);
      expect((yield* resumed.reports(registeredRun.id))[0]?.address).toMatchObject({
        id: persisted.id,
        revision: 1,
      });
      expect(yield* resumed.list(registeredRun.id)).toHaveLength(1);
      expect(
        Buffer.from(
          (yield* resumed.read(registeredRun, persisted.id, 1, 0)).content,
          "base64",
        ).toString(),
      ).toContain("First full diagnosis.");
    }),
  ));

test("a producer's unregistered report reference never replaces its full legacy detail", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const run = yield* madeRun(rig.stateDir);
      const catalogue = yield* Artefacts;
      yield* fs.writeFileString(`${rig.stateDir}/installation`, "host-a");
      yield* appendMetric(run.evidence, {
        at: "",
        kind: "recovery",
        subject: run.id,
        value: 0,
        note: "Full diagnosis must stay reachable.",
        blocker: "Login missing",
        next_action: "Restore login",
        report: {
          installation: "host-a",
          run: run.id,
          id: "never-registered",
          revision: 1,
          step: "heal",
        },
      });
      const original = yield* fs.readFileString(`${run.evidence}/metrics.jsonl`);
      yield* catalogue.reconcile(run);
      const report = (yield* catalogue.reports(run.id))[0]!;
      expect(report).toMatchObject({
        state: "failed",
        blocker: "Login missing",
        nextAction: "Restore login",
      });
      expect(report.address).toBeUndefined();
      expect(report.reason).toContain("not retained");
      expect(yield* fs.readFileString(`${run.evidence}/metrics.jsonl`)).toBe(original);
    }).pipe(Effect.provide(recordsAt(rig.stateDir))),
  ));

test("bounded background migration rotates past eight failed reports and leaves an unchanged pass quiet", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const run = yield* madeRun(rig.stateDir, { id: "retained-not-on-board", state: "succeeded" });
      yield* fs.writeFileString(`${rig.stateDir}/installation`, "host-a");
      for (let n = 0; n < 9; n++)
        yield* appendMetric(run.evidence, {
          at: "",
          kind: "recovery",
          subject: run.id,
          value: 0,
          recoveryId: `episode-${n}`,
          note: `Full diagnosis ${n}`,
        });
      const failed = new Set(
        Array.from(
          { length: 8 },
          (_, n) => `${run.dir}/.reports/${sha256Hex(`recovery:episode-${n}`)}.md.pending`,
        ),
      );
      const broken = {
        ...fs,
        writeFileString: (
          path: string,
          text: string,
          options?: Parameters<typeof fs.writeFileString>[2],
        ) =>
          failed.has(path)
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "writeFileString",
                }),
              )
            : fs.writeFileString(path, text, options),
      };
      for (let pass = 0; pass < 2; pass++) {
        const catalogue = yield* Layer.build(recordsAt(rig.stateDir)).pipe(
          Effect.map((built) => Context.get(built, Artefacts)),
        );
        yield* catalogue.pass([run]).pipe(Effect.provideService(FileSystem.FileSystem, broken));
      }
      const catalogue = yield* Layer.build(recordsAt(rig.stateDir)).pipe(
        Effect.map((built) => Context.get(built, Artefacts)),
      );
      expect(
        Option.getOrUndefined(
          Arr.findFirst(
            yield* catalogue.reports(run.id),
            (one) => one.key === "recovery:episode-8",
          ),
        )?.state,
      ).toBe("ready");
      yield* catalogue.reconcile(run);
      const before = yield* catalogue.reports(run.id);
      let writes = 0;
      yield* catalogue.reconcile(run).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (...args) => {
            writes++;
            return fs.writeFileString(...args);
          },
        }),
      );
      expect(writes).toBe(0);
      expect(yield* catalogue.reports(run.id)).toEqual(before);
    }),
  ));
