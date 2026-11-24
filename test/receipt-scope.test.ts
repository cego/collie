import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, Option, Schema, flow, Result } from "effect";
import { readAudit } from "../src/audit";
import { runDir } from "../src/engine";
import { recordsReadLayer } from "../src/records";
import { collie, proves } from "./support/world";
import type { World } from "./support/world";
import { until } from "./support/host";
import { registeredAt } from "./support/records";
import { exec } from "./support/command";
import { FakeBin } from "./support/bin";
import { forgeOnPath, FORGE_HOST, PROJECT, serveForges } from "./support/forge";

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

const Started = Schema.Struct({ runId: Schema.String });
const Listed = Schema.Struct({
  settings: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.Unknown })),
});
const Published = Schema.Struct({ mr_url: Schema.String });

const receiptOf = (world: World, id: string) => `${world.state}/requests/by-id/${id}.json`;
const legacyReceiptOf = (world: World, operation: string, id: string) =>
  `${world.state}/requests/${operation}/${id}.json`;

const writeReceipt = (world: World, operation: string, id: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${world.state}/requests/${operation}`, { recursive: true });
    yield* fs.writeFileString(legacyReceiptOf(world, operation, id), `${text}\n`);
  });

const auditFor = (world: World, runId: string) =>
  readAudit(runDir(world.state, runId)).pipe(Effect.provide(recordsReadLayer(world.state)));

const started = Effect.fn("receiptScope.started")(function* (
  world: World,
  options: {
    readonly workflow?: string;
    readonly input?: string;
    readonly env?: Readonly<Record<string, string>>;
  } = {},
) {
  const answer = yield* collie(
    world,
    ["run", "start", options.workflow ?? "lingers", "--input", options.input ?? "note=cache"],
    options.env ?? {},
  );
  const { runId } = yield* Schema.decodeUnknownEffect(Started)(answer.envelope.data);
  return runId;
});

const held = (
  world: World,
  runId: string,
  reason: string,
  id: string,
  extra: Readonly<Record<string, string>> = {},
) => collie(world, ["run", "hold", runId, "--reason", reason, "--request-id", id], extra);

const legacyHold = (runId: string) =>
  `{"ok":true,"data":{"run":"${runId}","runId":"${runId}","control":"hold","set":true,"applied":true,"detail":"","left":[]},"human":"Held ${runId}."}`;

test("the same Run repeats a request with the same id and is answered from its receipt", () =>
  proves(
    "collie-receipt-scope-retry-",
    (world) =>
      Effect.gen(function* () {
        const runA = yield* started(world);
        const first = yield* held(world, runA, "because", "held-once");
        expect(first.envelope.ok).toBe(true);
        expect((yield* held(world, runA, "because", "held-once")).envelope).toEqual(first.envelope);
        const lines = yield* auditFor(world, runA);
        expect(Arr.filter(lines, (one) => one.request === "held-once")).toHaveLength(1);
      }),
    ["lingers.workflow.ts"],
  ));

test("the first Run's retry still replays once another Run has asked under its id", () =>
  proves(
    "collie-receipt-scope-guard-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const runA = yield* started(world);
        const runB = yield* started(world);
        const first = yield* held(world, runA, "because", "held-guard");
        expect(first.envelope.ok).toBe(true);
        const stored = yield* fs.readFileString(receiptOf(world, "held-guard"));
        yield* held(world, runB, "because", "held-guard");
        expect((yield* held(world, runA, "because", "held-guard")).envelope).toEqual(
          first.envelope,
        );
        expect(yield* fs.readFileString(receiptOf(world, "held-guard"))).toBe(stored);
      }),
    ["lingers.workflow.ts"],
  ));

test("the same Run reusing an id with other arguments is refused", () =>
  proves(
    "collie-receipt-scope-args-",
    (world) =>
      Effect.gen(function* () {
        const runA = yield* started(world);
        const first = yield* held(world, runA, "one reason", "held-twice");
        expect(first.envelope.ok).toBe(true);
        const reused = yield* held(world, runA, "another reason", "held-twice");
        expect(reused.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(reused.envelope.data).toBeUndefined();
        expect(reused.envelope.error?.message).toContain("held-twice");
        expect(reused.envelope.error?.message).not.toContain(runA);
      }),
    ["lingers.workflow.ts"],
  ));

test("a global operation reusing an id with other arguments is refused", () =>
  proves(
    "collie-receipt-scope-global-",
    (world) =>
      Effect.gen(function* () {
        const set = (value: string) =>
          collie(world, ["settings", "set", "effort", value, "--request-id", "effort-once"]);
        expect((yield* set("low")).envelope.ok).toBe(true);
        const reused = yield* set("high");
        expect(reused.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(reused.envelope.data).toBeUndefined();
        expect(reused.envelope.error?.message).toContain("effort-once");
        const listed = yield* collie(world, ["settings", "list"]);
        const { settings } = yield* Schema.decodeUnknownEffect(Listed)(listed.envelope.data);
        expect(
          Option.getOrUndefined(Arr.findFirst(settings, (one) => one.key === "effort")),
        ).toMatchObject({ value: "low" });
      }),
    ["lingers.workflow.ts"],
  ));

test("an id recorded for one operation is refused for another", () =>
  proves(
    "collie-receipt-scope-operation-",
    (world) =>
      Effect.gen(function* () {
        const runA = yield* started(world);
        expect(
          (yield* collie(world, ["settings", "set", "effort", "low", "--request-id", "one-id"]))
            .envelope.ok,
        ).toBe(true);
        const reused = yield* held(world, runA, "because", "one-id");
        expect(reused.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(reused.envelope.data).toBeUndefined();
        expect(reused.envelope.error?.message).toContain("one-id");
        const lines = yield* auditFor(world, runA);
        expect(Arr.filter(lines, (one) => one.request === "one-id")).toHaveLength(0);
      }),
    ["lingers.workflow.ts"],
  ));

test("a request naming this workspace's own files does not replay from another directory", () =>
  proves(
    "collie-receipt-scope-directory-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const elsewhere = `${world.home}/elsewhere`;
        yield* fs.makeDirectory(elsewhere, { recursive: true });
        const add = (dir: string) =>
          collie(
            world,
            [
              "run",
              "intent",
              "defaults",
              "add-constraint",
              "Keep it small",
              "--request-id",
              "defaults-once",
            ],
            { COLLIE_CWD: dir },
          );
        expect((yield* add(world.project)).envelope.ok).toBe(true);
        const other = yield* add(elsewhere);
        expect(other.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(other.envelope.data).toBeUndefined();
        expect((yield* add(world.project)).envelope.ok).toBe(true);
      }),
    ["lingers.workflow.ts"],
  ));

test("a start's whole constraints and checks are part of its request", () =>
  proves(
    "collie-receipt-scope-definitions-",
    (world) =>
      Effect.gen(function* () {
        const start = (severity: string) =>
          collie(world, [
            "run",
            "start",
            "plain",
            "--input",
            "note=cache",
            "--constraint",
            "Keep it small",
            "--severity",
            severity,
            "--request-id",
            "start-definitions",
          ]);
        expect((yield* start("warn")).envelope.ok).toBe(true);
        const changed = yield* start("block");
        expect(changed.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(changed.envelope.data).toBeUndefined();
        const check = (argv: string) =>
          collie(world, [
            "run",
            "start",
            "plain",
            "--input",
            "note=cache",
            "--verify",
            `{"name":"tests","executable":"bun","argv":["${argv}"],"cwd":"."}`,
            "--request-id",
            "start-checks",
          ]);
        expect((yield* check("test")).envelope.ok).toBe(true);
        const replaced = yield* check("run");
        expect(replaced.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(replaced.envelope.data).toBeUndefined();
      }),
    ["plain.workflow.ts"],
  ));

test("a request is the same however its structured inputs are written", () =>
  proves(
    "collie-receipt-scope-canonical-",
    (world) =>
      Effect.gen(function* () {
        const add = (payload: string) =>
          collie(world, [
            "schedule",
            "add",
            "nightly",
            "typed",
            "--cron",
            "0 7 * * *",
            "--paused",
            "--inputs-json",
            payload,
            "--request-id",
            "sched-once",
          ]);
        const first = yield* add(
          '{"note":"n","count":1,"draft":true,"labels":[],"ticket":"","mode":"fast","ref":"r","spec":""}',
        );
        expect(first.envelope.ok).toBe(true);
        const reordered = yield* add(
          '{"spec":"","ref":"r","mode":"fast","ticket":"","labels":[],"draft":true,"count":1,"note":"n"}',
        );
        expect(reordered.envelope).toEqual(first.envelope);
        const set = (value: string) =>
          collie(world, ["settings", "set", "effort", value, "--request-id", "effort-form"]);
        const spaced = yield* set(" low ");
        expect(spaced.envelope.ok).toBe(true);
        expect((yield* set("low")).envelope).toEqual(spaced.envelope);
      }),
    ["typed.workflow.ts"],
  ));

test("a receipt scopes to the Run whose claim asked, not to a Run the request names", () =>
  proves(
    "collie-receipt-scope-agent-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${world.home}/outputs.json`,
          encode([{ verdict: "done" }, { verdict: "done" }]),
        );
        const runA = yield* started(world, { workflow: "attended", input: "work=identity" });
        const agent = yield* until(
          () => registeredAt(world.state),
          (entries) => Arr.some(entries, (one) => one.runId === runA),
        ).pipe(
          Effect.map((entries) =>
            Option.getOrUndefined(Arr.findFirst(entries, (one) => one.runId === runA)),
          ),
        );
        if (agent === undefined) {
          return yield* Effect.die(new Error(`no agent is registered for ${runA}`));
        }
        const claim = { COLLIE_AGENT: agent.agent };
        const first = yield* held(world, runA, "because", "held-agent", claim);
        expect(first.envelope.ok).toBe(true);
        expect((yield* held(world, runA, "because", "held-agent", claim)).envelope).toEqual(
          first.envelope,
        );
        const forged = yield* held(world, runA, "because", "held-agent", {
          COLLIE_RUN: runA,
          COLLIE_AGENT: "not-an-agent",
        });
        expect(forged.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(forged.envelope.data).toBeUndefined();
        const human = yield* held(world, runA, "because", "held-agent");
        expect(human.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(human.envelope.data).toBeUndefined();
      }),
    ["attended.workflow.ts"],
  ));

test("a receipt written before receipts were scoped replays to its own Run", () =>
  proves(
    "collie-receipt-scope-legacy-",
    (world) =>
      Effect.gen(function* () {
        const runA = yield* started(world);
        yield* writeReceipt(world, "run-hold", "held-legacy", legacyHold(runA));
        const answered = yield* held(world, runA, "because", "held-legacy");
        expect(answered.envelope).toMatchObject({
          ok: true,
          data: { run: runA, runId: runA, applied: true },
        });
        const lines = yield* auditFor(world, runA);
        expect(Arr.filter(lines, (one) => one.request === "held-legacy")).toHaveLength(0);
      }),
    ["lingers.workflow.ts"],
  ));

test("a receipt written before receipts were scoped never replays to another request", () =>
  proves(
    "collie-receipt-scope-legacy-refused-",
    (world) =>
      Effect.gen(function* () {
        const runA = yield* started(world);
        const runB = yield* started(world);
        yield* writeReceipt(
          world,
          "settings-set",
          "effort-legacy",
          `{"ok":true,"data":{"set":true},"human":"effort is now low"}`,
        );
        yield* writeReceipt(world, "run-hold", "held-legacy-other", legacyHold(runB));
        const refused = yield* collie(world, [
          "settings",
          "set",
          "effort",
          "low",
          "--request-id",
          "effort-legacy",
        ]);
        expect(refused.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(refused.envelope.error?.message).toContain("effort-legacy");
        expect(refused.envelope.error?.message).toMatch(/scoped/);
        expect(refused.envelope.data).toBeUndefined();
        expect(refused.envelope.error?.message).not.toContain(runB);
        const elsewhere = yield* held(world, runA, "because", "held-legacy-other");
        expect(elsewhere.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(elsewhere.envelope.data).toBeUndefined();
        expect(elsewhere.envelope.error?.message).not.toContain(runB);
      }),
    ["lingers.workflow.ts"],
  ));

const commit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const done = yield* exec(["git", ...args], { cwd });
    if (done.exitCode !== 0) {
      return yield* Effect.die(new Error(`git ${Arr.join(args, " ")}: ${done.stderr}`));
    }
  });

const published = Effect.fn("receiptScope.published")(function* (
  world: World,
  file: string,
  extra: Readonly<Record<string, string>>,
  duringPush = "",
) {
  const bin = yield* Effect.acquireRelease(FakeBin.make(`${world.home}/bin`), (made) =>
    made.restore(),
  );
  const real = Bun.which("git");
  yield* bin.add(
    "git",
    `if [ "$1" = push ]; then echo "$*" >> '${world.home}/pushes'
  ${duringPush}
  exit 0; fi\nexec '${real}' "$@"`,
  );
  const fake = yield* forgeOnPath(bin, "gitlab", {
    installed: true,
    loggedIn: [FORGE_HOST.gitlab, "gitlab.cego.dk"],
    login: "mk",
    mrs: [],
  });
  const api = yield* serveForges(fake);
  return {
    fake,
    file,
    env: () => ({ COLLIE_FORGE_API: api, PATH: Bun.env.PATH!, ...extra }),
  };
});

const projectOn = Effect.fn("receiptScope.projectOn")(function* (dir: string, forge: string) {
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.name", "Tester"],
    ["config", "user.email", "test@example.com"],
    ["commit", "--allow-empty", "-m", "Initial"],
    ["update-ref", "refs/remotes/origin/main", "HEAD"],
    ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
    ["checkout", "-b", "fix/cache"],
    ["remote", "add", "origin", `https://${PROJECT.gitlab}.git`],
    ["commit", "--allow-empty", "-m", "Keep cached results", "-m", `Retain results for ${forge}.`],
  ]) {
    yield* commit(dir, args);
  }
});

test("another Run in another project gets none of a publish's answer", () =>
  proves(
    "collie-receipt-scope-publish-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* projectOn(world.project, "its own branch");
        const other = `${world.home}/other`;
        yield* fs.makeDirectory(other, { recursive: true });
        yield* projectOn(other, "the other project");
        const file = `${world.home}/description.md`;
        yield* fs.writeFileString(file, "Retain results across reconnects.");
        const setup = yield* published(world, file, {});
        const runA = yield* started(world, { workflow: "plain", env: setup.env() });
        const runB = yield* started(world, {
          workflow: "plain",
          env: { ...setup.env(), COLLIE_CWD: other },
        });
        const publish = (runId: string, extra: Readonly<Record<string, string>>) =>
          collie(
            world,
            [
              "run",
              "publish",
              runId,
              "--title",
              "Keep cached results",
              "--file",
              file,
              "--request-id",
              "publish-shared",
            ],
            extra,
          );
        const first = yield* publish(runA, setup.env());
        expect(first.envelope).toMatchObject({ ok: true });
        const mr = yield* Schema.decodeUnknownEffect(Published)(first.envelope.data);
        const foreign = yield* publish(runB, { ...setup.env(), COLLIE_CWD: other });
        expect(foreign.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(foreign.envelope.error?.message).toContain("publish-shared");
        expect(foreign.envelope.data).toBeUndefined();
        expect(foreign.envelope.error?.message).not.toContain(runA);
        expect(foreign.envelope.error?.message).not.toContain(mr.mr_url);
        expect((yield* setup.fake.model()).mrs).toHaveLength(1);
      }),
    ["plain.workflow.ts"],
  ));

test("a pushed receipt is not replayed to another Run, and its retry pushes once", () =>
  proves(
    "collie-receipt-scope-push-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* projectOn(world.project, "its own branch");
        const other = `${world.home}/other`;
        yield* fs.makeDirectory(other, { recursive: true });
        yield* projectOn(other, "the other project");
        const setup = yield* published(world, `${world.home}/description.md`, {});
        const runA = yield* started(world, { workflow: "plain", env: setup.env() });
        const runB = yield* started(world, {
          workflow: "plain",
          env: { ...setup.env(), COLLIE_CWD: other },
        });
        const push = (runId: string, extra: Readonly<Record<string, string>>) =>
          collie(
            world,
            ["run", "publish", runId, "--push-only", "--skip-ci", "--request-id", "push-shared"],
            extra,
          );
        const first = yield* push(runA, setup.env());
        expect(first.envelope).toMatchObject({ ok: true, data: { pushed: true } });
        expect((yield* push(runA, setup.env())).envelope).toEqual(first.envelope);
        expect(yield* fs.readFileString(`${world.home}/pushes`)).toBe(
          "push -u origin HEAD -o ci.skip\n",
        );
        const foreign = yield* push(runB, { ...setup.env(), COLLIE_CWD: other });
        expect(foreign.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(foreign.envelope.data).toBeUndefined();
        expect(foreign.envelope.error?.message).not.toContain(runA);
        expect(yield* fs.readFileString(`${world.home}/pushes`)).toBe(
          "push -u origin HEAD -o ci.skip\n",
        );
      }),
    ["plain.workflow.ts"],
  ));

test("a request meeting another Run's in-progress receipt neither replays nor overwrites it", () =>
  proves(
    "collie-receipt-scope-progress-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* projectOn(world.project, "its own branch");
        const other = `${world.home}/other`;
        yield* fs.makeDirectory(other, { recursive: true });
        yield* projectOn(other, "the other project");
        const file = `${world.home}/description.md`;
        yield* fs.writeFileString(file, "Retain results across reconnects.");
        const atPush = `${world.home}/at-push`;
        const letGo = `${world.home}/let-go`;
        const setup = yield* published(
          world,
          file,
          {},
          `touch '${atPush}'\n  while [ ! -f '${letGo}' ]; do /bin/sleep 0.05; done`,
        );
        const env = setup.env;
        const runA = yield* started(world, { workflow: "plain", env: env() });
        const runB = yield* started(world, {
          workflow: "plain",
          env: { ...env(), COLLIE_CWD: other },
        });
        const publish = (runId: string, extra: Readonly<Record<string, string>>) =>
          collie(
            world,
            [
              "run",
              "publish",
              runId,
              "--title",
              "Keep cached results",
              "--file",
              file,
              "--request-id",
              "publish-slow",
            ],
            extra,
          );
        yield* Effect.gen(function* () {
          const pending = yield* Effect.forkScoped(publish(runA, env()));
          yield* until(
            () => fs.exists(atPush),
            (found) => found,
          );
          const receipt = receiptOf(world, "publish-slow");
          const during = yield* fs.readFileString(receipt);
          expect(during).toContain('"digest"');
          const foreign = yield* publish(runB, { ...env(), COLLIE_CWD: other });
          expect(foreign.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
          expect(foreign.envelope.data).toBeUndefined();
          expect(foreign.envelope.error?.message).not.toContain(runA);
          expect(yield* fs.readFileString(receipt)).toBe(during);
          expect((yield* setup.fake.model()).mrs).toHaveLength(0);
          yield* fs.writeFileString(letGo, "");
          const finished = yield* Fiber.join(pending);
          expect(finished.envelope).toMatchObject({ ok: true });
          expect((yield* publish(runA, env())).envelope).toEqual(finished.envelope);
          expect(yield* fs.readFileString(`${world.home}/pushes`)).toBe("push -u origin HEAD\n");
          expect((yield* setup.fake.model()).mrs).toHaveLength(1);
        }).pipe(Effect.ensuring(fs.writeFileString(letGo, "").pipe(Effect.ignore)));
      }),
    ["plain.workflow.ts"],
  ));
