// `collie onboard`: its step stream against scripted Machines. Real git against a local
// origin, so "a release" is git's answer; every installer and system tool that would
// reach the network or need root is a stub on PATH.

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

let home: string;
let origin: string;
let root: string;
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
        ? Effect.succeed(done.stdout.trim())
        : Effect.die(new Error(`git ${args.join(" ")}: ${done.stderr}`)),
    ),
  );

const release = Effect.fn("test.release")(function* (version: string) {
  yield* exec(
    [
      "sh",
      "-c",
      `printf 'echo ran >> "$HOME/prepared"\\necho "prepare: runner: done"\\necho "prepare: skills: done"\\n' > prepare.sh; echo 'version = "${version}"' > herdr-plugin.toml`,
    ],
    { cwd: origin },
  );
  yield* git(origin, "add", ".");
  yield* git(origin, "commit", "--quiet", "-m", version);
  yield* git(origin, "tag", version);
});

const read = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed(""))),
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

/** A glab whose `auth status` runs `status`, and that records everything else it is asked. */
const glab = (status: string, rest = "") =>
  bin.add(
    "glab",
    `case "$*" in
      "auth status"*) ${status} ;;
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
      COLLIE_REPO: origin,
      HERDR_PLUGIN_ROOT: `${home}/nowhere`,
      ...overrides,
    });
    const result = yield* onboard(
      env,
      { to: "0.2.0", skip: ["helle", "linear"], ...options },
      (event) => Effect.sync(() => events.push(event)),
      (checked) =>
        Effect.sync(() => (doctorRan++, (doctoredAs = checked.raw["GITLAB_HOST"]), READY)),
    );
    return { result, events };
  });

const results = (events: OnboardEvent[]) =>
  events.flatMap((event) => (event.event === "result" ? [event] : []));

const statusOf = (events: OnboardEvent[], step: string) =>
  results(events).find((event) => event.step === step)?.status;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      home = yield* fs.makeTempDirectory({ prefix: "collie-onboard-" });
      origin = `${home}/origin`;
      root = `${home}/.collie`;
      doctorRan = 0;
      yield* fs.makeDirectory(origin);
      yield* git(origin, "init", "--quiet", "-b", "master");
      yield* release("0.1.0");
      yield* release("0.2.0");
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
      yield* bin.add("ssh", `echo "Permission denied (publickey)."; exit 255`);
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

test("a bare Machine gets herdr, Claude Code, Collie at the tag, the plugin and PATH", () =>
  runEffect(
    Effect.gen(function* () {
      const { result, events } = yield* onboarded();

      expect(result).toMatchObject({ ok: true, data: { ready: true } });
      // Every step streams a start and then its result.
      const steps = results(events).map((event) => event.step);
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
        const start = events.findIndex((e) => e.event === "start" && e.step === step);
        const end = events.findIndex((e) => e.event === "result" && e.step === step);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(start).toBeLessThan(end);
      }
      for (const step of ["collie", "herdr", "claude", "path", "plugin", "doctor"]) {
        expect(statusOf(events, step)).toBe("done");
      }
      for (const step of ["system", "claude-login", "gitlab", "push"])
        expect(statusOf(events, step)).toBe("in_place");
      for (const step of ["helle", "linear"]) expect(statusOf(events, step)).toBe("skipped");
      expect(yield* git(root, "describe", "--exact-match", "--tags", "HEAD")).toBe("0.2.0");
      // On its branch, so a plain `collie upgrade` can pull.
      expect(yield* git(root, "symbolic-ref", "--short", "HEAD")).toBe("master");
      expect(yield* read(`${home}/curl-calls`)).toContain("https://herdr.dev/install.sh");
      expect(yield* read(`${home}/curl-calls`)).toContain("https://claude.ai/install.sh");
      expect(yield* read(`${home}/prepared`)).toBe("ran\n");
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

test("a released checkout on an older version is moved to the one asked for", () =>
  runEffect(
    Effect.gen(function* () {
      yield* git(home, "clone", "--quiet", "--branch", "0.1.0", origin, root);

      const { events } = yield* onboarded();

      expect(statusOf(events, "collie")).toBe("done");
      expect(yield* git(root, "describe", "--exact-match", "--tags", "HEAD")).toBe("0.2.0");
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
      const system = results(events).find((event) => event.step === "system");
      expect(system).toMatchObject({
        status: "needs_root",
        command: "sudo apt-get install -y git",
      });
      expect(results(events).map((event) => event.step)).toEqual(["system"]);
      expect(yield* fs.exists(root)).toBe(false);
      expect(doctorRan).toBe(0);
    }),
  ));

/** A Machine whose only openssl is LibreSSL, with `manager` as its package manager. */
const withLibreSsl = Effect.fn("onboardTest.withLibreSsl")(function* (manager: string) {
  yield* bin.add("openssl", `echo "LibreSSL 3.3.6"`);
  for (const tool of ["git", "curl", manager]) yield* bin.add(tool, "exit 0");
  const { events } = yield* onboarded({ PATH: `${home}/stubs`, COLLIE_OPENSSL: "openssl" });
  expect(results(events).map((event) => event.step)).toEqual(["system"]);
  return results(events).find((event) => event.step === "system");
});

test("an openssl that cannot check a signature stops with what gives OpenSSL 3 here", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* withLibreSsl("dnf")).toMatchObject({
        status: "needs_root",
        detail: expect.stringContaining("LibreSSL"),
        command: "sudo dnf install -y epel-release && sudo dnf install -y openssl3",
      });
    }),
  ));

test("where no package gives OpenSSL 3, the step names none to run", () =>
  runEffect(
    Effect.gen(function* () {
      const system = yield* withLibreSsl("apt-get");
      expect(system).toMatchObject({ status: "needs_root" });
      expect(system).not.toHaveProperty("command");
    }),
  ));

test("a development checkout gets the checks, and nothing installed or moved", () =>
  runEffect(
    Effect.gen(function* () {
      yield* git(home, "clone", "--quiet", origin, root);
      yield* git(root, "checkout", "--quiet", "-b", "feature");
      const head = yield* git(root, "rev-parse", "HEAD");
      yield* claudeAt(`case "$*" in "auth status --json") ${LOGGED_IN} ;; esac`);

      const { result, events } = yield* onboarded({ HERDR_PLUGIN_ROOT: root });

      expect(result).toMatchObject({ ok: true, data: { ready: true, development: true } });
      expect(statusOf(events, "collie")).toBe("skipped");
      expect(results(events).map((event) => event.step)).toEqual([
        "system",
        "collie",
        "claude-login",
        "gitlab",
        "push",
        "helle",
        "linear",
        "doctor",
      ]);
      expect(yield* git(root, "rev-parse", "HEAD")).toBe(head);
      expect(yield* git(root, "symbolic-ref", "--short", "HEAD")).toBe("feature");
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
        COLLIE_REPO: origin,
        HERDR_PLUGIN_ROOT: `${home}/nowhere`,
      });
      const notReady = err("operation_failed", "1 of 2 checks failed.", {
        ready: false,
        checks: [{ name: "glab", ok: false, detail: "not installed", fix: "" }],
      });

      const result = yield* onboard(
        env,
        { to: "0.2.0", skip: ["helle", "linear"] },
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

      const gitlab = results(events).find((event) => event.step === "gitlab");
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
        events.find((event) => event.event === "start" && event.step === step);
      expect(started("gitlab")).toMatchObject({ title: "Logged in to gitlab.com" });
      expect(started("push")).toMatchObject({
        title: "git push to gitlab.com on this Machine's own credentials",
      });
      const gitlab = results(events).find((event) => event.step === "gitlab");
      expect(gitlab?.url).toStartWith("https://gitlab.com/-/user_settings/personal_access_tokens");
      expect(doctoredAs).toBe("gitlab.com");

      const overridden = yield* onboarded({ COLLIE_USER_DIR: config, GITLAB_HOST: GITLAB });
      expect(results(overridden.events).find((event) => event.step === "gitlab")?.url).toContain(
        `https://${GITLAB}/`,
      );
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
        `[ -f "${home}/registered" ] && exit 0; echo "Permission denied (publickey)."; exit 255`,
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

test("Helle's credentials file is written owner-only", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const { events } = yield* onboarded(
        {},
        {
          skip: ["linear"],
          secrets: { HELLE_API_URL: "https://helle.example", HELLE_API_TOKEN: "helle-secret" },
        },
      );

      expect(statusOf(events, "helle")).toBe("done");
      const file = `${home}/.config/helle/env`;
      expect(yield* read(file)).toContain("HELLE_API_TOKEN=helle-secret");
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
          secrets: { HELLE_API_URL: "https://helle.example", HELLE_API_TOKEN: "helle-secret" },
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
      expect(asked.result).toMatchObject({ ok: false });
      expect(statusOf(skipped.events, "helle")).toBe("skipped");
      expect(skipped.result).toMatchObject({ ok: true, data: { ready: true } });
    }),
  ));

test("the Linear MCP is added at user scope, and its login streams its URL", () =>
  runEffect(
    Effect.gen(function* () {
      yield* claudeAt(
        `echo "$*" >> "${home}/claude-calls"
case "$*" in
  "auth status --json") ${LOGGED_IN} ;;
  "mcp add"*) echo '{"mcpServers":{"linear-server":{"url":"https://mcp.linear.app/mcp"}}}' > "$HOME/.claude.json" ;;
  "mcp get linear-server") if [ -f "${home}/authorized" ]; then echo "  Status: ✔ Connected"; else echo "  Status: ! Needs authentication"; fi ;;
esac`,
      );
      const url =
        "https://mcp.linear.app/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A62074%2Fcallback&state=s";
      yield* bin.add(
        "script",
        `echo "$*" >> "${home}/script-calls"; echo "If the browser didn't open, visit:"; echo "  ${url}"; sleep 0.2; touch "${home}/authorized"`,
      );

      const { events } = yield* onboarded({}, { skip: ["helle"] });

      expect(yield* read(`${home}/claude-calls`)).toContain(
        "mcp add --transport http --scope user linear-server https://mcp.linear.app/mcp",
      );
      expect(yield* read(`${home}/script-calls`)).toContain("claude mcp login linear-server");
      const human = events.findIndex((event) => event.event === "human" && event.step === "linear");
      const end = events.findIndex((event) => event.event === "result" && event.step === "linear");
      expect(events[human]).toMatchObject({ url, port: 62074 });
      expect(human).toBeLessThan(end);
      expect(statusOf(events, "linear")).toBe("done");
    }),
  ));

test("a Linear login that hands its callback URL to $BROWSER, printing only a paste-code URL, still streams the URL with its port", () =>
  runEffect(
    Effect.gen(function* () {
      yield* claudeAt(
        `case "$*" in
  "auth status --json") ${LOGGED_IN} ;;
  "mcp add"*) echo '{"mcpServers":{"linear-server":{"url":"https://mcp.linear.app/mcp"}}}' > "$HOME/.claude.json" ;;
  "mcp get linear-server") if [ -f "${home}/authorized" ]; then echo "  Status: ✔ Connected"; else echo "  Status: ! Needs authentication"; fi ;;
esac`,
      );
      const handed =
        "https://mcp.linear.app/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A62074%2Fcallback&state=s";
      yield* bin.add(
        "script",
        `"$BROWSER" '${handed}'; echo "Paste this code: https://mcp.linear.app/authorize?redirect_uri=https%3A%2F%2Fexample.com"; sleep 1; touch "${home}/authorized"`,
      );

      const { events } = yield* onboarded({}, { skip: ["helle"] });

      const human = events.filter((event) => event.event === "human" && event.step === "linear");
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
      yield* bin.add("script", `echo "$*" >> "${home}/script-calls"`);

      const { result, events } = yield* onboarded({}, { skip: ["helle"], attended: false });

      expect(results(events).find((e) => e.step === "claude-login")).toMatchObject({
        status: "needs_human",
        command: "claude auth login",
      });
      expect(results(events).find((e) => e.step === "linear")).toMatchObject({
        status: "needs_human",
        command: "claude mcp login linear-server",
      });
      expect(yield* read(`${home}/script-calls`)).toBe("");
      expect(result).toMatchObject({ ok: false });
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
        [ -f "${home}/known" ] || { echo "Host key verification failed."; exit 255; }
        [ -f "${home}/registered" ] && exit 0
        echo "Permission denied (publickey)."; exit 255`,
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
        `touch "${home}/registered"; echo "fingerprint has already been taken"; exit 1`,
      );
      yield* bin.add(
        "ssh",
        `[ -f "${home}/registered" ] && exit 0; echo "Permission denied (publickey)."; exit 255`,
      );

      const { events } = yield* onboarded();

      expect(statusOf(events, "push")).toBe("done");
    }),
  ));
