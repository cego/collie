import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Rec from "effect/Record";
import { Effect, Schema } from "effect";
import { mrRefOf } from "./board-model";
import { forgeOf } from "./forge/forge";
import { appendRunJournal, readRunJournal, runJournal } from "./journal";
import { projectHere, shell, whatItSaid } from "./mr";
import type { RunView } from "./engine";
import { herdrFailureReason } from "./herdr";
import type { Herdr } from "./herdr";
import { parkText } from "./park-cause";
import type { ParkCause } from "./park-cause";
import { readStepLines } from "./steps";
import { isSettledDelivery, newestById, readLedger } from "./steering";

const CiTarget = Schema.fromJsonString(
  Schema.Struct({
    head: Schema.String,
    job: Schema.String,
    mr: Schema.NullOr(Schema.String),
    cwd: Schema.String,
  }),
);

export const rememberCiTarget = (dir: string, target: typeof CiTarget.Type) =>
  appendRunJournal(runJournal(dir, "ci-rechecks.jsonl"), CiTarget, target);

const FailedCi = Schema.fromJsonString(
  Schema.Struct({
    head: Schema.String,
    name: Schema.String,
    mr: Schema.String,
    cwd: Schema.String,
  }),
);

const failedCiJournal = (dir: string) => runJournal(dir, "ci-failed.jsonl");

export const rememberFailedCi = (dir: string, target: typeof FailedCi.Type) =>
  Effect.gen(function* () {
    const last = (yield* readRunJournal(failedCiJournal(dir), FailedCi).pipe(
      Effect.orElseSucceed(() => []),
    )).at(-1);
    if (last?.head === target.head && last.mr === target.mr) return;
    yield* appendRunJournal(failedCiJournal(dir), FailedCi, target);
  });

const UnsettledDelivery = Schema.fromJsonString(
  Schema.Struct({ terminal: Schema.String, delivery: Schema.String }),
);

const unsettledJournal = (dir: string) => runJournal(dir, "unsettled-deliveries.jsonl");

export const rememberUnsettled = (dir: string, held: typeof UnsettledDelivery.Type) =>
  appendRunJournal(unsettledJournal(dir), UnsettledDelivery, held);

const lastUnsettled = (dir: string) =>
  Effect.map(
    readRunJournal(unsettledJournal(dir), UnsettledDelivery).pipe(Effect.orElseSucceed(() => [])),
    (held) => held.at(-1),
  );

const lastFailedCi = (dir: string) =>
  Effect.map(
    readRunJournal(failedCiJournal(dir), FailedCi).pipe(Effect.orElseSucceed(() => [])),
    (targets) => targets.at(-1),
  );

export const parkEvidence = (
  stateDir: string,
  runId: string,
  cwd: string,
  cause: ParkCause,
  text: string,
) =>
  Effect.gen(function* () {
    const dir = `${stateDir}/runs/${runId}`;
    switch (cause) {
      case "ci-job-absent":
      case "target-red":
        return Arr.flatMap([...(yield* lastCiTargets(stateDir, runId)).values()], (target) => [
          target.head,
          target.job,
        ]);
      case "ci-failed": {
        const target = yield* lastFailedCi(dir);
        return target === undefined ? [] : [target.head, target.name];
      }
      case "delivery-unsettled": {
        const held = yield* lastUnsettled(dir);
        return held === undefined ? [] : [held.delivery];
      }
      default: {
        const step = Arr.findLast(yield* readStepLines(dir), (line) => line.kind === "enter");
        const head = yield* shell("git", ["rev-parse", "HEAD"], cwd);
        return [
          step._tag === "Some" && step.value.kind === "enter" ? step.value.key : "",
          head.code === 0 ? Str.trim(head.stdout) : "",
          parkText(text),
        ];
      }
    }
  });

const reply = (cleared: boolean, note: string, error = false) => ({ cleared, note, error });

const lastCiTargets = (stateDir: string, runId: string) =>
  Effect.map(
    readRunJournal(runJournal(`${stateDir}/runs/${runId}`, "ci-rechecks.jsonl"), CiTarget).pipe(
      Effect.orElseSucceed(() => []),
    ),
    (targets) => {
      const head = targets.at(-1)?.head;
      return new Map(
        Arr.map(
          Arr.filter(targets, (target) => target.head === head),
          (target) => [target.job, target],
        ),
      );
    },
  );

export const recheckPark = (
  view: Pick<RunView, "park" | "cwd" | "runId" | "mr" | "branch"> &
    Partial<Pick<RunView, "input" | "strategies">>,
  stateDir: string,
  herdr: Pick<Herdr, "agentList">,
) =>
  Effect.gen(function* () {
    switch (view.park?.cause) {
      case "checkout-dirty-collie": {
        const read = yield* shell(
          "git",
          ["status", "--porcelain", "--untracked-files=all"],
          view.cwd,
        );
        return read.code !== 0
          ? reply(false, whatItSaid(read), true)
          : reply(
              Str.trim(read.stdout) === "",
              Str.trim(read.stdout) === "" ? "checkout clean" : "checkout still dirty",
            );
      }
      case "target-red": {
        const latest = yield* lastCiTargets(stateDir, view.runId);
        if (latest.size === 0) return reply(false, "no parked CI job recorded");
        const passed: Array<string> = [];
        for (const target of latest.values()) {
          const ref = mrRefOf(target.mr);
          if (ref === null) return reply(false, `job ${target.job} has no merge request`);
          const read = yield* forgeOf(ref).targetJob(ref, target.job, target.cwd, shell);
          if (!read.ok) return reply(false, read.reason, true);
          if (read.state !== "passed")
            return reply(false, `job ${target.job} is ${read.state} on ${read.branch}`);
          passed.push(`${target.job} on ${read.branch} at ${read.at ?? ""}`);
        }
        return reply(true, `passed: ${Arr.join(passed, ", ")}`);
      }
      case "ci-job-absent": {
        const latest = yield* lastCiTargets(stateDir, view.runId);
        if (latest.size === 0) return reply(false, "no parked CI job recorded");
        for (const target of latest.values()) {
          const ref = mrRefOf(target.mr);
          if (ref === null) return reply(false, `job ${target.job} has no merge request`);
          const read = yield* forgeOf(ref).job(ref, target.job, target.cwd, shell);
          if (!read.ok) return reply(false, read.reason, true);
          if (
            read.head !== target.head ||
            read.state === "missing" ||
            (read.state === "pending" && read.id === null && read.url === null)
          )
            return reply(false, `job ${target.job} absent at ${target.head}`);
        }
        return reply(true, `jobs ${Arr.join([...latest.keys()], ", ")} present at parked head`);
      }
      case "ci-failed": {
        const targets = yield* readRunJournal(
          failedCiJournal(`${stateDir}/runs/${view.runId}`),
          FailedCi,
        ).pipe(Effect.orElseSucceed(() => []));
        const target = targets.at(-1);
        if (target === undefined) return reply(false, "no failed pipeline recorded");
        const ref = mrRefOf(target.mr);
        if (ref === null) return reply(false, `${target.mr} is not a merge request`);
        const read = yield* forgeOf(ref).readReview(ref, target.cwd, shell);
        if (!read.ok) return reply(false, read.reason, true);
        if (read.state !== "open") return reply(true, `${target.mr} is ${read.state}`);
        if (read.head !== target.head) return reply(true, `head moved to ${read.head}`);
        return read.pipeline.state === "failed"
          ? reply(false, `${target.name} still failed at ${target.head}`)
          : reply(true, `the pipeline at ${target.head} is ${read.pipeline.state}`);
      }
      case "forge-unavailable": {
        let ref = mrRefOf(view.mr);
        for (const [name, value] of Rec.toEntries(view.input ?? {}))
          if (
            ref === null &&
            view.strategies?.[name] === "diff-target" &&
            Schema.is(Schema.String)(value)
          )
            ref = mrRefOf(value);
        if (ref !== null) {
          const read = yield* forgeOf(ref).details(ref, view.cwd, shell);
          return read._tag === "Details"
            ? reply(true, "forge answered")
            : reply(false, read.reason, true);
        }
        const project = yield* projectHere(view.cwd, shell);
        if (project === null) return reply(false, "no forge project recorded");
        const branch = view.branch ?? "HEAD";
        const read = yield* forgeOf({ project, iid: "" }).forBranch(
          project,
          branch,
          view.cwd,
          shell,
        );
        return read.ok ? reply(true, "forge answered") : reply(false, read.reason, true);
      }
      case "delivery-unsettled": {
        const held = yield* lastUnsettled(`${stateDir}/runs/${view.runId}`);
        if (held === undefined) return reply(false, "no unsettled delivery recorded");
        const now = newestById(yield* readLedger(held.terminal)).get(held.delivery);
        return now === undefined || !isSettledDelivery(now)
          ? reply(false, `delivery ${held.delivery} is ${now?.state ?? "not in its ledger"}`)
          : reply(true, `delivery ${held.delivery} is ${now.state}`);
      }
      case "herdr-unavailable": {
        const read = yield* herdr.agentList().pipe(Effect.result);
        return read._tag === "Success"
          ? reply(true, "core listed its agents")
          : reply(false, herdrFailureReason(read.failure), true);
      }
      default:
        return reply(false, "cause has no recheck");
    }
  });
