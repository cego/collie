// `collie onboard`: its step stream against scripted Machines. The release is placed from a
// carried tree on disk; every installer and system tool that would reach the network or need
// root is a stub on PATH.

import { pipe as pipe_ } from "effect/Function";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { FakeBin } from "./support/bin";
import { readEnv } from "../src/env";
import { eventText } from "../src/commands/onboard";
import { onboard, type OnboardEvent, type OnboardOptions } from "../src/onboard";
import { err, type OpResult } from "../src/operations";
import { writeConfigValue } from "../src/config";
import manifest from "../herdr-plugin.toml";

let home: string;
let root: string;
let carried: { tree: string; runner: string };
let bin: FakeBin;

const git = (cwd: string, ...args: string[]) =>
  exec(["git", ...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).pipe(
    Effect.flatMap((done) =>
      done.exitCode === 0
        ? Effect.succeed(Str.trim(done.stdout))
        : Effect.die(new Error(`git ${Arr.join(args, " ")}: ${done.stderr}`)),
    ),
  );

/** The release this runner carries, whose `prepare.sh` records each time it ran. */
const carry = Effect.fn("test.carry")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const tree = `${home}/carried/release`;
  yield* fs.makeDirectory(tree, { recursive: true });
  yield* fs.writeFileString(`${tree}/herdr-plugin.toml`, `version = "${manifest.version}"\n`);
  yield* fs.writeFileString(
    `${tree}/prepare.sh`,
    `echo ran >> "$HOME/prepared"\necho "prepare: runner: done"\necho "prepare: skills: done"\n`,
  );
  yield* fs.writeFileString(`${home}/carried/collie`, "#!/bin/sh\n", { mode: 0o755 });
  return { tree, runner: `${home}/carried/collie` };
});

const read = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(file).pipe(Effect.orElseSucceed(() => "")),
  );

/** An installer that leaves an executable named `name` in ~/.local/bin, as the real ones do. */
const installer = (name: string, says = "") =>
  `mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/${name}" <<'END'
#!/bin/sh
${says}
END
chmod +x "$HOME/.local/bin/${name}"`;

/** A Claude Code that is logged in. */
const LOGGED_IN = `echo '{"loggedIn": true}'`;

const READY: OpResult = { ok: true, data: { ready: true, checks: [] }, human: "ready" };

let doctorRan = 0;
let doctoredAs: string | undefined;

/** A Claude Code where its installer puts it, ahead of the stubs on PATH. */
const claudeAt = (script: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${home}/.local/bin`, { recursive: true });
    yield* fs.writeFileString(`${home}/.local/bin/claude`, `#!/bin/sh\n${script}\n`, {
      mode: 0o755,
    });
  });

const GITLAB = "gitlab.cego.dk";

/** Real glab writes auth status to stderr. */
const glab = (status: string, rest = "") =>
  bin.add(
    "glab",
    `case "$*" in
      "auth status"*) { ${status}; } >&2 ;;
      *) echo "GITLAB_HOST=$GITLAB_HOST $*" >> "${home}/glab-calls"; ${rest || ":"} ;;
    esac`,
  );

/** onboard against this Machine, collecting what it streamed. */
const onboarded = (overrides: Record<string, string> = {}, options: Partial<OnboardOptions> = {}) =>
  Effect.gen(function* () {
    const events: OnboardEvent[] = [];
    const env = readEnv({
      HOME: home,
      PATH: `${home}/stubs:/usr/bin:/bin`,
      SHELL: "/bin/bash",
      HERDR_PLUGIN_ROOT: `${home}/nowhere`,
      ...overrides,
    });
    const result = yield* onboard(
      env,
      { to: manifest.version, carried, skip: ["helle", "linear"], ...options },
      (event) => Effect.sync(() => events.push(event)),
      (checked) =>
        Effect.sync(() => (doctorRan++, (doctoredAs = checked.raw["GITLAB_HOST"]), READY)),
    );
    return { result, events };
  });

const results = (events: OnboardEvent[]) =>
  Arr.flatMap(events, (event) => (event.event === "result" ? [event] : []));

const statusOf = (events: OnboardEvent[], step: string) =>
  Option.getOrUndefined(Arr.findFirst(results(events), (event) => event.step === step))?.status;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      home = yield* fs.makeTempDirectory({ prefix: "collie-onboard-" });
      root = `${home}/.collie`;
      doctorRan = 0;
      carried = yield* carry();
      bin = yield* FakeBin.make(`${home}/stubs`);
      yield* fs.writeFileString(`${home}/herdr-installer`, installer("herdr"));
      yield* fs.writeFileString(`${home}/claude-installer`, installer("claude", LOGGED_IN));
      yield* bin.add(
        "curl",
        `echo "$*" >> "${home}/curl-calls"
        case "$*" in
          *herdr.dev/install.sh*) cat "${home}/herdr-installer" ;;
          *claude.ai/install.sh*) cat "${home}/claude-installer" ;;
          *) exit 22 ;;
        esac`,
      );
      // No test reaches a real GitLab over SSH.
      yield* bin.add("ssh", `echo "Permission denied (publickey)." >&2; exit 255`);
      // Logged in to GitLab, and pushing over HTTPS with that login.
      yield* glab(
        `echo "${GITLAB}"; echo "  ✓ Git operations for ${GITLAB} configured to use https protocol."`,
      );
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.restore();
      yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.remove(home, { recursive: true, force: true }),
      );
    }),
  ),
);

test("a bare Machine gets herdr, Claude Code, the release placed, the plugin and PATH", () =>
  runEffect(
    Effect.gen(function* () {
      const { result, events } = yield* onboarded();

      expect(result).toMatchObject({ ok: true, data: { ready: true } });
      // Every step streams a start and then its result.
      const steps = Arr.map(results(events), (event) => event.step);
      expect(steps).toEqual([
        "system",
        "collie",
        "herdr",
        "claude",
        "path",
        "plugin",
        "claude-login",
        "gitlab",
        "push",
        "helle",
        "linear",
        "doctor",
      ]);
      for (const step of steps) {
        const start = Option.getOrElse(
          Arr.findFirstIndex(events, (e) => e.event === "start" && e.step === step),
          () => -1,
        );
        const end = Option.getOrElse(
          Arr.findFirstIndex(events, (e) => e.event === "result" && e.step === step),
          () => -1,
        );
        expect(start).toBeGreaterThanOrEqual(0);
        expect(start).toBeLessThan(end);
      }
      for (const step of ["collie", "herdr", "claude", "path", "plugin", "doctor"]) {
        expect(statusOf(events, step)).toBe("done");
      }
      for (const step of ["system", "claude-login", "gitlab", "push"])
        expect(statusOf(events, step)).toBe("in_place");
      for (const step of ["helle", "linear"]) expect(statusOf(events, step)).toBe("skipped");
      expect(yield* read(`${root}/release/herdr-plugin.toml`)).toContain(manifest.version);
      expect(yield* (yield* FileSystem.FileSystem).exists(`${root}/.git`)).toBe(false);
      expect(yield* read(`${home}/curl-calls`)).toContain("https://herdr.dev/install.sh");
      expect(yield* read(`${home}/curl-calls`)).toContain("https://claude.ai/install.sh");
      // Once as the release is placed, and once more with herdr installed.
      expect(yield* read(`${home}/prepared`)).toBe("ran\nran\n");
      expect(yield* read(`${home}/.bashrc`)).toContain(`export PATH="${home}/.local/bin:$PATH"`);
      expect(doctorRan).toBe(1);
    }),
  ));

test("a re-run is a repair: everything already in place is left alone", () =>
  runEffect(
    Effect.gen(function* () {
      yield* onboarded();
      const curls = yield* read(`${home}/curl-calls`);
      const profile = yield* read(`${home}/.bashrc`);

      const { result, events } = yield* onboarded();

      expect(result).toMatchObject({ ok: true, data: { ready: true } });
      for (const step of ["system", "collie", "herdr", "claude", "path"]) {
        expect(statusOf(events, step)).toBe("in_place");
      }
      expect(yield* read(`${home}/curl-calls`)).toBe(curls);
      expect(yield* read(`${home}/.bashrc`)).toBe(profile);
    }),
  ));

test("a release at another version is replaced by the one asked for", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${root}/release`, { recursive: true });
      yield* fs.writeFileString(`${root}/release/herdr-plugin.toml`, `version = "0.1.0"\n`);

      const { events } = yield* onboarded();

      expect(statusOf(events, "collie")).toBe("done");
      expect(yield* read(`${root}/release/herdr-plugin.toml`)).toContain(manifest.version);
    }),
  ));

test("missing git stops with the exact command to run as root, and changes nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tools = `${home}/tools`;
      yield* fs.makeDirectory(tools);
      for (const name of ["sh", "bash", "env", "cat", "mkdir", "chmod", "printf"]) {
        yield* Effect.ignore(fs.symlink(`/bin/${name}`, `${tools}/${name}`));
      }
      yield* fs.symlink("/usr/bin/openssl", `${tools}/openssl`);
      yield* bin.add("apt-get", "exit 0");

      const { result, events } = yield* onboarded({ PATH: `${home}/stubs:${tools}` });

      expect(result).toMatchObject({ ok: false, error: { details: { ready: false } } });
      const system = Option.getOrUndefined(
        Arr.findFirst(results(events), (event) => event.step === "system"),
      );
      expect(system).toMatchObject({
        status: "needs_root",
        command: "sudo apt-get install -y git",
      });
      expect(Arr.map(results(events), (event) => event.step)).toEqual(["system"]);
      expect(yield* fs.exists(root)).toBe(false);
      expect(doctorRan).toBe(0);
    }),
  ));

/** The system step on a Machine with `tools` on PATH and `manager` as its package manager. */
const systemWith = Effect.fn("onboardTest.systemWith")(function* (
  tools: Record<string, string>,
  manager: string,
  env: Record<string, string> = {},
) {
  for (const [tool, body] of Rec.toEntries({ ...tools, [manager]: "exit 0" })) {
    yield* bin.add(tool, body);
  }
  const { events } = yield* onboarded({ PATH: `${home}/stubs`, ...env });
  return Option.getOrUndefined(Arr.findFirst(results(events), (event) => event.step === "system"));
});

test("any openssl will do, LibreSSL among them", () =>
  runEffect(
    Effect.gen(function* () {
      const system = yield* systemWith(
        { git: "exit 0", curl: "exit 0", openssl: `echo "LibreSSL 3.3.6"` },
        "brew",
      );
      expect(system).toMatchObject({ status: "in_place" });
    }),
  ));

test("COLLIE_OPENSSL names the openssl there is, off PATH", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const named = `${home}/elsewhere/openssl`;
      yield* fs.makeDirectory(`${home}/elsewhere`);
      yield* fs.writeFileString(named, `#!/bin/sh\necho "LibreSSL 3.3.6"\n`);
      yield* fs.chmod(named, 0o755);
      const tools = { git: "exit 0", curl: "exit 0" };

      expect(yield* systemWith(tools, "brew", { COLLIE_OPENSSL: named })).toMatchObject({
        status: "in_place",
      });
    }),
  ));

test("a missing openssl stops with the package manager's command", () =>
  runEffect(
    Effect.gen(function* () {
      const system = yield* systemWith({ git: "exit 0", curl: "exit 0" }, "dnf");
      expect(system).toMatchObject({
        status: "needs_root",
        command: "sudo dnf install -y openssl",
      });
    }),
  ));

test("a development checkout gets the checks, and nothing installed or moved", () =>
  runEffect(
    Effect.gen(function* () {
      const dev = `${home}/dev`;
      yield* (yield* FileSystem.FileSystem).makeDirectory(dev);
      yield* git(dev, "init", "--quiet", "-b", "feature");
      yield* git(dev, "commit", "--quiet", "--allow-empty", "-m", "work");
      const head = yield* git(dev, "rev-parse", "HEAD");
      yield* claudeAt(`case "$*" in "auth status --json") ${LOGGED_IN} ;; esac`);

      const { result, events } = yield* onboarded({ HERDR_PLUGIN_ROOT: dev });

      expect(result).toMatchObject({ ok: true, data: { ready: true, development: true } });
      expect(statusOf(events, "collie")).toBe("skipped");
      expect(Arr.map(results(events), (event) => event.step)).toEqual([
        "system",
        "collie",
        "claude-login",
        "gitlab",
        "push",
        "helle",
        "linear",
        "doctor",
      ]);
      expect(yield* git(dev, "rev-parse", "HEAD")).toBe(head);
      expect(yield* (yield* FileSystem.FileSystem).exists(root)).toBe(false);
      expect(yield* read(`${home}/curl-calls`)).toBe("");
      expect(yield* read(`${home}/prepared`)).toBe("");
      expect(doctorRan).toBe(1);
    }),
  ));

test("onboarded means doctor is ready", () =>
  runEffect(
    Effect.gen(function* () {
      const events: OnboardEvent[] = [];
      const env = readEnv({
        HOME: home,
        PATH: `${home}/stubs:/usr/bin:/bin`,
        HERDR_PLUGIN_ROOT: `${home}/nowhere`,
      });
      const notReady = err("operation_failed", "1 of 2 checks failed.", {
        ready: false,
        checks: [{ name: "glab", ok: false, detail: "not installed", fix: "" }],
      });

      const result = yield* onboard(
        env,
        { to: manifest.version, carried, skip: ["helle", "linear"] },
        (event) => Effect.sync(() => events.push(event)),
        () => Effect.succeed(notReady),
      );

      expect(result).toMatchObject({ ok: false, error: { details: { ready: false } } });
      expect(results(events).at(-1)).toMatchObject({ step: "doctor", status: "failed" });
      expect(results(events).at(-1)?.detail).toContain("glab");
    }),
  ));

test("the GitLab token goes to glab on stdin, never on its command line", () =>
  runEffect(
    Effect.gen(function* () {
      yield* glab(
        `[ -f "${home}/logged-in" ] && echo "${GITLAB}" && echo "  ✓ Git operations for ${GITLAB} configured to use https protocol."`,
        `cat > "${home}/glab-stdin"; touch "${home}/logged-in"`,
      );

      const { events } = yield* onboarded({}, { secrets: { GITLAB_TOKEN: "glpat-secret" } });

      expect(statusOf(events, "gitlab")).toBe("done");
      const calls = yield* read(`${home}/glab-calls`);
      expect(calls).toContain(`auth login --hostname ${GITLAB} --stdin`);
      expect(calls).not.toContain("glpat-secret");
      expect(yield* read(`${home}/glab-stdin`)).toBe("glpat-secret\n");
    }),
  ));

test("without a token, the GitLab step sends the human to the token page", () =>
  runEffect(
    Effect.gen(function* () {
      yield* glab("exit 1");

      const { result, events } = yield* onboarded();

      const gitlab = Option.getOrUndefined(
        Arr.findFirst(results(events), (event) => event.step === "gitlab"),
      );
      expect(gitlab?.status).toBe("needs_human");
      expect(gitlab?.url).toContain(`https://${GITLAB}/-/user_settings/personal_access_tokens`);
      expect(gitlab?.url).toContain("scopes=api,write_repository");
      expect(result).toMatchObject({ ok: false, error: { details: { ready: false } } });
    }),
  ));

test("the GitLab host setting moves the token page, the login, the push and doctor, and GITLAB_HOST overrides it", () =>
  runEffect(
    Effect.gen(function* () {
      const config = `${home}/config`;
      yield* writeConfigValue(config, "gitlab_host", "gitlab.com");
      yield* glab("exit 1");

      const { events } = yield* onboarded({ COLLIE_USER_DIR: config });

      const started = (step: string) =>
        Option.getOrUndefined(
          Arr.findFirst(events, (event) => event.event === "start" && event.step === step),
        );
      expect(started("gitlab")).toMatchObject({ title: "Logged in to gitlab.com" });
      expect(started("push")).toMatchObject({
        title: "git push to gitlab.com on this Machine's own credentials",
      });
      const gitlab = Option.getOrUndefined(
        Arr.findFirst(results(events), (event) => event.step === "gitlab"),
      );
      expect(gitlab?.url).toStartWith("https://gitlab.com/-/user_settings/personal_access_tokens");
      expect(doctoredAs).toBe("gitlab.com");

      const overridden = yield* onboarded({ COLLIE_USER_DIR: config, GITLAB_HOST: GITLAB });
      expect(
        Option.getOrUndefined(
          Arr.findFirst(results(overridden.events), (event) => event.step === "gitlab"),
        )?.url,
      ).toContain(`https://${GITLAB}/`);
      expect(doctoredAs).toBe(GITLAB);
    }),
  ));

test("a glab logged in with another token is given the one onboarding brings, and the same one is left as it is", () =>
  runEffect(
    Effect.gen(function* () {
      yield* glab(
        `echo "${GITLAB}" && echo "  ✓ Git operations for ${GITLAB} configured to use https protocol."`,
        `case "$*" in
          "config get token --host ${GITLAB}") cat "${home}/glab-token" ;;
          "auth login"*) cat > "${home}/glab-token" ;;
        esac`,
      );
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${home}/glab-token`, "glpat-old\n");

      const renewed = yield* onboarded({}, { secrets: { GITLAB_TOKEN: "glpat-new" } });
      expect(statusOf(renewed.events, "gitlab")).toBe("done");
      expect(yield* read(`${home}/glab-token`)).toBe("glpat-new\n");

      const again = yield* onboarded({}, { secrets: { GITLAB_TOKEN: "glpat-new" } });
      expect(statusOf(again.events, "gitlab")).toBe("in_place");
    }),
  ));

test("a Machine that cannot push gets a key of its own, registered with glab", () =>
  runEffect(
    Effect.gen(function* () {
      yield* glab(`echo "${GITLAB}"`, `touch "${home}/registered"`);
      yield* bin.add(
        "ssh",
        `[ -f "${home}/registered" ] && exit 0; echo "Permission denied (publickey)." >&2; exit 255`,
      );

      const { events } = yield* onboarded();

      expect(statusOf(events, "push")).toBe("done");
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(`${home}/.ssh/id_ed25519.pub`)).toBe(true);
      expect(yield* read(`${home}/glab-calls`)).toContain(
        `GITLAB_HOST=${GITLAB} ssh-key add ${home}/.ssh/id_ed25519.pub --title`,
      );
    }),
  ));

test("a Machine that can already push gets no key", () =>
  runEffect(
    Effect.gen(function* () {
      const { events } = yield* onboarded();

      expect(statusOf(events, "push")).toBe("in_place");
      expect(yield* read(`${home}/glab-calls`)).not.toContain("ssh-key add");
    }),
  ));

test("Slack handed on stdin is written owner-only without appearing in onboarding events", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { events } = yield* onboarded(
        {},
        { secrets: { SLACK_BOT_TOKEN: "xoxb-fixture-secret" } },
      );
      expect(statusOf(events, "slack")).toBe("done");
      expect(yield* read(`${home}/.config/collie/slack.env`)).toBe(
        "SLACK_BOT_TOKEN=xoxb-fixture-secret\n",
      );
      expect((yield* fs.stat(`${home}/.config/collie/slack.env`)).mode & 0o777).toBe(0o600);
      expect(
        Arr.some(
          events,
          (event) => "detail" in event && pipe_(event.detail, Str.includes("xoxb-fixture-secret")),
        ),
      ).toBe(false);
    }),
  ));

test("Helle's credentials file is written owner-only", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const { events } = yield* onboarded(
        {},
        {
          skip: ["linear"],
          secrets: { HELLE_API_TOKEN: "helle-secret" },
        },
      );

      expect(statusOf(events, "helle")).toBe("done");
      const file = `${home}/.config/helle/env`;
      expect(yield* read(file)).toBe(
        "HELLE_API_URL=https://helle.cego.dk\nHELLE_API_TOKEN=helle-secret\n",
      );
      expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);
    }),
  ));

test("an existing Helle file readable by others is made owner-only", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = `${home}/.config/helle/env`;
      yield* fs.makeDirectory(`${home}/.config/helle`, { recursive: true });
      yield* fs.writeFileString(file, "HELLE_API_URL=old\n", { mode: 0o644 });

      yield* onboarded(
        {},
        {
          skip: ["linear"],
          secrets: { HELLE_API_TOKEN: "helle-secret" },
        },
      );

      expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);
    }),
  ));

test("Helle without credentials is not onboarded unless it is skipped", () =>
  runEffect(
    Effect.gen(function* () {
      const asked = yield* onboarded({}, { skip: ["linear"] });
      const skipped = yield* onboarded();

      expect(statusOf(asked.events, "helle")).toBe("needs_human");
      expect(
        Option.getOrUndefined(
          Arr.findFirst(results(asked.events), (event) => event.step === "helle"),
        )?.detail,
      ).toContain('run /helle token, press "Create new token"');
      expect(asked.result).toMatchObject({ ok: false });
      expect(statusOf(skipped.events, "helle")).toBe("skipped");
      expect(skipped.result).toMatchObject({ ok: true, data: { ready: true } });
    }),
  ));

test("the Linear MCP is added at user scope, and its login streams its URL", () =>
  runEffect(
    Effect.gen(function* () {
      const url =
        "https://mcp.linear.app/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A62074%2Fcallback&state=s";
      yield* claudeAt(
        `echo "$*" >> "${home}/claude-calls"
case "$*" in
  "auth status --json") ${LOGGED_IN} ;;
  "mcp add"*) echo '{"mcpServers":{"linear-server":{"url":"https://mcp.linear.app/mcp"}}}' > "$HOME/.claude.json" ;;
  "mcp get linear-server") if [ -f "${home}/authorized" ]; then echo "  Status: ✔ Connected"; else echo "  Status: ! Needs authentication"; fi ;;
  "mcp login linear-server") [ -t 0 ] && [ -t 1 ] && echo tty >> "${home}/claude-calls"; echo "If the browser didn't open, visit:"; echo "  ${url}"; sleep 0.2; touch "${home}/authorized" ;;
esac`,
      );

      const { events } = yield* onboarded({}, { skip: ["helle"] });

      expect(yield* read(`${home}/claude-calls`)).toContain(
        "mcp add --transport http --scope user linear-server https://mcp.linear.app/mcp",
      );
      // In a terminal of its own: on macOS too, where `script` takes other flags.
      expect(yield* read(`${home}/claude-calls`)).toContain("mcp login linear-server\ntty\n");
      const human = Option.getOrElse(
        Arr.findFirstIndex(events, (event) => event.event === "human" && event.step === "linear"),
        () => -1,
      );
      const end = Option.getOrElse(
        Arr.findFirstIndex(events, (event) => event.event === "result" && event.step === "linear"),
        () => -1,
      );
      expect(events[human]).toMatchObject({ url, port: 62074 });
      expect(human).toBeLessThan(end);
      expect(statusOf(events, "linear")).toBe("done");
    }),
  ));

test("a Linear login that hands its callback URL to $BROWSER, printing only a paste-code URL, still streams the URL with its port", () =>
  runEffect(
    Effect.gen(function* () {
      const handed =
        "https://mcp.linear.app/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A62074%2Fcallback&state=s";
      yield* claudeAt(
        `case "$*" in
  "auth status --json") ${LOGGED_IN} ;;
  "mcp add"*) echo '{"mcpServers":{"linear-server":{"url":"https://mcp.linear.app/mcp"}}}' > "$HOME/.claude.json" ;;
  "mcp get linear-server") if [ -f "${home}/authorized" ]; then echo "  Status: ✔ Connected"; else echo "  Status: ! Needs authentication"; fi ;;
  "mcp login linear-server") "$BROWSER" '${handed}'; echo "Paste this code: https://mcp.linear.app/authorize?redirect_uri=https%3A%2F%2Fexample.com"; sleep 1; touch "${home}/authorized" ;;
esac`,
      );

      const { events } = yield* onboarded({}, { skip: ["helle"] });

      const human = Arr.filter(
        events,
        (event) => event.event === "human" && event.step === "linear",
      );
      expect(human.at(-1)).toMatchObject({ url: handed, port: 62074 });
      expect(statusOf(events, "linear")).toBe("done");
    }),
  ));

test("unattended, a login is left as a step for the human rather than started", () =>
  runEffect(
    Effect.gen(function* () {
      yield* claudeAt(
        `echo "$*" >> "${home}/claude-calls"
case "$*" in
  "mcp add"*) echo '{"mcpServers":{"linear-server":{"url":"https://mcp.linear.app/mcp"}}}' > "$HOME/.claude.json" ;;
esac`,
      );

      const { result, events } = yield* onboarded({}, { skip: ["helle"], attended: false });

      expect(
        Option.getOrUndefined(Arr.findFirst(results(events), (e) => e.step === "claude-login")),
      ).toMatchObject({
        status: "needs_human",
        command: "claude auth login",
      });
      expect(
        Option.getOrUndefined(Arr.findFirst(results(events), (e) => e.step === "linear")),
      ).toMatchObject({
        status: "needs_human",
        command: "claude mcp login linear-server",
      });
      expect(yield* read(`${home}/claude-calls`)).not.toContain("mcp login");
      expect(result).toMatchObject({ ok: false });
    }),
  ));

test("Claude Code is asked whether it is logged in with the whole environment, not only what Collie reads", () => {
  // On macOS its Keychain lookup needs USER, which `currentEnv` does not keep.
  const user = Bun.env.USER;
  Bun.env.USER = "someone";
  return runEffect(
    Effect.gen(function* () {
      yield* claudeAt(
        `[ "$USER" = someone ] && echo '{"loggedIn": true}' || echo '{"loggedIn": false}'`,
      );

      const { events } = yield* onboarded({}, { attended: false });

      expect(statusOf(events, "claude-login")).toBe("in_place");
    }),
  ).finally(() => {
    if (user === undefined) delete Bun.env.USER;
    else Bun.env.USER = user;
  });
});

test("attended Linear login keeps the ambient environment and onboarding's overrides", () =>
  runEffect(
    Effect.gen(function* () {
      const ambient = { USER: "onboard-user", COLLIE_LINEAR_INHERITED: "kept" };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const was = Rec.fromEntries(
            Arr.map(Rec.keys(ambient), (name) => [name, Bun.env[name]] as const),
          );
          Object.assign(Bun.env, ambient);
          return was;
        }),
        (was) =>
          Effect.sync(() => {
            for (const [name, value] of Rec.toEntries(was)) {
              if (value === undefined) delete Bun.env[name];
              else Bun.env[name] = value;
            }
          }),
      );
      yield* claudeAt(
        `case "$*" in
  "auth status --json") ${LOGGED_IN} ;;
  "mcp add"*) echo '{"mcpServers":{"linear-server":{"url":"https://mcp.linear.app/mcp"}}}' > "$HOME/.claude.json" ;;
  "mcp get linear-server") if [ -f "${home}/authorized" ]; then echo "Connected"; else echo "Needs authentication"; fi ;;
  "mcp login linear-server")
    [ "$USER" = onboard-user ] && [ "$COLLIE_LINEAR_INHERITED" = kept ] && [ "$HOME" = "${home}" ] && [ -x "$BROWSER" ] || exit 1
    touch "${home}/authorized" ;;
esac`,
      );

      const { result, events } = yield* onboarded({}, { skip: ["helle"], attended: true });

      expect(statusOf(events, "linear")).toBe("done");
      expect(result).toMatchObject({ ok: true, data: { ready: true } });
    }),
  ));

test("a terminal shows each step as text", () => {
  expect(eventText({ event: "start", step: "system", title: "Checking for git and curl" })).toBe(
    "→ Checking for git and curl",
  );
  expect(
    eventText({
      event: "result",
      step: "system",
      status: "needs_root",
      detail: "git must be installed as root",
      command: "sudo apt-get install -y git",
    }),
  ).toBe("  ✗ git must be installed as root\n    run: sudo apt-get install -y git");
  expect(
    eventText({ event: "human", step: "linear", detail: "open this", url: "https://x.example" }),
  ).toBe("  … open this\n    open: https://x.example");
});

test("a fresh Machine with an unknown host key and no registered key gets one in one pass", () =>
  runEffect(
    Effect.gen(function* () {
      yield* glab(`echo "${GITLAB}"`, `touch "${home}/registered"`);
      yield* bin.add(
        "ssh",
        `case "$*" in *StrictHostKeyChecking=accept-new*) touch "${home}/known"; exit 255 ;; esac
        [ -f "${home}/known" ] || { echo "Host key verification failed." >&2; exit 255; }
        [ -f "${home}/registered" ] && exit 0
        echo "Permission denied (publickey)." >&2; exit 255`,
      );

      const { events } = yield* onboarded();

      expect(statusOf(events, "push")).toBe("done");
    }),
  ));

test("a key GitLab already has is not a failed registration", () =>
  runEffect(
    Effect.gen(function* () {
      yield* glab(
        `echo "${GITLAB}"`,
        `touch "${home}/registered"; echo "fingerprint has already been taken" >&2; exit 1`,
      );
      yield* bin.add(
        "ssh",
        `[ -f "${home}/registered" ] && exit 0; echo "Permission denied (publickey)." >&2; exit 255`,
      );

      const { events } = yield* onboarded();

      expect(statusOf(events, "push")).toBe("done");
    }),
  ));
