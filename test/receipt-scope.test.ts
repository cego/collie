import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, Option, Schema, flow, Result } from "effect";
import { readAudit } from "../src/audit";
import { runDir } from "../src/engine";
import { recordsReadLayer } from "../src/records";
import { collie, proves, save } from "./support/world";
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

const pointProjectsAt = (world: World, root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const Config = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));
    const file = `${world.config}/config.json`;
    const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => "{}"));
    const kept = Option.getOrElse(Schema.decodeOption(Config)(text), () => ({}));
    yield* fs.writeFileString(
      file,
      yield* Schema.encodeEffect(Config)({ ...kept, projects: { root } }),
    );
  });

const checkoutAt = (at: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(at, { recursive: true });
    yield* exec(["git", "init", "-q"], { cwd: at });
  });

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
        const nested = (spec: string) =>
          collie(world, [
            "schedule",
            "add",
            "nested",
            "typed",
            "--cron",
            "0 7 * * *",
            "--paused",
            "--inputs-json",
            `{"note":"n","count":1,"draft":true,"labels":[],"ticket":"","mode":"fast","ref":"r","spec":${spec}}`,
            "--request-id",
            "sched-nested",
          ]);
        const object = yield* nested('{"b":1,"a":2}');
        expect(object.envelope.ok).toBe(true);
        expect((yield* nested('{"a":2,"b":1}')).envelope).toEqual(object.envelope);
        const where = (selector: string) =>
          collie(world, [
            "schedule",
            "add",
            "placed",
            "typed",
            "--cron",
            "0 7 * * *",
            "--paused",
            "--workspace",
            selector,
            "--inputs-json",
            '{"note":"n","count":1,"draft":true,"labels":[],"ticket":"","mode":"fast","ref":"r","spec":""}',
            "--request-id",
            "sched-placed",
          ]);
        const placed = yield* where(world.project);
        expect(placed.envelope.ok).toBe(true);
        expect((yield* where(`  ${world.project}  `)).envelope).toEqual(placed.envelope);
        const set = (value: string) =>
          collie(world, ["settings", "set", "effort", value, "--request-id", "effort-form"]);
        const spaced = yield* set(" low ");
        expect(spaced.envelope.ok).toBe(true);
        expect((yield* set("low")).envelope).toEqual(spaced.envelope);
      }),
    ["typed.workflow.ts"],
  ));

test("a Schedule's inputs are the values it saves, however they are written", () =>
  proves(
    "collie-receipt-scope-sched-values-",
    (world) =>
      Effect.gen(function* () {
        const add = (given: ReadonlyArray<string>) =>
          collie(world, [
            "schedule",
            "add",
            "from-json",
            "lingers",
            "--cron",
            "0 7 * * *",
            "--paused",
            ...given,
            "--request-id",
            "sched-values",
          ]);
        const json = yield* add(["--inputs-json", '{"note":"cache"}']);
        expect(json.envelope.ok).toBe(true);
        expect((yield* add(["--input", "note=cache"])).envelope).toEqual(json.envelope);
      }),
    ["lingers.workflow.ts"],
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
test("a start's decision and workspace are part of its request", () =>
  proves(
    "collie-receipt-scope-start-",
    (world) =>
      Effect.gen(function* () {
        const elsewhere = `${world.home}/elsewhere`;
        yield* checkoutAt(elsewhere);
        const start = (extra: ReadonlyArray<string>) =>
          collie(world, [
            "run",
            "start",
            "lingers",
            "--input",
            "note=cache",
            ...extra,
            "--request-id",
            "start-once",
          ]);
        expect((yield* start([])).envelope.ok).toBe(true);
        const decided = yield* start(["--decide", "step=a title"]);
        expect(decided.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(decided.envelope.data).toBeUndefined();
        const moved = yield* start(["--workspace", elsewhere]);
        expect(moved.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(moved.envelope.data).toBeUndefined();
        expect(moved.envelope.error?.message).toContain("start-once");
        expect((yield* start([])).envelope.ok).toBe(true);
      }),
    ["lingers.workflow.ts"],
  ));
test("a Schedule's checkout is the same request however it is named", () =>
  proves(
    "collie-receipt-scope-sched-form-",
    (world) =>
      Effect.gen(function* () {
        const add = (given: ReadonlyArray<string>) =>
          collie(world, [
            "schedule",
            "add",
            "named-form",
            "lingers",
            "--cron",
            "0 7 * * *",
            "--paused",
            "--input",
            "note=cache",
            ...given,
            "--request-id",
            "sched-form",
          ]);
        const flag = yield* add(["--workspace", world.project]);
        expect(flag.envelope.ok).toBe(true);
        expect((yield* add(["--input", `workspace=${world.project}`])).envelope).toEqual(
          flag.envelope,
        );
      }),
    ["lingers.workflow.ts"],
  ));
test("a Schedule's checkout is the one it resolved, not the way it was named", () =>
  proves(
    "collie-receipt-scope-sched-resolved-",
    (world) =>
      Effect.gen(function* () {
        const other = `${world.home}/other`;
        yield* checkoutAt(other);
        const add = (
          name: string,
          id: string,
          workspace: string,
          extra: Readonly<Record<string, string>> = {},
        ) =>
          collie(
            world,
            [
              "schedule",
              "add",
              name,
              "lingers",
              "--cron",
              "0 7 * * *",
              "--paused",
              "--input",
              "note=cache",
              "--workspace",
              workspace,
              "--request-id",
              id,
            ],
            extra,
          );
        const Added = Schema.Struct({
          schedule: Schema.Struct({ checkout: Schema.NullOr(Schema.String) }),
        });
        const dot = yield* add("resolved-dot", "sched-dot", ".");
        expect(dot.envelope.ok).toBe(true);
        const named = yield* add("resolved-abs", "sched-abs", world.project);
        const dotSaved = yield* Schema.decodeUnknownEffect(Added)(dot.envelope.data);
        const namedSaved = yield* Schema.decodeUnknownEffect(Added)(named.envelope.data);
        expect(namedSaved.schedule.checkout).toBe(dotSaved.schedule.checkout);
        expect(
          (yield* add("resolved-dot", "sched-dot", world.project, { COLLIE_CWD: other })).envelope,
        ).toEqual(dot.envelope);
      }),
    ["lingers.workflow.ts"],
  ));
test("a Schedule's id does not replay from the checkout it was resolved to", () =>
  proves(
    "collie-receipt-scope-sched-retargeted-",
    (world) =>
      Effect.gen(function* () {
        for (const team of ["team-a", "team-b"]) {
          yield* checkoutAt(`${world.home}/${team}/landing`);
        }
        const add = (name: string, id: string) =>
          collie(world, [
            "schedule",
            "add",
            name,
            "lingers",
            "--cron",
            "0 7 * * *",
            "--paused",
            "--input",
            "note=cache",
            "--workspace",
            "landing",
            "--request-id",
            id,
          ]);
        yield* pointProjectsAt(world, `${world.home}/team-a`);
        const first = yield* add("retargeted", "sched-retargeted");
        expect(first.envelope.ok).toBe(true);
        yield* pointProjectsAt(world, `${world.home}/team-b`);
        const moved = yield* add("retargeted", "sched-retargeted");
        expect(moved.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(moved.envelope.data).toBeUndefined();
        const fresh = yield* add("retargeted-two", "sched-retargeted-fresh");
        const Added = Schema.Struct({
          schedule: Schema.Struct({ checkout: Schema.NullOr(Schema.String) }),
        });
        expect(
          (yield* Schema.decodeUnknownEffect(Added)(fresh.envelope.data)).schedule.checkout,
        ).toBe(`${world.home}/team-b/landing`);
      }),
    ["lingers.workflow.ts"],
  ));
test("a start does not replay from a workspace that now resolves elsewhere", () =>
  proves(
    "collie-receipt-scope-start-retarget-",
    (world) =>
      Effect.gen(function* () {
        for (const team of ["team-a", "team-b"]) {
          yield* checkoutAt(`${world.home}/${team}/landing`);
        }
        const start = (id: string) =>
          collie(world, [
            "run",
            "start",
            "lingers",
            "--input",
            "note=cache",
            "--workspace",
            "landing",
            "--request-id",
            id,
          ]);
        yield* pointProjectsAt(world, `${world.home}/team-a`);
        expect((yield* start("start-retarget")).envelope.ok).toBe(true);
        yield* pointProjectsAt(world, `${world.home}/team-b`);
        const moved = yield* start("start-retarget");
        expect(moved.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(moved.envelope.data).toBeUndefined();
        expect((yield* start("start-retarget-fresh")).envelope.ok).toBe(true);
      }),
    ["lingers.workflow.ts"],
  ));
test("a user fork replays only from the project whose source it read", () =>
  proves(
    "collie-receipt-scope-fork-source-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const first = `${world.home}/first`;
        const second = `${world.home}/second`;
        yield* checkoutAt(first);
        yield* checkoutAt(second);
        yield* save(`${first}/.collie/workflows`, ["plain.workflow.ts"]);
        yield* fs.makeDirectory(`${first}/.collie/personas`, { recursive: true });
        yield* fs.writeFileString(
          `${first}/.collie/personas/local.md`,
          "---\nname: local\ndescription: A persona only this checkout has.\n---\n\nYou are local.\n",
        );
        const forked = (at: string, id: string, name: string) =>
          collie(
            world,
            ["workflow", "fork", "plain", "--name", name, "--layer", "user", "--request-id", id],
            { COLLIE_CWD: at },
          );
        const copied = (at: string, id: string, name: string) =>
          collie(
            world,
            ["persona", "fork", "local", "--name", name, "--layer", "user", "--request-id", id],
            { COLLIE_CWD: at },
          );
        expect((yield* forked(first, "fork-once", "mine")).envelope.ok).toBe(true);
        expect((yield* copied(first, "copy-once", "copied")).envelope.ok).toBe(true);
        const replayed = yield* forked(second, "fork-once", "mine");
        expect(replayed.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(replayed.envelope.data).toBeUndefined();
        const copiedAgain = yield* copied(second, "copy-once", "copied");
        expect(copiedAgain.envelope).toMatchObject({
          ok: false,
          error: { code: "invalid_input" },
        });
        expect((yield* forked(second, "fork-fresh", "mine-two")).envelope).toMatchObject({
          ok: false,
          error: { code: "workflow_not_found" },
        });
        expect((yield* copied(second, "copy-fresh", "copied-two")).envelope).toMatchObject({
          ok: false,
          error: { code: "persona_not_found" },
        });
      }),
    ["lingers.workflow.ts"],
  ));
test("a Schedule refused before it is saved still names the request", () =>
  proves(
    "collie-receipt-scope-sched-refused-",
    (world) =>
      Effect.gen(function* () {
        const add = (extra: ReadonlyArray<string>) =>
          collie(world, [
            "schedule",
            "add",
            "refused",
            "lingers",
            "--cron",
            "0 7 * * *",
            ...extra,
            "--request-id",
            "sched-refused",
          ]);
        const named = {
          ok: false,
          error: { code: "invalid_input", details: { requestId: "sched-refused" } },
        };
        expect((yield* add(["--input", "novalue"])).envelope).toMatchObject(named);
        expect((yield* add(["--verify", "not-json"])).envelope).toMatchObject(named);
        expect((yield* add(["--workspace", "nowhere"])).envelope).toMatchObject(named);
      }),
    ["lingers.workflow.ts"],
  ));
test("an artefact's whole registration is part of its request", () =>
  proves(
    "collie-receipt-scope-artefact-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const runId = yield* started(world, { workflow: "plain" });
        yield* collie(world, ["run", "wait", runId]);
        const file = `${world.project}/answer.md`;
        yield* fs.writeFileString(file, "# Delivered\n");
        const register = (extra: ReadonlyArray<string>) =>
          collie(world, [
            "run",
            "artefact",
            "register",
            runId,
            "--path",
            file,
            "--title",
            "The answer",
            ...extra,
            "--request-id",
            "register-once",
          ]);
        expect((yield* register([])).envelope.ok).toBe(true);
        const snapshot = yield* register(["--snapshot"]);
        expect(snapshot.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(snapshot.envelope.data).toBeUndefined();
        expect((yield* register([])).envelope.ok).toBe(true);
      }),
    ["plain.workflow.ts"],
  ));
test("a start's attachment is the file the request names", () =>
  proves(
    "collie-receipt-scope-start-file-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const placed = `${world.home}/placed`;
        yield* fs.makeDirectory(placed, { recursive: true });
        yield* exec(["git", "init", "-q"], { cwd: placed });
        yield* fs.writeFileString(`${placed}/README.md`, "placed\n");
        yield* exec(["git", "add", "."], { cwd: placed });
        yield* exec(["git", "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init"], {
          cwd: placed,
        });
        yield* fs.writeFileString(`${world.project}/shot.png`, "caller\n");
        yield* fs.writeFileString(`${placed}/shot.png`, "placed\n");
        const start = (file: string) =>
          collie(
            world,
            [
              "run",
              "start",
              "lingers",
              "--input",
              "note=cache",
              "--workspace",
              placed,
              "--attach",
              file,
              "--request-id",
              "start-placed",
            ],
            { COLLIE_CWD: "" },
          );
        const first = yield* start("shot.png");
        expect(first.envelope.ok).toBe(true);
        const { runId } = yield* Schema.decodeUnknownEffect(Started)(first.envelope.data);
        expect(yield* fs.readFileString(`${runDir(world.state, runId)}/attachments/shot.png`)).toBe(
          "caller\n",
        );
        const named = yield* start(`${placed}/shot.png`);
        expect(named.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      }),
    ["lingers.workflow.ts"],
  ));
test("a registration without an upload is the path the host was given", () =>
  proves(
    "collie-receipt-scope-register-path-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const runId = yield* started(world, { workflow: "plain" });
        yield* collie(world, ["run", "wait", runId]);
        yield* fs.writeFileString(`${world.project}/answer.md`, "# Delivered\n");
        const register = (file: string, id: string) =>
          collie(world, [
            "run",
            "artefact",
            "register",
            runId,
            "--path",
            file,
            "--title",
            "The answer",
            "--request-id",
            id,
          ]);
        const stored = yield* register(`${world.project}/answer.md`, "register-path");
        expect(stored.envelope.ok).toBe(true);
        const relative = yield* register("answer.md", "register-path");
        expect(relative.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(relative.envelope.data).toBeUndefined();
        const fresh = yield* register("answer.md", "register-path-fresh");
        expect(fresh.envelope.ok).toBe(false);
        expect(fresh.envelope.error?.message).toContain("absolute file path");
      }),
    ["plain.workflow.ts"],
  ));
test("an upload's flags are the ones it sends", () =>
  proves(
    "collie-receipt-scope-upload-flags-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const runId = yield* started(world, { workflow: "plain" });
        yield* collie(world, ["run", "wait", runId]);
        yield* fs.writeFileString(`${world.project}/answer.md`, "# Delivered\n");
        const register = (given: ReadonlyArray<string>, id: string) =>
          collie(world, [
            "run",
            "artefact",
            "register",
            runId,
            ...given,
            "--title",
            "The answer",
            "--request-id",
            id,
          ]);
        const uploaded = yield* register(["--path", "answer.md", "--upload"], "upload-flags");
        expect(uploaded.envelope.ok).toBe(true);
        expect(
          (yield* register(["--path", "answer.md", "--upload", "--snapshot"], "upload-flags"))
            .envelope,
        ).toEqual(uploaded.envelope);
        const linked = yield* register(["--url", "https://example.com/report"], "link-flags");
        expect(linked.envelope.ok).toBe(true);
        expect(
          (yield* register(["--url", "https://example.com/report", "--upload"], "link-flags"))
            .envelope,
        ).toEqual(linked.envelope);
      }),
    ["plain.workflow.ts"],
  ));
test("an uploaded artefact is the file the request names", () =>
  proves(
    "collie-receipt-scope-upload-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const empty = `${world.home}/empty`;
        yield* fs.makeDirectory(empty, { recursive: true });
        const runId = yield* started(world, { workflow: "plain" });
        yield* collie(world, ["run", "wait", runId]);
        yield* fs.writeFileString(`${world.project}/answer.md`, "# Delivered\n");
        const register = (dir: string, id: string) =>
          collie(
            world,
            [
              "run",
              "artefact",
              "register",
              runId,
              "--path",
              "answer.md",
              "--title",
              "The answer",
              "--upload",
              "--request-id",
              id,
            ],
            { COLLIE_CWD: dir },
          );
        const first = yield* register(world.project, "upload-once");
        expect(first.envelope.ok).toBe(true);
        const absolute = yield* collie(
          world,
          [
            "run",
            "artefact",
            "register",
            runId,
            "--path",
            `${world.project}/answer.md`,
            "--title",
            "The answer",
            "--upload",
            "--request-id",
            "upload-once",
          ],
          { COLLIE_CWD: world.project },
        );
        expect(absolute.envelope).toEqual(first.envelope);
        const elsewhere = yield* register(empty, "upload-elsewhere");
        expect(elsewhere.envelope.ok).toBe(false);
      }),
    ["plain.workflow.ts"],
  ));
test("an attachment is the file it names, not the way it is written", () =>
  proves(
    "collie-receipt-scope-files-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const elsewhere = `${world.home}/elsewhere`;
        yield* fs.makeDirectory(elsewhere, { recursive: true });
        yield* fs.writeFileString(`${world.project}/note.md`, "one\n");
        yield* fs.writeFileString(`${elsewhere}/note.md`, "two\n");
        const start = (file: string, dir: string) =>
          collie(
            world,
            [
              "run",
              "start",
              "lingers",
              "--input",
              "note=cache",
              "--attach",
              file,
              "--request-id",
              "start-files",
            ],
            { COLLIE_CWD: dir },
          );
        const first = yield* start("note.md", world.project);
        expect(first.envelope.ok).toBe(true);
        expect((yield* start(`${world.project}/note.md`, world.project)).envelope).toEqual(
          first.envelope,
        );
        const other = yield* start("note.md", elsewhere);
        expect(other.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(other.envelope.data).toBeUndefined();
        expect(other.envelope.error?.message).toContain("start-files");
      }),
    ["lingers.workflow.ts"],
  ));
