import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { runEffect } from "./support/effect";
import { openHost, runDirOf, workspace } from "./support/host";
import { Rig } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { FORGE_HOST, PROJECT, forgeOnPath, serveForges } from "./support/forge";
import { mrTarget } from "../src/board-model";

const HEAD = "1234567890abcdef1234567890abcdef12345678";

for (const [name, action] of [
  ["gitlab", "post"],
  ["gitlab", "approval"],
  ["github", "post"],
  ["github", "approval"],
] as const)
  test(
    `the shipped host recovers a ${name} review accepted before its Activity recorded the ${action}`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const rig = yield* Rig.scoped();
          const { state, wf } = yield* workspace(`collie-review-recovery-${name}-`);
          const bin = yield* Effect.acquireRelease(FakeBin.make(`${rig.root}/bin`), (bin) =>
            bin.restore(),
          );
          const forge = yield* forgeOnPath(bin, name, {
            installed: true,
            loggedIn: [FORGE_HOST[name]],
            login: "tester",
            mrs: [{ project: PROJECT[name], iid: "30", state: "open", author: "ann", head: HEAD }],
          });
          const accepted = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          let held = false;
          const approvalRoute = name === "gitlab" ? "/approve" : "/reviews";
          const api = yield* serveForges({
            forge: name,
            face: (url, init) =>
              forge.face(url, init).then((response) => {
                if (
                  init?.method !== "POST" ||
                  !Str.endsWith(
                    action === "approval"
                      ? approvalRoute
                      : name === "gitlab"
                        ? "/notes"
                        : "/comments",
                  )(url) ||
                  held
                )
                  return response;
                held = true;
                accepted.resolve();
                return release.promise.then(() => response);
              }),
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()));
          const env = {
            ...rig.env(),
            PATH: `${bin.dir}:${rig.env().PATH}`,
            HERDR_PLUGIN_STATE_DIR: state,
            COLLIE_USER_DIR: `${wf}/..`,
            HERDR_PLUGIN_ROOT: `${wf}/../..`,
            COLLIE_FORGE_API: api,
          };
          const first = yield* openHost(state, { env });
          expect(
            (yield* first.ask({ op: "load", entry: `${wf}/posted-review.workflow.ts` })).ok,
          ).toBe(true);
          expect(
            (yield* first.ask({
              op: "start",
              id: "posted-review",
              runId: "r1",
              input: {
                target: mrTarget(PROJECT[name], "30"),
                head: HEAD,
                approve: action === "approval",
              },
            })).ok,
          ).toBe(true);
          yield* Effect.promise(() => accepted.promise).pipe(Effect.timeout("30 seconds"));
          expect(Rec.values((yield* forge.model()).notes ?? {}).flat()).toHaveLength(1);
          if (action === "approval") expect((yield* forge.model()).approved).toHaveLength(1);
          yield* first.child.kill({ killSignal: "SIGKILL" });
          yield* first.child.exitCode.pipe(Effect.ignore);
          release.resolve();
          const next = yield* openHost(state, { env });
          expect(next.child.pid).not.toBe(first.child.pid);
          const completed = yield* next.until(
            { op: "poll", id: "posted-review", runId: "r1" },
            (reply) => reply.status === "complete" || reply.status === "failed",
          );
          if (action === "approval") {
            expect(
              Arr.filter(
                forge.requests(),
                (one) => one.method === "POST" && Str.endsWith(approvalRoute)(one.url),
              ),
            ).toHaveLength(1);
            expect(completed.status).toBe("failed");
            expect(completed.value).toContain("uncertain");
          } else {
            expect(completed.status).toBe("complete");
            expect(completed.value).toContain("posted the review");
          }
          const runId = Str.split(yield* runDirOf(state, "r1"), "/").at(-1);
          const notes = Rec.values((yield* forge.model()).notes ?? {}).flat();
          expect(notes).toHaveLength(1);
          expect(Str.split(notes[0] ?? "", "\n").at(-1)).toBe(
            `Review by Collie for @tester · ${runId} round 1 at ${HEAD}`,
          );
          expect(
            Arr.filter(
              forge.requests(),
              (one) =>
                one.method === "POST" &&
                Str.endsWith(name === "gitlab" ? "/notes" : "/comments")(one.url),
            ),
          ).toHaveLength(1);
          yield* next.stop;
        }),
      ),
    180_000,
  );
