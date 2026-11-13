import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Config, Effect, FileSystem, Schema, flow, Result } from "effect";
import { connect } from "../src/host";
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
const healed = (world: World, output: unknown, github: ForgeModel) =>
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
