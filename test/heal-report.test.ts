import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { TestClock } from "effect/testing";
import { expect, test } from "bun:test";
import {
  Config,
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Schema,
  flow,
  Result,
} from "effect";
import { connect } from "../src/host";
import { Rig, FakeHerdr } from "./support/recorder";
import { runEffect } from "./support/effect";
import { foundationLayer, type RunView } from "../src/engine";
import type { PlatformServices } from "../src/platform";
import { healParks } from "../src/park-recovery";
import { Host, type HostApi } from "../src/sdk";
import { knownIn, pendingIn, report, type Pending } from "../src/heal-report";
import { appendMetric, readMetrics, type HealFinding, type Metric } from "../src/metrics";
import type { HealOutput } from "../src/heal";
import { collie, proves, type World } from "./support/world";
import { until } from "./support/host";
import { FakeBin } from "./support/bin";
import { forgeOnPath, serveForges, type ForgeModel } from "./support/forge";
import { exec } from "./support/command";

const asJson = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

const COLLIE = "github.com/cego/collie";

const FINDING = {
  collie_defect: true,
  key: "retired-agent-parks-unknown",
  root_cause: "A retired agent that is not quiet leaves its Run parked with no recheck.",
  fix: "Park it for a cause that rechecks.",
  regression: "A retirement that times out parks for a recheck cause.",
};

/** A parked Run on a GitLab project, healed by `mender` with `output`, and GitHub's fake gh. */
const healed = (world: World, output: HealOutput, github: ForgeModel) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* exec(["git", "remote", "add", "origin", "https://gitlab.example.com/mk/project.git"], {
      cwd: world.project,
    });
    const bin = yield* Effect.acquireRelease(FakeBin.make(`${world.home}/bin`), (bin) =>
      bin.restore(),
    );
    const forge = yield* forgeOnPath(bin, "github", github);
    const outputs = `${world.home}/outputs.json`;
    yield* fs.writeFileString(outputs, asJson([output])).pipe(Effect.orDie);
    const extra = {
      PATH: `${bin.dir}:${yield* Config.String("PATH")}`,
      COLLIE_FORGE_API: yield* serveForges(forge),
      FAKE_HERDR_OUTPUTS: outputs,
      COLLIE_RECOVERY_EVERY: "100 millis",
    };
    const said = yield* collie(
      world,
      [
        "run",
        "start",
        "parks-for",
        "--input",
        "causes=unknown",
        "--input",
        `entries=${world.home}/entries`,
      ],
      extra,
    );
    expect(said.envelope).toMatchObject({ ok: true });
    const { runId } = yield* Schema.decodeUnknownEffect(Schema.Struct({ runId: Schema.String }))(
      said.envelope.data,
    ).pipe(Effect.orDie);
    const client = yield* connect(world.state).pipe(Effect.orDie);
    return { runId, client, forge };
  });

const reportsOf = (lines: ReadonlyArray<{ readonly kind: string }>) =>
  Arr.filter(lines, (line) => line.kind === "report");

test(
  "an escalated Heal's Collie defect is filed on cego/collie, not on the healed Run's project, and its issue is kept on the Run",
  () =>
    proves(
      "collie-heal-report-",
      (world) =>
        Effect.gen(function* () {
          const { runId, client, forge } = yield* healed(
            world,
            {
              diagnosis: "The agent it waits on was retired and never stopped.",
              actions: ["read its record"],
              result: "escalate",
              needs_person: "Only you can restart its agent.",
              finding: FINDING,
            },
            { installed: true, loggedIn: ["github.com"], login: "me", mrs: [], issues: [] },
          );
          const lines = yield* until(
            () => client.runMetrics({ runId }).pipe(Effect.orDie),
            (lines) => reportsOf(lines).length > 0,
          );
          const issues = (yield* forge.model()).issues ?? [];
          expect(Arr.map(issues, (one) => one.project)).toEqual([COLLIE]);
          expect(issues[0]!.body).toContain(`<!-- collie-finding: ${FINDING.key} -->`);
          expect(issues[0]!.body).toContain(FINDING.root_cause);
          expect(reportsOf(lines)).toEqual([
            expect.objectContaining({
              publication: "filed",
              issue: `https://${COLLIE}/issues/${issues[0]!.number}`,
            }),
          ]);
        }),
      ["parks-for.workflow.ts", "mender.workflow.ts"],
    ),
  120_000,
);

test(
  "a Machine with no GitHub login records its refused report once, however often it retries",
  () =>
    proves(
      "collie-heal-unlogged-",
      (world) =>
        Effect.gen(function* () {
          const { runId, client, forge } = yield* healed(
            world,
            {
              diagnosis: "The agent it waits on was retired and never stopped.",
              actions: ["read its record"],
              result: "escalate",
              needs_person: "Only you can restart its agent.",
              finding: FINDING,
            },
            { installed: true, loggedIn: [], login: null, mrs: [], issues: [] },
          );
          yield* until(
            () => forge.calls(),
            (calls) =>
              Arr.filter(calls, (one) => pipe(one, Str.includes("auth status"))).length >= 4,
          );
          const lines = yield* client.runMetrics({ runId }).pipe(Effect.orDie);
          expect(reportsOf(lines)).toEqual([expect.objectContaining({ publication: "refused" })]);
        }),
      ["parks-for.workflow.ts", "mender.workflow.ts"],
    ),
  120_000,
);

/** The host's own Collie issue operations, against a fake gh holding `model`. */
const onCollie = <A, E>(
  model: Partial<ForgeModel>,
  body: (
    host: HostApi,
    forge: Effect.Success<ReturnType<typeof forgeOnPath>>,
    rig: Rig,
  ) => Effect.Effect<A, E, PlatformServices>,
) =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Rig.scoped();
      const bin = yield* Effect.acquireRelease(FakeBin.make(`${rig.root}/bin`), (bin) =>
        bin.restore(),
      );
      const forge = yield* forgeOnPath(bin, "github", {
        installed: true,
        loggedIn: ["github.com"],
        login: "me",
        mrs: [],
        issues: [],
        ...model,
      });
      const api = yield* serveForges(forge);
      const placing = { herdr: new FakeHerdr(rig.pluginEnv()), env: rig.pluginEnv() };
      return yield* Effect.flatMap(Host, (host) => body(host, forge, rig)).pipe(
        Effect.provide(
          foundationLayer({ dir: rig.stateDir, userDir: rig.userDir, placing }).pipe(
            Layer.provideMerge(
              ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ COLLIE_FORGE_API: api }), {
                asPrimary: true,
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

const pending = (
  finding: Partial<Pending["finding"]> = {},
  more: Partial<Pending> = {},
): Pending => ({
  run: "run-parked",
  heal: "run-heal",
  judged: "escalated",
  cause: "unknown",
  build: "1.0.11",
  finding: { ...FINDING, ...finding },
  commented: null,
  last: null,
  ...more,
});

const issue = (number: number, keys: ReadonlyArray<string>, state: "open" | "closed" = "open") => ({
  project: COLLIE,
  number,
  title: `Issue ${number}`,
  body: `Body.\n\n${Arr.join(
    Arr.map(keys, (key) => `<!-- collie-finding: ${key} -->`),
    "\n",
  )}`,
  state,
});

const writes = (forge: Effect.Success<ReturnType<typeof forgeOnPath>>) =>
  Arr.filter(forge.requests(), (one) => one.method !== "GET");

test("an open issue carrying the key is linked with no comment; a key new to the healer's named issue is commented once", () =>
  onCollie(
    { issues: [issue(444, ["retired-agent-parks-unknown", "ran-out-agent-not-quiet"])] },
    (host, forge) =>
      Effect.gen(function* () {
        expect(yield* report(host, pending(), new Map())).toEqual({
          publication: "linked",
          issue: `https://${COLLIE}/issues/444`,
          note: expect.stringContaining("already carries"),
        });
        expect(writes(forge)).toEqual([]);
        const alias = pending(
          { key: "ran-out-agent-not-stopped", issue: 444 },
          { heal: "run-heal-2" },
        );
        expect(yield* report(host, alias, new Map())).toMatchObject({
          publication: "linked",
          issue: `https://${COLLIE}/issues/444`,
        });
        const notes = (yield* forge.model()).issueNotes?.[`${COLLIE}#444`] ?? [];
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain("<!-- collie-finding: ran-out-agent-not-stopped -->");
        expect(notes[0]).toContain("run-heal-2");
        expect(
          yield* report(
            host,
            alias,
            new Map([["ran-out-agent-not-stopped", `https://${COLLIE}/issues/444`]]),
          ),
        ).toMatchObject({ publication: "linked" });
        expect((yield* forge.model()).issueNotes?.[`${COLLIE}#444`]).toHaveLength(1);
        expect((yield* forge.model()).issues).toHaveLength(1);
      }),
  ));

test("a new defect is filed once with observation apart from diagnosis; the next report of its key, from another Heal, links it", () =>
  onCollie({}, (host, forge) =>
    Effect.gen(function* () {
      const first = yield* report(
        host,
        pending(
          { observed: "The Run stayed parked for a day.", expected: "A recheck moves it." },
          { judged: "recovered" },
        ),
        new Map(),
      );
      expect(first).toMatchObject({ publication: "filed", issue: `https://${COLLIE}/issues/1` });
      const filed = (yield* forge.model()).issues![0]!;
      expect(filed.body).toContain("**Observed.** The Run stayed parked for a day.");
      expect(filed.body).toContain("**Diagnosis**, the healer's, not yet confirmed.");
      expect(filed.body).toContain("judged the Heal `recovered`");
      expect(filed.body).not.toContain("gitlab.example.com");
      // A second Heal reporting at once with no local record of the first.
      expect(yield* report(host, pending({}, { heal: "run-heal-2" }), new Map())).toMatchObject({
        publication: "linked",
        issue: `https://${COLLIE}/issues/1`,
      });
      expect((yield* forge.model()).issues).toHaveLength(1);
    }),
  ));

test("a non-defect is never pending, and a false recovery or a finding without its fix is not filed", () =>
  onCollie({}, (host, forge) =>
    Effect.gen(function* () {
      const healed = (
        heal: string,
        finding: Partial<HealFinding>,
        outcome: Metric["outcome"],
      ): Metric => ({
        at: "2026-11-13T10:00:00Z",
        kind: "recovery",
        subject: "run-parked",
        value: 0,
        note: "",
        action: "healed",
        outcome,
        heal,
        recoveryId: `heal:${heal}`,
        finding: { ...FINDING, ...finding },
      });
      expect(
        Arr.map(
          pendingIn("run-parked", [
            healed("run-no", { collie_defect: false }, "recovered"),
            healed("run-flying", {}, "started"),
            healed("run-yes", {}, "recovered"),
          ]),
          (one) => one.heal,
        ),
      ).toEqual(["run-yes"]);
      expect(
        yield* report(host, pending({}, { judged: "false-recovery" }), new Map()),
      ).toMatchObject({
        publication: "not-filed",
      });
      expect(yield* report(host, pending({ fix: " " }), new Map())).toMatchObject({
        publication: "not-filed",
        note: "it does not say its fix",
      });
      expect(forge.requests()).toEqual([]);
    }),
  ));

const reportLine = (publication: Metric["publication"]): Metric => ({
  at: "2026-11-13T10:00:01Z",
  kind: "report",
  subject: FINDING.key,
  value: 0,
  note: "",
  heal: "run-heal",
  publication,
});
const reportedAs = (publication: Metric["publication"], issue: string): Metric => ({
  ...reportLine(publication),
  issue,
});
const healedLine: Metric = {
  at: "2026-11-13T10:00:00Z",
  kind: "recovery",
  subject: "run-parked",
  value: 0,
  note: "",
  action: "healed",
  outcome: "escalated",
  heal: "run-heal",
  recoveryId: "heal:run-heal",
  finding: FINDING,
};

test("report retries keep distinct Heals without repeating refusals while judging is paused", () =>
  onCollie({ loggedIn: [] }, (host, forge, rig) =>
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const evidence = `${env.stateDir}/evidence/run-parked`;
      for (const heal of ["run-heal", "run-heal-2"])
        yield* appendMetric(evidence, { ...healedLine, heal, recoveryId: `heal:${heal}` });
      const view: RunView = {
        runId: "run-parked",
        workflow: "any",
        project: rig.projectDir,
        task: null,
        parent: null,
        registration: "any@1",
        entry: "any.workflow.ts",
        input: {},
        provenance: {},
        strategies: {},
        options: {},
        cwd: rig.projectDir,
        branch: null,
        workspace: null,
        worktree: null,
        outcome: "feature",
        created: healedLine.at,
        status: { status: "suspended" },
        waiting: [],
        controls: [],
        diagnostic: null,
        parked: "unknown",
        awaiting: null,
        mr: null,
        landing: null,
      };
      const paused = yield* Deferred.make<void>();
      let snapshots = 0;
      yield* Effect.forkScoped(
        healParks({
          env,
          host,
          herdr: new FakeHerdr(env),
          views: Effect.suspend(() =>
            snapshots++ === 0
              ? Effect.succeed([view])
              : Deferred.succeed(paused, undefined).pipe(Effect.andThen(Effect.never)),
          ),
          start: () => Effect.die("these Heals are already judged"),
          notify: () => Effect.void,
        }).pipe(
          Effect.provide(
            ConfigProvider.layerAdd(
              ConfigProvider.fromUnknown({ COLLIE_RECOVERY_EVERY: "1 millis" }),
            ),
          ),
        ),
      );
      yield* Deferred.await(paused);
      yield* until(
        () => forge.calls(),
        (calls) => Arr.filter(calls, (one) => pipe(one, Str.includes("auth status"))).length >= 6,
      );
      expect(reportsOf(yield* readMetrics(evidence))).toEqual([
        expect.objectContaining({ heal: "run-heal", publication: "refused" }),
        expect.objectContaining({ heal: "run-heal-2", publication: "refused" }),
      ]);
      yield* forge.set({ ...(yield* forge.model()), loggedIn: ["github.com"] });
      const settled = yield* until(
        () => readMetrics(evidence),
        (lines) =>
          Arr.filter(lines, (line) => line.publication === "filed" || line.publication === "linked")
            .length === 2,
      );
      const published = Arr.filter(
        settled,
        (line) => line.publication === "filed" || line.publication === "linked",
      );
      expect(reportsOf(settled)).toHaveLength(4);
      expect(published).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ heal: "run-heal" }),
          expect.objectContaining({ heal: "run-heal-2" }),
        ]),
      );
      expect(Arr.map(published, (line) => line.publication)).toEqual(
        expect.arrayContaining(["filed", "linked"]),
      );
      expect((yield* forge.model()).issues).toHaveLength(1);
    }).pipe(Effect.scoped),
  ));

test("a refused or uncertain report stays pending, keeping the issue a lost comment went to, until one settles it", () => {
  expect(pendingIn("r", [healedLine, reportLine("refused")])).toHaveLength(1);
  expect(
    pendingIn("r", [healedLine, reportedAs("uncertain", "https://x/issues/9")])[0]?.commented,
  ).toBe("https://x/issues/9");
  expect(
    pendingIn("r", [healedLine, reportLine("refused"), reportedAs("filed", "https://x/issues/9")]),
  ).toEqual([]);
  expect(
    knownIn([
      reportedAs("filed", "https://x/issues/9"),
      reportedAs("uncertain", "https://x/issues/8"),
    ]),
  ).toEqual([[FINDING.key, "https://x/issues/9"]]);
});

test("no login is refused with nothing sent", () =>
  onCollie({ loggedIn: [] }, (host, forge) =>
    Effect.gen(function* () {
      expect(yield* report(host, pending(), new Map())).toMatchObject({ publication: "refused" });
      expect(writes(forge)).toEqual([]);
    }),
  ));

test("an outage is refused with nothing sent", () =>
  onCollie({ httpFault: { status: 503 } }, (host, forge) =>
    Effect.gen(function* () {
      expect(yield* report(host, pending(), new Map())).toMatchObject({ publication: "refused" });
      expect(writes(forge)).toEqual([]);
    }),
  ));

test("a write the forge refuses is refused, keeping no issue, so the next report sends it", () =>
  onCollie({ issues: [issue(444, ["another-key"])], refusesIssueWrite: 403 }, (host, forge) =>
    Effect.gen(function* () {
      const named = pending({ issue: 444 });
      expect(yield* report(host, named, new Map())).toEqual({
        publication: "refused",
        note: expect.stringContaining("403"),
      });
      expect(yield* report(host, pending({ key: "a-new-cause" }), new Map())).toEqual({
        publication: "refused",
        note: expect.stringContaining("403"),
      });
      const { refusesIssueWrite: _, ...answering } = yield* forge.model();
      yield* forge.set(answering);
      expect(yield* report(host, named, new Map())).toMatchObject({
        publication: "linked",
        issue: `https://${COLLIE}/issues/444`,
      });
      expect((yield* forge.model()).issueNotes?.[`${COLLIE}#444`]).toHaveLength(1);
    }),
  ));

test("a comment with no answer in time is uncertain and keeps its issue, so it is not sent again", () =>
  onCollie({}, (host) =>
    Effect.gen(function* () {
      const url = `https://${COLLIE}/issues/444`;
      const silent: HostApi = {
        ...host,
        issues: () => Effect.succeed([{ number: 444, title: "Issue 444", body: "", url }]),
        commentIssue: () => Effect.never,
      };
      const reporting = yield* Effect.forkChild(report(silent, pending({ issue: 444 }), new Map()));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 minutes");
      expect(yield* Fiber.join(reporting)).toMatchObject({ publication: "uncertain", issue: url });
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("a write whose answer was lost is reconciled before it is sent again: a landed filing is found by its marker, a sent comment is not repeated", () =>
  onCollie({ issues: [issue(7, [FINDING.key]), issue(8, [])] }, (host, forge) =>
    Effect.gen(function* () {
      expect(yield* report(host, pending(), new Map())).toMatchObject({
        publication: "linked",
        issue: `https://${COLLIE}/issues/7`,
      });
      expect(
        yield* report(
          host,
          pending({ key: "another-key", issue: 8 }, { commented: `https://${COLLIE}/issues/8` }),
          new Map(),
        ),
      ).toMatchObject({ publication: "linked", issue: `https://${COLLIE}/issues/8` });
      expect(writes(forge)).toEqual([]);
    }),
  ));

test("a closed issue the healer names for the cause is linked, not filed again", () =>
  onCollie({ issues: [issue(12, [FINDING.key], "closed")] }, (host, forge) =>
    Effect.gen(function* () {
      expect(yield* report(host, pending({ issue: 12 }), new Map())).toMatchObject({
        publication: "linked",
        issue: `https://${COLLIE}/issues/12`,
      });
      expect((yield* forge.model()).issues).toHaveLength(1);
      expect(writes(forge)).toEqual([]);
    }),
  ));

test("retained findings of earlier Heals link to the issues already filed for their causes, under every key", () =>
  onCollie(
    {
      issues: [
        issue(444, [
          "retired-agent-not-stopped-park-unrechecked",
          "ran-out-agent-not-quiet-parks-unknown",
          "ran-out-agent-not-stopped-parks-unknown",
        ]),
        issue(445, ["taken-delivery-left-unknown-blocks-reminders"]),
        issue(446, ["compaction-completion-lost-to-write-failure"]),
      ],
    },
    (host, forge) =>
      Effect.gen(function* () {
        const historical = [
          ["run-1d538c61", "retired-agent-not-stopped-park-unrechecked", 444],
          ["run-f6dfe7a5", "ran-out-agent-not-quiet-parks-unknown", 444],
          ["run-527aca67", "ran-out-agent-not-stopped-parks-unknown", 444],
          ["run-750ea061", "taken-delivery-left-unknown-blocks-reminders", 445],
          ["run-d6af1e3b", "compaction-completion-lost-to-write-failure", 446],
        ] as const;
        for (const [heal, key, number] of historical)
          expect(
            yield* report(host, pending({ key }, { heal, judged: "recovered" }), new Map()),
          ).toMatchObject({ publication: "linked", issue: `https://${COLLIE}/issues/${number}` });
        expect(writes(forge)).toEqual([]);
      }),
  ));
