// `collie onboard`: its step stream against scripted Machines. Real git against a local
// origin, so "a release" is git's answer; every installer and system tool that would
// reach the network or need root is a stub on PATH.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { FakeBin } from "./support/bin";
import { readEnv } from "../src/env";
import { onboard, type OnboardEvent } from "../src/onboard";
import { err, type OpResult } from "../src/operations";

let home: string;
let origin: string;
let root: string;
let bin: FakeBin;

const git = (cwd: string, ...args: string[]) => {
  const done = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`);
  return done.stdout.toString().trim();
};

const release = (version: string) => {
  Bun.spawnSync(
    [
      "sh",
      "-c",
      `printf 'echo ran >> "$HOME/prepared"\\necho "prepare: runner: done"\\necho "prepare: skills: done"\\n' > prepare.sh; echo 'version = "${version}"' > herdr-plugin.toml`,
    ],
    { cwd: origin },
  );
  git(origin, "add", ".");
  git(origin, "commit", "--quiet", "-m", version);
  git(origin, "tag", version);
};

const read = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed(""))),
  );

/** An installer that leaves an executable named `name` in ~/.local/bin, as the real ones do. */
const installer = (name: string) =>
  `mkdir -p "$HOME/.local/bin"; printf '#!/bin/sh\\n' > "$HOME/.local/bin/${name}"; chmod +x "$HOME/.local/bin/${name}"`;

const READY: OpResult = { ok: true, data: { ready: true, checks: [] }, human: "ready" };

let doctorRan = 0;

/** onboard against this Machine, collecting what it streamed. */
const onboarded = (overrides: Record<string, string> = {}, to = "0.2.0") =>
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
      { to },
      (event) => Effect.sync(() => events.push(event)),
      () => Effect.sync(() => (doctorRan++, READY)),
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
      git(origin, "init", "--quiet", "-b", "master");
      release("0.1.0");
      release("0.2.0");
      bin = yield* FakeBin.make(`${home}/stubs`);
      yield* fs.writeFileString(`${home}/herdr-installer`, installer("herdr"));
      yield* fs.writeFileString(`${home}/claude-installer`, installer("claude"));
      yield* bin.add(
        "curl",
        `echo "$*" >> "${home}/curl-calls"
        case "$*" in
          *herdr.dev/install.sh*) cat "${home}/herdr-installer" ;;
          *claude.ai/install.sh*) cat "${home}/claude-installer" ;;
          *) exit 22 ;;
        esac`,
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
      expect(steps).toEqual(["system", "collie", "herdr", "claude", "path", "plugin", "doctor"]);
      for (const step of steps) {
        const start = events.findIndex((e) => e.event === "start" && e.step === step);
        const end = events.findIndex((e) => e.event === "result" && e.step === step);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(start).toBeLessThan(end);
      }
      expect(statusOf(events, "system")).toBe("in_place");
      expect(
        results(events)
          .filter((event) => event.step !== "system")
          .every((event) => event.status === "done"),
      ).toBe(true);
      expect(git(root, "describe", "--exact-match", "--tags", "HEAD")).toBe("0.2.0");
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
      git(home, "clone", "--quiet", "--branch", "0.1.0", origin, root);

      const { events } = yield* onboarded();

      expect(statusOf(events, "collie")).toBe("done");
      expect(git(root, "describe", "--exact-match", "--tags", "HEAD")).toBe("0.2.0");
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

test("a development checkout gets the checks, and nothing installed or moved", () =>
  runEffect(
    Effect.gen(function* () {
      git(home, "clone", "--quiet", origin, root);
      git(root, "checkout", "--quiet", "-b", "feature");
      const head = git(root, "rev-parse", "HEAD");

      const { result, events } = yield* onboarded({ HERDR_PLUGIN_ROOT: root });

      expect(result).toMatchObject({ ok: true, data: { ready: true, development: true } });
      expect(statusOf(events, "collie")).toBe("skipped");
      expect(results(events).map((event) => event.step)).toEqual(["system", "collie", "doctor"]);
      expect(git(root, "rev-parse", "HEAD")).toBe(head);
      expect(git(root, "symbolic-ref", "--short", "HEAD")).toBe("feature");
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
        { to: "0.2.0" },
        (event) => Effect.sync(() => events.push(event)),
        () => Effect.succeed(notReady),
      );

      expect(result).toMatchObject({ ok: false, error: { details: { ready: false } } });
      expect(results(events).at(-1)).toMatchObject({ step: "doctor", status: "failed" });
      expect(results(events).at(-1)?.detail).toContain("glab");
    }),
  ));
