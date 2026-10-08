// A yes or a no to a proposal, what became of a Run's work, a steer and a follow-up are
// each the host's operations, under the front door that asked, and the same request twice
// is one operation.

import { expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, Schema } from "effect";
import { readAudit } from "../src/audit";
import { readDispositions } from "../src/disposition";
import { runDir } from "../src/engine";
import { EVIDENCE_GATE } from "../src/board-model";
import { connect } from "../src/host";
import { nothingApproved } from "../src/outcome";
import { proposalsPath, read as readProposals, record as recordProposal } from "../src/proposals";
import { defaultsPath, readDefaults } from "../src/intent";
import { scopeKey } from "../src/registry";
import {
  NATIVE,
  NEWS_TRAIL,
  append as appendNews,
  newsPath,
  newsTrail,
  pending,
  read as readNews,
} from "../src/news";
import { herdDir } from "../src/steering";
import { stopHost, until } from "./support/host";
import { collie, proves } from "./support/world";

const answers = (lines: ReadonlyArray<{ readonly kind: string }>) =>
  lines.filter((line) => line.kind === "confirmed" || line.kind === "declined");

test(
  "a proposal is confirmed or declined by the host, by its id and hash, once per request",
  () =>
    proves(
      "collie-writer-proposal-",
      (world) =>
        Effect.gen(function* () {
          const file = yield* proposalsPath(world.state, "some-herd");
          const proposed = (why: string) =>
            recordProposal(file, {
              interpretation: why,
              targets: [],
              actions: [{ kind: "none", why }],
              allowedNow: [],
              intentVersions: {},
              by: "evaluator:e-1",
            });
          const first = yield* proposed("nothing to do");
          const second = yield* proposed("still nothing");
          const client = yield* connect(world.state);
          yield* client.declare({ frontDoor: "chat" });

          const wrong = yield* client
            .confirm({ proposal: first.id, hash: "not-it", request: "r-0" })
            .pipe(Effect.flip);
          expect(wrong).toMatchObject({ _tag: "ProposalRefused", refused: "hash_mismatch" });

          const yes = { proposal: first.id, hash: first.content_hash, request: "r-1" };
          const done = yield* client.confirm(yes);
          const changed = yield* client.confirm({ ...yes, hash: "other" }).pipe(Effect.flip);
          expect(changed).toMatchObject({ _tag: "ProposalRefused", refused: "hash_mismatch" });
          expect(done.results).toEqual([
            { index: 0, kind: "none", state: "applied", note: "nothing to do", run: null },
          ]);
          expect(yield* client.confirm(yes)).toEqual(done);
          const conflict = yield* client
            .decline({ proposal: second.id, hash: second.content_hash, request: "r-1" })
            .pipe(Effect.flip);
          expect(conflict._tag).toBe("RequestConflict");

          yield* client.decline({ proposal: second.id, hash: second.content_hash, request: "r-2" });
          expect(answers(yield* readProposals(file))).toMatchObject([
            { kind: "confirmed", id: first.id, by: "chat:r-1" },
            { kind: "declined", id: second.id, by: "chat:r-2" },
          ]);
          const missing = yield* client
            .decline({ proposal: "p-none", hash: "x", request: "r-3" })
            .pipe(Effect.flip);
          expect(missing).toMatchObject({ _tag: "ProposalRefused", refused: "not_found" });
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      [],
    ),
  120_000,
);

test(
  "a confirm retried while its carry-out still runs answers what it came to",
  () =>
    proves(
      "collie-writer-inflight-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const hold = `${world.state}/hold-pane-list`;
          yield* fs.writeFileString(hold, "");
          Bun.env.FAKE_HERDR_HOLD_PANE_LIST = hold;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => delete Bun.env.FAKE_HERDR_HOLD_PANE_LIST),
          );
          const file = yield* proposalsPath(world.state, "some-herd");
          const proposal = yield* recordProposal(file, {
            interpretation: "tidy the Home",
            targets: [],
            actions: [{ kind: "home_cleanup" }],
            allowedNow: [],
            intentVersions: {},
            by: "evaluator:e-1",
          });
          const yes = { proposal: proposal.id, hash: proposal.content_hash, request: "r-1" };
          // The first asker hangs up once its step has started.
          const first = yield* Effect.forkChild(
            Effect.scoped(Effect.flatMap(connect(world.state), (client) => client.confirm(yes))),
          );
          yield* until(
            () => readProposals(file),
            (lines) => lines.some((line) => line.kind === "step" && line.state === "started"),
          );
          yield* Fiber.interrupt(first);
          // A confirm under another request is refused, and leaves the running one alone.
          const client = yield* connect(world.state);
          const other = yield* client.confirm({ ...yes, request: "r-2" }).pipe(Effect.flip);
          expect(other).toMatchObject({ _tag: "ProposalRefused", refused: "not_pending" });
          const retried = yield* Effect.forkChild(client.confirm(yes));
          // Long enough for the retry to reach the host while the step is still held.
          yield* Effect.sleep("1 second");
          yield* fs.remove(hold);
          const answered = yield* Fiber.join(retried);
          expect(answered.results).toMatchObject([
            { index: 0, kind: "home_cleanup", state: "applied" },
          ]);
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      [],
    ),
  120_000,
);

test(
  "what chat asks for is recorded and carried out by the host, once per request",
  () =>
    proves(
      "collie-writer-propose-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const file = yield* proposalsPath(world.state, "some-herd");
          const client = yield* connect(world.state);
          yield* client.declare({ frontDoor: "chat" });
          const asked = {
            herd: "some-herd",
            interpretation: "nothing, on purpose",
            actions: [{ kind: "none", why: "nothing to do" }],
            request: "q-1",
          };

          const said = yield* client.propose(asked);
          expect(said.ok).toBe(true);
          expect(yield* client.propose(asked)).toEqual(said);
          const lines = yield* readProposals(file);
          expect(lines.filter((line) => line.kind === "proposal")).toMatchObject([
            { by: "chat:q-1" },
          ]);
          expect(answers(lines)).toMatchObject([{ kind: "confirmed", by: "chat:q-1" }]);

          const unknown = yield* client.propose({
            ...asked,
            actions: [{ kind: "rm-rf" }],
            request: "q-2",
          });
          expect(unknown).toMatchObject({ ok: false, code: "invalid_input" });
          const escaped = yield* client.propose({ ...asked, herd: "../../x", request: "q-6" });
          expect(escaped).toMatchObject({ ok: false, code: "invalid_input" });
          expect(yield* fs.exists(`${world.state}/../x`)).toBe(false);
          const acted = yield* client
            .act({ actions: [{ kind: "rm-rf" }], request: "q-3" })
            .pipe(Effect.flip);
          expect(acted._tag).toBe("HostRefused");
          const nobody = yield* client
            .reconcile({ proposal: "p-none", index: 0, as: "applied", request: "q-4" })
            .pipe(Effect.flip);
          expect(nobody).toMatchObject({ _tag: "ProposalRefused", refused: "not_found" });
          // The same request asking for something else is refused, not answered with the first.
          const other = yield* client.propose({ ...asked, interpretation: "something else" });
          expect(other).toMatchObject({ ok: false, code: "invalid_input" });
          // What Collie would want of its own accord is a proposal, never an act.
          const unasked = yield* client
            .act({ actions: [{ kind: "home_cleanup" }], request: "q-5" })
            .pipe(Effect.flip);
          expect(unasked._tag).toBe("HostRefused");
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      [],
    ),
  120_000,
);

test(
  "what became of a Run and its follow-up are the host's to write, stamped with who asked",
  () =>
    proves(
      "collie-writer-run-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const client = yield* connect(world.state);
          yield* client.declare({ frontDoor: "board" });
          const started = yield* client.start({
            project: world.project,
            id: "followed",
            request: "s-1",
            input: { text: "first" },
          });
          const runId = started.runId;
          yield* until(
            () => client.run({ runId }),
            (view) => view?.status.status === "complete",
          );

          // A retried act is one operation per step: one follow-up, however often it is sent.
          const followUp = {
            actions: [{ kind: "followup", run: runId, text: "more" }],
            request: "a-1",
          };
          const acted = yield* client.act(followUp);
          expect(yield* client.act(followUp)).toEqual(acted);
          const children = (yield* client.runs({ task: null })).filter(
            (one) => one.parent === runId,
          );
          expect(children).toHaveLength(1);
          // A propose cut off before its answer was kept is carried out again as the same steps.
          const proposed = {
            ...followUp,
            herd: "some-herd",
            interpretation: "more",
            request: "p-1",
          };
          yield* client.propose(proposed);
          yield* fs.remove(`${world.state}/herd/some-herd/operations.jsonl`);
          yield* client.propose(proposed);
          const afterPropose = (yield* client.runs({ task: null })).filter(
            (one) => one.parent === runId,
          );
          expect(afterPropose).toHaveLength(2);

          const child = yield* client.followUp({ runId, text: "what is left", request: "f-1" });
          expect((yield* client.run({ runId: child.runId }))?.parent).toBe(runId);
          expect(
            (yield* client.followUp({ runId, text: "what is left", request: "f-1" })).runId,
          ).toBe(child.runId);
          const unknown = yield* client
            .followUp({ runId: "run-none", text: "x", request: "f-2" })
            .pipe(Effect.flip);
          expect(unknown._tag).toBe("HostRefused");

          const asked = { runId, kind: "merged", ref: "mr!7", note: null, request: "d-1" } as const;
          const line = yield* client.dispose(asked);
          expect(line).toMatchObject({ kind: "merged", ref: "mr!7", by: "human:d-1" });
          expect(yield* client.dispose(asked)).toEqual(line);
          const otherwise = yield* client
            .dispose({ ...asked, kind: "abandoned" })
            .pipe(Effect.flip);
          expect(otherwise._tag).toBe("RequestConflict");
          // Focused on this Machine's own herdr, which here has nothing of the Run's left.
          expect(yield* client.focus({ runId, request: "fo-1" }).pipe(Effect.flip)).toMatchObject({
            _tag: "HostRefused",
            reason: `${runId} has no pane or workspace herdr still has`,
          });
          yield* client.grant({ runId, name: "lint", command: null, request: "g-1" });
          const dir = runDir(world.state, runId);
          expect(yield* readDispositions(dir)).toEqual([line]);
          expect(
            (yield* readAudit(dir)).map((one) => [one.operation, one.actor.origin, one.request]),
          ).toEqual([
            ["start", "board", "s-1"],
            ["followup", "board", "a-1:0"],
            ["followup", "board", "p-1:0"],
            ["followup", "board", "f-1"],
            ["disposition", "board", "d-1"],
            ["grant", "board", "g-1"],
          ]);
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      ["followed.workflow.ts"],
    ),
  120_000,
);

const CLAUDE_HELP = [
  "--print",
  "--output-format",
  "--json-schema",
  "--tools",
  "--restricted",
  "--strict-mcp-config",
  "--setting-sources",
  "--no-session-persistence",
  "--append-system-prompt-file",
].join(" ");

test(
  "a steer from the command line is the host's: it asks, records and carries out",
  () =>
    proves(
      "collie-writer-steer-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const bin = `${world.home}/bin`;
          yield* fs.makeDirectory(bin, { recursive: true });
          const env = {
            PATH: `${bin}:/usr/bin:/bin`,
            HERDR_SOCKET_PATH: `${world.state}/herd.sock`,
          };
          const started = yield* collie(
            world,
            ["run", "start", "plain", "--input", "note=hi"],
            env,
          );
          const { runId } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(started.envelope.data);
          const answer = `{"interpretation":"nothing needs doing","targets":[{"run":"${runId}"}],"actions":[{"kind":"none","why":"it is fine"}],"confidence":1}`;
          yield* fs.writeFileString(
            `${bin}/claude`,
            `#!/bin/sh\n[ "$1" = --help ] && echo '${CLAUDE_HELP}' && exit 0\ncat >/dev/null\necho '${answer}'\n`,
            { mode: 0o755 },
          );

          const said = yield* collie(
            world,
            ["steer", "is it all right?", "--target", `run:${runId}`],
            env,
          );
          expect(said.envelope).toMatchObject({ ok: true });
          const audit = yield* readAudit(runDir(world.state, runId));
          expect(audit.map((one) => [one.operation, one.actor.origin])).toContainEqual([
            "steer",
            "cli",
          ]);
          // The same request again is the same steer: nobody is asked twice.
          const client = yield* connect(world.state);
          const again = { runId, text: "and now?", from: null, dryRun: false, request: "st-1" };
          const first = yield* client.steerAbout(again);
          expect(first.ok).toBe(true);
          yield* fs.writeFileString(`${bin}/claude`, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
          expect(yield* client.steerAbout(again)).toEqual(first);
          const herds = yield* fs.readDirectory(`${world.state}/herd`);
          const journal = yield* readProposals(`${world.state}/herd/${herds[0]}/proposals.jsonl`);
          expect(answers(journal)).toMatchObject([{ kind: "confirmed" }, { kind: "confirmed" }]);
          // A steer from another herdr session is carried out in that session.
          const other = `${world.state}/other.sock`;
          const defaults = answer.replace(
            '{"kind":"none","why":"it is fine"}',
            '{"kind":"update_defaults","change":"add-constraint","workspace":"w1","text":"no rebase"}',
          );
          yield* fs.writeFileString(
            `${bin}/claude`,
            `#!/bin/sh\n[ "$1" = --help ] && echo '${CLAUDE_HELP}' && exit 0\ncat >/dev/null\necho '${defaults}'\n`,
            { mode: 0o755 },
          );
          const elsewhere = yield* connect(world.state);
          yield* elsewhere.declare({ frontDoor: "cli", session: other });
          const steered = yield* elsewhere.steerAbout({ ...again, request: "st-2" });
          expect(steered.ok).toBe(true);
          const theirs = yield* defaultsPath(
            world.state,
            scopeKey({ session: other, workspaceId: "w1", cwd: world.project }),
          );
          expect((yield* readDefaults(theirs))?.constraints.map((c) => c.text)).toEqual([
            "no rebase",
          ]);
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      ["plain.workflow.ts"],
    ),
  120_000,
);

test(
  "a gate is answered through the host: the checks offered are granted and the Run carries on",
  () =>
    proves(
      "collie-writer-gate-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const client = yield* connect(world.state);
          const started = yield* client.start({
            project: world.project,
            id: "gated",
            request: "g-0",
            input: { note: "x" },
          });
          const runId = started.runId;
          yield* until(
            () => client.run({ runId }),
            (view) => view?.parked === nothingApproved(runId),
          );
          const gate = { runId, decision: EVIDENCE_GATE, request: "g-1" };
          const skipped = yield* client.answer({ ...gate, value: "skip" }).pipe(Effect.flip);
          expect(skipped._tag).toBe("HostRefused");

          yield* fs.makeDirectory(`${world.project}/.collie`, { recursive: true });
          yield* fs.writeFileString(
            `${world.project}/.collie/verify.json`,
            '[{"name":"true","executable":"true","argv":[],"cwd":"worktree"}]',
          );
          yield* client.answer({ ...gate, value: "approve", request: "g-2" });
          const done = yield* until(
            () => client.run({ runId }),
            (view) => view?.status.status === "complete",
          );
          expect(done?.status).toMatchObject({ value: "true" });
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      ["gated.workflow.ts"],
    ),
  120_000,
);

test(
  "a Repo run's gate is answered on that Repo run, which carries on, and its fan-out is left alone",
  () =>
    proves(
      "collie-writer-repo-gate-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const client = yield* connect(world.state);
          const parent = yield* client.start({
            project: world.project,
            id: "plain",
            request: "p-0",
            input: { note: "fan" },
          });
          const started = yield* client.start({
            project: world.project,
            id: "gated",
            request: "g-0",
            input: { note: "x" },
            parent: parent.runId,
            options: { repo: "api" },
          });
          const runId = started.runId;
          yield* until(
            () => client.run({ runId }),
            (view) => view?.parked === nothingApproved(runId),
          );
          yield* fs.makeDirectory(`${world.project}/.collie`, { recursive: true });
          yield* fs.writeFileString(
            `${world.project}/.collie/verify.json`,
            '[{"name":"true","executable":"true","argv":[],"cwd":"worktree"}]',
          );
          yield* client.answer({
            runId,
            decision: EVIDENCE_GATE,
            value: "approve",
            request: "g-1",
          });
          const done = yield* until(
            () => client.run({ runId }),
            (view) => view?.status.status === "complete",
          );
          expect(done?.status).toMatchObject({ value: "true" });
          const operations = (id: string) =>
            readAudit(runDir(world.state, id)).pipe(
              Effect.map((lines) => lines.map((line) => line.operation)),
            );
          expect(yield* operations(runId)).toContain("answer");
          expect(yield* operations(parent.runId)).not.toContain("answer");
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      ["gated.workflow.ts", "plain.workflow.ts"],
    ),
  120_000,
);

test(
  "a conversation can take every pending item and settle only the ones it delivered",
  () =>
    proves(
      "collie-writer-news-keys-",
      (world) =>
        Effect.gen(function* () {
          const file = yield* newsPath(world.state, "some-herd");
          yield* appendNews(file, {
            key: "r1:ended:failed",
            run: "r1",
            text: "r1 failed.",
            significance: "consequential",
          });
          yield* appendNews(file, {
            key: "r2:asking:x",
            run: "r2",
            text: "r2 asks.",
            significance: "decision",
          });
          const client = yield* connect(world.state);
          yield* client.declare({ frontDoor: "chat" });
          const asked = { herd: "some-herd", conversation: "flock@pc", as: "read" as const };
          const peeked = yield* client.news({ ...asked, request: "k-1", keys: [] });
          expect(peeked.items.map(({ key, significance }) => [key, significance])).toEqual([
            ["r1:ended:failed", "consequential"],
            ["r2:asking:x", "decision"],
          ]);
          yield* client.news({ ...asked, request: "k-2", keys: ["r2:asking:x"] });
          const left = yield* client.news({ ...asked, request: "k-3", keys: [] });
          yield* stopHost(world.state);
          expect(left.items.map(({ key }) => key)).toEqual(["r1:ended:failed"]);
        }),
      [],
    ),
  120_000,
);

test(
  "a conversation's News receipts are the host's, once per request, and that conversation's alone",
  () =>
    proves(
      "collie-writer-news-",
      (world) =>
        Effect.gen(function* () {
          const file = yield* newsPath(world.state, "some-herd");
          yield* appendNews(file, { key: "r1:ended:failed", run: "r1", text: "r1 failed." });
          const client = yield* connect(world.state);
          yield* client.declare({ frontDoor: "chat" });
          const asked = {
            herd: "some-herd",
            conversation: "flock@pc",
            as: "read" as const,
            request: "n-1",
          };
          const first = yield* client.news(asked);
          expect(first.items.map((item) => item.key)).toEqual(["r1:ended:failed"]);
          // The same request is the same batch, not the nothing a second read would find.
          expect(yield* client.news(asked)).toEqual(first);
          expect((yield* client.news({ ...asked, request: "n-2" })).items).toEqual([]);
          const sent = yield* client.news({ ...asked, as: "sent" }).pipe(Effect.flip);
          expect(sent._tag).toBe("RequestConflict");
          const lines = yield* readNews(file);
          expect(pending(lines, NATIVE).items).toHaveLength(1);
          const trail = yield* newsTrail(world.state, "some-herd");
          const audit = yield* readAudit(trail);
          expect(audit.map((one) => [one.operation, one.actor.origin, one.request])).toEqual([
            ["news", "chat", "n-1"],
            ["news", "chat", "n-2"],
          ]);
          // Read every turn, so its trail is bounded and the Herd's own audit takes none of it.
          for (let n = 0; n < NEWS_TRAIL + 5; n++)
            yield* client.news({ ...asked, request: `more-${n}` });
          const kept = yield* readAudit(trail);
          yield* stopHost(world.state);
          expect(kept).toHaveLength(NEWS_TRAIL);
          expect(kept.at(-1)?.request).toBe(`more-${NEWS_TRAIL + 4}`);
          expect(yield* readAudit(yield* herdDir(world.state, "some-herd"))).toEqual([]);
        }),
      [],
    ),
  120_000,
);
