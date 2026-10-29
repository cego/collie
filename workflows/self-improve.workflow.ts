// One day of Runs, read for what is wrong with the project it runs in (ADR-0053): filed on
// that project's forge, and up to `improvements` of it planned and built, with nobody asked.

import {
  Children,
  Host,
  Run,
  WorkflowError,
  agentWork,
  contentOf,
  defineWorkflow,
  step,
} from "collie";
import { hostname } from "node:os";
import { DateTime, Duration, Effect, FileSystem, Option, Result, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";
import markdown from "./self-improve.md" with { type: "text" };
import {
  type Finding,
  type Outcome,
  type Starting,
  Ended,
  FAILED_TO_START,
  MAX_FINDINGS,
  Triage,
  chosen,
  goalOf,
  keysIn,
  markerOf,
  restartsOf,
  sortOut,
  summaryOf,
  targetOf,
} from "./retrospective";

const content = contentOf(markdown);
const triage = content.template("triage", {
  checkout: Schema.String,
  state: Schema.String,
  release: Schema.String,
  since: Schema.String,
  runs: Schema.String,
  report: Schema.String,
  issues: Schema.String,
  bound: Schema.String,
  scope: Schema.String,
});

const DAY = Duration.hours(24);
const LOOKBACK = Duration.days(7);
const asJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const KeptJson = Schema.fromJsonString(Schema.Array(Ended));
const decodeKept = Schema.decodeUnknownOption(KeptJson);
const encodeKept = Schema.encodeSync(KeptJson);
const KeptRuns = Schema.Struct({
  earlier: Schema.Array(Schema.Struct({ created: Schema.String, ended: Schema.Array(Ended) })),
  since: Schema.Array(Schema.Struct({ created: Schema.String, closes: Schema.Array(Schema.Int) })),
});

const Count = Schema.Union([Schema.Int, Schema.NumberFromString.check(Schema.isInt())]).check(
  Schema.isGreaterThanOrEqualTo(0),
);

const Window = Schema.Struct({
  since: Schema.String,
  machine: Schema.String,
  runs: Schema.Array(Schema.String),
  report: Schema.Unknown,
});

const Scope = Schema.Literals(["checkout", "machine"]).annotate({
  description:
    "checkout reads this project's Runs; machine reads every Run on the Machine and also files Collie's defects",
});

const Opened = Schema.Array(
  Schema.Struct({
    number: Schema.Int,
    title: Schema.String,
    body: Schema.String,
    url: Schema.String,
    keys: Schema.Array(Schema.String),
  }),
);

const OutcomeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("filed"), number: Schema.Int, url: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("commented"), number: Schema.Int, url: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("refused"), reason: Schema.String }),
]);

const windowStep = step({
  id: "window",
  title: "Retrospective window",
  kind: "check",
  description: "Read the Runs in the requested retrospective window.",
});
const retroStep = step({
  id: "retro",
  title: "Retro",
  kind: "check",
  description: "Load the retrospective rules for this Machine.",
});
const triageStep = step({
  id: "triage",
  title: "Triage",
  kind: "agent",
  role: "retrospective",
  description: "Find actionable problems in the Runs and choose improvements.",
});
const filing = step({
  id: "filing",
  title: "Filing",
  kind: "check",
  description: "File new issues and add recurring evidence to existing ones.",
});
const improvementsStep = step({
  id: "improvements",
  title: "Improvements",
  kind: "workflow",
  description: "Start a plan and implementation for each selected improvement.",
});

export default defineWorkflow({
  id: "self-improve",
  connections: {
    uses: {
      gitlab: {
        with: "Files findings and plans improvements from issues",
        without: "Records the retrospective in the Run only",
      },
      github: {
        with: "Files findings and plans improvements from issues",
        without: "Records the retrospective in the Run only",
      },
    },
  },
  title: "self-improve — file and fix what a day of Runs shows is wrong with a project",
  description:
    "Reads the last 24 hours of Runs, this project's or the whole Machine's, with the installed retro skill, files or comments on this project's issues, and starts up to `improvements` plans that build themselves.",
  input: Schema.Struct({
    runs: Scope,
    improvements: Schema.optionalKey(
      Count.annotate({ description: "how many Improvements to start; 0 files without building" }),
    ),
  }),
  hints: { improvements: "goal" },
  // The checkout it was started in is shared and may be dirty or behind its remote.
  checkout: "roaming",
  output: Schema.String,
  agents: { harness: "claude", model: "opus", effort: "high" },
  path: [windowStep, retroStep, triageStep, filing, improvementsStep],
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const run = yield* Run;
      const children = yield* Children;
      const place = yield* host.place(run.id);
      const bound = input.improvements ?? 3;

      const window = yield* windowStep(
        Activity.make({
          name: "window",
          success: Window,
          error: WorkflowError,
          execute: Effect.gen(function* () {
            const since = DateTime.formatIso(DateTime.subtractDuration(yield* DateTime.now, DAY));
            const report = yield* host.report(since);
            const own = report.runs.find(({ runId }) => runId === run.id);
            if (own === undefined)
              return yield* new WorkflowError({
                reason: `${run.id} is not in its Machine's report`,
              });
            const kept = report.runs.filter(
              ({ runId, parent, project }) =>
                runId !== run.id &&
                parent !== run.id &&
                (input.runs === "machine" || project === own.project),
            );
            const ids = new Set(kept.map(({ runId }) => runId));
            const read = <A extends { readonly runId: string }>(list: ReadonlyArray<A>) =>
              list.filter(({ runId }) => ids.has(runId));
            return {
              since,
              machine: hostname(),
              runs: [...ids],
              // Another project's tallies and measures are not this one's to read.
              report:
                input.runs === "machine"
                  ? report
                  : {
                      since,
                      runs: kept,
                      failed: read(report.failed),
                      completed: read(report.completed),
                      stopped: read(report.stopped),
                    },
            };
          }),
        }),
      );
      const quiet = window.runs.length === 0;
      if (quiet && bound === 0) return `No Runs since ${window.since}`;

      const kept =
        bound === 0
          ? { earlier: [], since: [] }
          : yield* Activity.make({
              name: "kept",
              success: KeptRuns,
              error: WorkflowError,
              execute: Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                const since = DateTime.formatIso(
                  DateTime.subtractDuration(yield* DateTime.now, LOOKBACK),
                );
                const report = yield* host.report(since);
                const own = report.runs.find(({ runId }) => runId === run.id);
                const project = report.runs.filter(({ project }) => project === own?.project);
                const earlier = yield* Effect.forEach(
                  project.filter(
                    ({ runId, workflow }) => runId !== run.id && workflow === own?.workflow,
                  ),
                  ({ runId, created }) =>
                    host.place(runId).pipe(
                      Effect.flatMap(({ dir }) => fs.readFileString(`${dir}/improvements.json`)),
                      Effect.map((text) =>
                        decodeKept(text).pipe(Option.map((ended) => ({ created, ended }))),
                      ),
                      // A Run still going, or one from before Improvements were kept, has none.
                      Effect.orElseSucceed(() => Option.none()),
                    ),
                );
                return {
                  earlier: earlier.flatMap(Option.toArray),
                  since: project.map(({ created, closes }) => ({ created, closes })),
                };
              }),
            });
      const failedToStart = kept.earlier.some(({ ended }) =>
        ended.some((one) => one.ended.startsWith(FAILED_TO_START)),
      );
      if (quiet && !failedToStart) return `No Runs since ${window.since}`;

      const retro = retroStep(
        Activity.make({
          name: "retro",
          success: Schema.Void,
          error: WorkflowError,
          execute: host.skill("retro").pipe(
            Effect.flatMap((file) =>
              file === null
                ? new WorkflowError({
                    reason:
                      "the retro skill is not installed on this Machine: run prepare.sh, or collie upgrade",
                  })
                : Effect.void,
            ),
          ),
        }),
      );
      if (!quiet) yield* retro;

      const issues = yield* Activity.make({
        name: "issues",
        success: Schema.Union([Opened, Schema.Struct({ refused: Schema.String })]),
        error: WorkflowError,
        execute: host.issues(run.id).pipe(
          Effect.map((issues) => issues.map((issue) => ({ ...issue, keys: keysIn(issue.body) }))),
          Effect.catch((failure) => Effect.succeed({ refused: failure.reason })),
        ),
      });
      if ("refused" in issues) {
        yield* host.record(
          run.id,
          `Retrospective kept in the Run; no issues filed: ${issues.refused}`,
        );
        return `Retrospective kept in ${place.dir}; no issues filed: ${issues.refused}`;
      }
      const open = issues;

      const triaging = triageStep(
        agentWork({
          operation: "triage",
          role: "retrospective",
          instructions: triage,
          input: {
            checkout: place.cwd,
            state: host.dir,
            release: host.build,
            since: window.since,
            runs: window.runs.join("\n"),
            report: asJson(window.report),
            issues:
              open.length === 0
                ? "None."
                : open
                    .map(
                      ({ number, title, url, body }) =>
                        `### #${number} ${title}\n\n${url}\n\n${body}`,
                    )
                    .join("\n\n"),
            bound: String(bound),
            scope: content.sections.get(input.runs) ?? "",
          },
          output: Triage,
        }),
      );
      const triaged: Triage = quiet
        ? { findings: [], improvements: [], left_out: [] }
        : yield* triaging;

      const sorted = sortOut(
        triaged.findings,
        new Set(window.runs),
        open,
        input.runs === "machine",
      );
      const acted: Array<{ finding: Finding; outcome: Outcome }> = [];
      yield* filing(
        Effect.gen(function* () {
          for (const finding of sorted.kept.slice(0, MAX_FINDINGS)) {
            const target = targetOf(finding, open);
            const outcome = yield* Activity.make({
              name: `finding.${finding.key}`,
              success: OutcomeSchema,
              execute: (target === null
                ? host
                    .fileIssue({
                      runId: run.id,
                      title: finding.title,
                      body: [
                        finding.body,
                        markerOf(finding.key),
                        `Filed by Collie's self-improve Run ${run.id} on ${window.machine}.`,
                      ].join("\n\n"),
                    })
                    .pipe(Effect.map((filed): Outcome => ({ kind: "filed", ...filed })))
                : host
                    .commentIssue({
                      runId: run.id,
                      number: target.number,
                      body: `Seen again in ${finding.runs.join(", ")} on ${window.machine}, by self-improve Run ${run.id}.\n\n${markerOf(finding.key)}`,
                    })
                    .pipe(
                      Effect.as<Outcome>({
                        kind: "commented",
                        number: target.number,
                        url: target.url,
                      }),
                    )
              ).pipe(
                Effect.catch((refusal) =>
                  Effect.succeed<Outcome>({ kind: "refused", reason: refusal.reason }),
                ),
              ),
            });
            acted.push({ finding, outcome });
          }
        }),
      );

      const restarts = restartsOf(kept.earlier, kept.since, open);
      if (quiet && restarts.length === 0) return `No Runs since ${window.since}`;
      const outcomes = new Map(acted.map(({ finding, outcome }) => [finding.key, outcome]));
      const filedNumber = (key: string) => {
        const outcome = outcomes.get(key);
        return outcome?.kind === "filed" ? [outcome.number] : [];
      };
      const fresh = chosen(triaged.improvements, outcomes, bound).map(
        ({ name, keys }): Starting => ({ name, issues: keys.flatMap(filedNumber) }),
      );
      const starting = [
        ...restarts.filter(({ name }) => !fresh.some((one) => one.name === name)),
        ...fresh,
      ].slice(0, bound);
      // The issues as the forge holds them, so a goal carries only what the host let out. Read
      // by number: the forge's open listing can lag the issues this Run just filed.
      const published =
        starting.length === 0
          ? Result.succeed([])
          : yield* Effect.result(
              Activity.make({
                name: "published",
                success: Opened,
                error: WorkflowError,
                execute: host
                  .issues(run.id, [...new Set(starting.flatMap(({ issues }) => issues))])
                  .pipe(Effect.map((issues) => issues.map((issue) => ({ ...issue, keys: [] })))),
              }),
            );
      const improvements: ReadonlyArray<Ended> = yield* Effect.all(
        starting.map((improvement) =>
          improvementsStep(
            Effect.gen(function* () {
              if (Result.isFailure(published)) return yield* published.failure;
              const issues = improvement.issues.flatMap((number) =>
                published.success.filter((one) => one.number === number),
              );
              if (issues.length < improvement.issues.length)
                return yield* new WorkflowError({
                  reason: "an issue it fixes could not be read back from the forge",
                });
              const child = yield* children.start({
                invocation: `improvement-${improvement.name}`,
                workflow: "plan",
                input: {
                  goal: goalOf(issues),
                  // oxlint-disable-next-line unicorn/no-thenable -- plan's Input is named `then`
                  then: "implement",
                },
                ownTask: true,
              });
              return yield* children.result(child).pipe(
                Effect.as<Ended>({
                  name: improvement.name,
                  issues: improvement.issues,
                  runId: child.runId,
                  ended: "succeeded",
                }),
                Effect.catch((failure) =>
                  Effect.succeed<Ended>({
                    name: improvement.name,
                    issues: improvement.issues,
                    runId: child.runId,
                    ended: `failed: ${failure.reason}`,
                  }),
                ),
              );
            }).pipe(
              Effect.catch((failure) =>
                Effect.succeed<Ended>({
                  name: improvement.name,
                  issues: improvement.issues,
                  runId: null,
                  ended: `${FAILED_TO_START}: ${failure.reason}`,
                }),
              ),
            ),
            { item: improvement.name, items: starting.map((one) => one.name) },
          ),
        ),
        { concurrency: "unbounded" },
      );

      const file = `${place.dir}/summary.md`;
      yield* Activity.make({
        name: "summary",
        success: Schema.Void,
        error: WorkflowError,
        execute: FileSystem.FileSystem.pipe(
          Effect.flatMap((fs) =>
            Effect.andThen(
              fs.writeFileString(`${place.dir}/improvements.json`, encodeKept(improvements)),
              fs.writeFileString(
                file,
                summaryOf({
                  runId: run.id,
                  since: window.since,
                  acted,
                  improvements,
                  leftOut: [...triaged.left_out, ...sorted.leftOut],
                }),
              ),
            ),
          ),
          Effect.mapError((cause) => new WorkflowError({ reason: cause.message })),
        ),
      });
      const count = (kind: Outcome["kind"]) =>
        acted.filter(({ outcome }) => outcome.kind === kind).length;
      const failed = improvements.filter(({ ended }) => ended !== "succeeded").length;
      return `Filed ${count("filed")}, commented ${count("commented")}, refused ${count("refused")}; ${improvements.length} Improvements, ${failed} failed. ${file}`;
    }),
});
