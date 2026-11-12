import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Rec from "effect/Record";
import { Effect, Schema } from "effect";
import { mrRefOf } from "./board-model";
import { forgeOf } from "./forge/forge";
import { appendJournal, readJournal } from "./journal";
import { projectHere, shell, whatItSaid } from "./mr";
import type { RunView } from "./engine";
import type { Herdr } from "./herdr";

const CiTarget = Schema.fromJsonString(
  Schema.Struct({
    head: Schema.String,
    job: Schema.String,
    mr: Schema.NullOr(Schema.String),
    cwd: Schema.String,
  }),
);

export const rememberCiTarget = (dir: string, target: typeof CiTarget.Type) =>
  appendJournal(`${dir}/ci-rechecks.jsonl`, CiTarget, target);

const reply = (cleared: boolean, note: string, error = false) => ({ cleared, note, error });

export const recheckPark = (
  view: Pick<RunView, "park" | "cwd" | "runId" | "mr" | "branch"> &
    Partial<Pick<RunView, "input" | "strategies">>,
  stateDir: string,
  herdr: Pick<Herdr, "sessionList">,
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
      case "ci-job-absent": {
        const targets = yield* readJournal(
          `${stateDir}/runs/${view.runId}/ci-rechecks.jsonl`,
          CiTarget,
        ).pipe(Effect.orElseSucceed(() => []));
        const head = targets[targets.length - 1]?.head;
        const latest = new Map(
          Arr.map(
            Arr.filter(targets, (target) => target.head === head),
            (target) => [target.job, target],
          ),
        );
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
      case "herdr-unavailable": {
        const read = yield* herdr.sessionList().pipe(Effect.result);
        return read._tag === "Success"
          ? reply(true, "herdr answered")
          : reply(false, String(read.failure), true);
      }
      default:
        return reply(false, "cause has no recheck");
    }
  });
