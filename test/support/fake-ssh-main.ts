// A fake `ssh`, run by the shim `writeFakeSsh` writes. It models what Collie relies on:
// a master that `ControlPersist` detaches, ssh's `-O` control commands against it, a
// session that rides it, and OpenSSH's fallback to a login of its own where the socket has
// gone. Every call is logged with its mode: `master`, `mux <verb>`, `ride` or `login`.

import { createConnection, createServer, type Server, type Socket } from "node:net";
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { flow } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const Request = Schema.Struct({ op: Schema.String, spec: Schema.optionalKey(Schema.String) });
type Request = typeof Request.Type;
const RequestJson = Schema.fromJsonString(Request);
const encodeRequest = flow(Schema.encodeResult(RequestJson), Result.getOrThrow);
const FarEnvironment = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const PortMap = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Finite));

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const services = yield* Effect.context<never>();
  const run = Effect.runForkWith(services);
  const dispatch = <A, E>(effect: Effect.Effect<A, E>) =>
    void run(
      Effect.forkIn(
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              process.stderr.write(`${Cause.pretty(cause)}\n`);
              process.exit(1);
            }),
          ),
        ),
        scope,
      ),
    );
  const log = yield* Config.String("FAKE_SSH_LOG").pipe(Config.withDefault("/dev/null"));
  const dir = yield* Config.String("FAKE_SSH_DIR").pipe(Config.withDefault("/tmp"));
  /** The far Machine's environment, which a session there starts with. */
  const far = yield* Config.String("FAKE_SSH_ENV").pipe(
    Config.withDefault("{}"),
    Effect.flatMap(Schema.decodeEffect(FarEnvironment)),
  );
  const said = (line: string) => fs.writeFileString(log, `${line}\n`, { flag: "a" });
  /** Where a far `127.0.0.1:<port>` really is, as the test maps it; else that port itself. */
  const farPort = (port: number) =>
    fs.readFileString(`${dir}/ports.json`).pipe(
      Effect.flatMap(Schema.decodeEffect(PortMap)),
      Effect.map((ports) => ports[String(port)] ?? port),
      Effect.orElseSucceed(() => port),
    );
  /** One request to a master over its control path, and its answer: null where none answers. */
  const ask = (path: string, request: Request) =>
    Effect.gen(function* () {
      if (!(yield* fs.exists(path))) return null;
      return yield* Effect.callback<string | null>((resume) => {
        const conn = createConnection(path);
        let answer = "";
        conn.once("connect", () => conn.write(`${encodeRequest(request)}\n`));
        conn.on("data", (chunk) => {
          answer += chunk.toString("utf8");
        });
        conn.once("error", () => resume(Effect.succeed(null)));
        conn.once("close", () => resume(Effect.succeed(answer === "" ? null : Str.trim(answer))));
        return Effect.sync(() => {
          conn.destroy();
        });
      });
    });
  /** A master holding `path`, until `-O exit`, a drop, SIGTERM, or its path is removed. */
  const master = (path: string) =>
    Effect.gen(function* () {
      const forwards = new Map<string, Server>();
      const finish = () => {
        for (const server of forwards.values()) server.close();
        process.exit(0);
      };
      const unlink = yield* Effect.cached(fs.remove(path, { force: true }));
      const end = unlink.pipe(Effect.andThen(Effect.sync(finish)));
      const forward = (spec: string, reply: (said: string) => void) => {
        const parts = Str.split(spec, ":");
        const [bind, port, , hostPort] = parts.length === 4 ? parts : ["127.0.0.1", ...parts];
        const server = createServer((conn: Socket) => {
          let out: Socket | undefined;
          conn.once("error", () => out?.destroy());
          dispatch(
            Effect.gen(function* () {
              const mapped = yield* farPort(Number(hostPort));
              if (conn.destroyed) return;
              out = createConnection({ host: "127.0.0.1", port: mapped });
              conn.pipe(out);
              out.pipe(conn);
              out.once("error", () => conn.destroy());
            }),
          );
        });
        server.once("error", (error) =>
          reply(
            `bind [${bind}]:${port}: ${error.message}\nmux_client_forward: forwarding request failed: Port forwarding failed`,
          ),
        );
        server.listen(Number(port), bind, () => {
          forwards.set(spec, server);
          reply("ok");
        });
      };
      const control = createServer((conn) => {
        let line = "";
        conn.on("data", (chunk) => {
          line += chunk.toString("utf8");
          if (!Str.includes("\n")(line)) return;
          dispatch(
            Effect.gen(function* () {
              const asked = yield* Schema.decodeEffect(RequestJson)(line);
              const reply = (answer: string) => {
                conn.end(`${answer}\n`);
              };
              if (asked.op === "check") return reply("ok");
              if (asked.op === "forward") return forward(asked.spec!, reply);
              if (asked.op === "cancel") {
                forwards.get(asked.spec!)?.close();
                forwards.delete(asked.spec!);
                return reply("ok");
              }
              if (asked.op === "exit" || asked.op === "drop") {
                // Gone before it answers, so the asker may bind the path at once.
                yield* unlink;
                conn.end("ok\n", finish);
                return;
              }
              reply(`unknown request ${asked.op}`);
            }),
          );
        });
      });
      process.on("SIGTERM", () => dispatch(end));
      yield* fs.remove(path, { force: true });
      control.once("error", () => process.exit(255));
      control.listen(path);
      yield* fs.writeFileString(`${dir}/masters`, `${path}\n`, { flag: "a" });
      yield* fs.exists(path).pipe(
        Effect.flatMap((exists) => (exists ? Effect.void : end)),
        Effect.repeat(Schedule.spaced(500)),
        Effect.delay(500),
        Effect.forkIn(scope),
      );
      return yield* Effect.never;
    });
  const argv = Arr.drop(process.argv, 2);
  if (argv[0] === "--master") return yield* master(argv[1]!);
  if (argv[0] === "-G") {
    process.stdout.write("hostname 127.0.0.1\nport 22\n");
    return process.exit(0);
  }
  let path: string | undefined;
  let verb: string | undefined;
  let spec: string | undefined;
  let isMaster = false;
  const options = new Map<string, string>();
  let at = 0;
  for (; at < argv.length; at++) {
    const word = argv[at]!;
    if (word === "-S") path = argv[++at];
    else if (word === "-O") verb = argv[++at];
    else if (word === "-L") spec = argv[++at];
    else if (word === "-o") {
      const [key, value] = Str.split(argv[++at]!, "=");
      options.set(key, value ?? "");
    } else if (word === "-M") isMaster = true;
    else if (word === "-T" || word === "-N") continue;
    else break;
  }
  const target = argv[at] ?? "";
  const command = Arr.join(Arr.drop(argv, at + 1), " ");
  if (isMaster) {
    yield* said(`master ${target}`);
    if (yield* fs.exists(`${dir}/master-hangs`)) {
      process.stderr.write(`Waiting for SSO login for ${target}\n`);
      return yield* Effect.sleep(1_000).pipe(Effect.repeat(Schedule.forever));
    }
    process.stderr.write(`Authenticated to ${target}\n`);
    if (options.get("ControlPersist") !== "yes") return yield* master(path!);
    // As ssh does with ControlPersist: the master goes to the background, and this exits.
    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [
          ...(Str.startsWith("/$bunfs/")(import.meta.path) ? [] : [import.meta.path]),
          "--master",
          path!,
        ],
        {
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          extendEnv: true,
        },
      ),
    );
    yield* Effect.asVoid(child.unref);
    const ready = yield* ask(path!, { op: "check" }).pipe(
      Effect.repeat({
        until: (answer) => answer === "ok",
        times: 249,
        schedule: Schedule.spaced(20),
      }),
    );
    if (ready === "ok") return process.exit(0);
    yield* Effect.sleep(20);
    process.stderr.write(`ControlSocket ${path} could not be bound\n`);
    return process.exit(255);
  }
  if (verb !== undefined) {
    yield* said(`mux ${verb}${spec === undefined ? "" : ` ${spec}`} ${target}`);
    const request = spec === undefined ? { op: verb } : { op: verb, spec };
    const answer = yield* ask(path ?? "", request);
    if (answer === "ok") {
      if (verb === "check") process.stderr.write("Master running\n");
      return process.exit(0);
    }
    process.stderr.write(answer ?? `Control socket connect(${path}): No such file or directory\n`);
    return process.exit(255);
  }
  if (path !== undefined && (yield* fs.exists(`${dir}/drops-before-ride`)))
    yield* ask(path, { op: "drop" });
  const rides =
    path !== undefined && options.get("ControlMaster") === "no"
      ? (yield* ask(path, { op: "check" })) === "ok"
      : false;
  if (path !== undefined && !rides && options.get("ProxyCommand") === "false") {
    process.stderr.write("Connection closed by UNKNOWN port 65535\n");
    return process.exit(255);
  }
  yield* said(`${rides ? "ride" : "login"} ${target} ${command}`);
  const session = yield* spawner.spawn(
    ChildProcess.make("/bin/sh", ["-c", command], {
      env: far,
      extendEnv: Rec.isEmptyRecord(far),
      detached: false,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  process.exit(yield* session.exitCode);
});

const platform = BunChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
);
await Effect.runPromise(main.pipe(Effect.scoped, Effect.provide(platform)));
