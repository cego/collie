import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Config, Effect, FileSystem } from "effect";
import { inspect } from "node:util";
import { readConnectionLogin } from "../src/connection-login";
import { probeGitlab } from "../src/connection-probes";
import { writeConfigValue } from "../src/config";
import { GITLAB_HOST } from "../src/gitlab-token";
import { githubLogin, readBack, reuseGitlab } from "../desktop/src/bun/connection-reuse";
import { onboardingSkips, ranWith } from "../desktop/src/bun/onboarding";
import { credentialsFile, giveToken, giveGithub } from "../desktop/src/bun/credentials";
import { connectionCards } from "../desktop/src/shared/connections";
import { givenCredentials } from "../desktop/src/bun/given";
import { localRoute, type ShellRoute } from "../desktop/src/bun/machine";
import type { MachineGiven } from "../desktop/src/shared/flock";
import type { Runner } from "../src/mr";
import { Rig } from "./support/recorder";
import { runEffect } from "./support/effect";

test("Use glab's login reads the source host and token, saves it, and hands it over without leaking failures", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Effect.acquireRelease(Rig.make(), (rig) => rig.close().pipe(Effect.orDie));
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-reuse-" });
      const secret = "a-short-opaque-token";
      const commands: string[] = [];
      const stdin: string[] = [];
      const events: MachineGiven[] = [];
      const run: Runner = (cmd, args) =>
        Effect.sync(() => {
          commands.push(`${cmd} ${Arr.join(args, " ")}`);
          return { code: 0, stdout: args.includes("host") ? "gitlab.example.org" : secret };
        });
      const targets: ShellRoute[] = Arr.map(["vm", "mini"], (name) => ({
        ...localRoute([], name),
        machine: { profile: `p-${name}`, name },
        execute: (script, bytes) =>
          Effect.sync(() => {
            commands.push(`${name}: ${script}`);
            stdin.push(new TextDecoder().decode(bytes));
            return name === "mini"
              ? { code: 1, out: "", err: `refused token ${secret}` }
              : { code: 0, out: "", err: "" };
          }),
      }));
      const keyring = credentialsFile(dir, `${dir}/no-secret-tool`);
      const given = yield* givenCredentials({
        dir,
        keyring,
        skipped: () => Effect.succeed([]),
        tell: (event) => Effect.sync(() => void events.push(event)),
        give: {
          gitlab: (route, token) =>
            giveToken([route], "gitlab.example.org", token).pipe(
              Effect.map((result) => result[0]!.failed),
            ),
          helle: () => Effect.succeed(null),
          slack: () => Effect.succeed(null),
        },
      });
      yield* writeConfigValue(rig.userDir, "gitlab_host", "gitlab.example.org");
      const hosts: string[] = [];
      const result = yield* reuseGitlab(
        readConnectionLogin(rig.pluginEnv(), "gitlab", run),
        (login) =>
          Effect.sync(() => {
            hosts.push(login.host);
          }),
        keyring,
        (token) => given.giveEvery(targets, "gitlab", token),
      );
      expect(hosts).toEqual(["gitlab.example.org"]);
      expect(yield* keyring.lookup("gitlab-token")).toBe(secret);
      expect(commands).toContain("glab config get token --host gitlab.example.org");
      expect(stdin).toEqual([`${secret}\n`, `${secret}\n`]);
      expect(result).toEqual([
        { name: "vm", failed: null },
        { name: "mini", failed: "refused token <redacted>" },
      ]);
      expect(inspect({ commands, events, result })).not.toContain(secret);
      expect(yield* fs.readFileString(`${dir}/given.json`)).not.toContain(secret);
    }),
  ));

/** A Machine's glab: the host it defaults to, and the token it holds for each host. */
const glabOn =
  (defaultHost: string, logins: Map<string, string>): Runner =>
  (_, args) =>
    Effect.sync(() => {
      const said = Arr.join(args, " ");
      if (said === "config get host --global") return { code: 0, stdout: defaultHost };
      const token = /^config get token --host (\S+)$/.exec(said);
      if (token !== null) return { code: 0, stdout: logins.get(token[1]!) ?? "" };
      const user = /^api --hostname (\S+) user$/.exec(said);
      if (user !== null)
        return logins.has(user[1]!)
          ? { code: 0, stdout: '{"username":"mk"}' }
          : { code: 1, stdout: "", stderr: "401" };
      throw new Error(`unexpected glab ${said}`);
    });

test("Use glab's login from the laptop reaches a VM whose glab defaults to gitlab.com, once it reconnects", () =>
  runEffect(
    Effect.gen(function* () {
      const laptop = yield* Effect.acquireRelease(Rig.make(), (rig) =>
        rig.close().pipe(Effect.orDie),
      );
      const vm = yield* Effect.acquireRelease(Rig.make(), (rig) => rig.close().pipe(Effect.orDie));
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-reuse-" });
      const keyring = credentialsFile(dir, `${dir}/no-secret-tool`);
      const secret = "laptop-fixture-token";
      const laptopRun = glabOn(GITLAB_HOST, new Map([[GITLAB_HOST, secret]]));
      const vmLogins = new Map<string, string>();
      const vmRun = glabOn("gitlab.com", vmLogins);
      expect(yield* readConnectionLogin(vm.pluginEnv(), "gitlab", vmRun).pipe(Effect.flip)).toBe(
        `No reusable gitlab login for ${GITLAB_HOST}; sign in on this Machine`,
      );
      let reachable = false;
      const vmRoute: ShellRoute = {
        ...localRoute([], "vm-mk"),
        machine: { profile: "p-vm", name: "vm-mk" },
        execute: (script, stdin) =>
          Effect.sync(() => {
            if (!reachable)
              return { code: 255, out: "", err: "ssh: connect to host vm-mk: refused" };
            const host = /glab auth login --hostname '?([^' ]+)'? --stdin/.exec(script)?.[1];
            if (host === undefined) return { code: 1, out: "", err: "not a glab login" };
            vmLogins.set(host, Str.trim(new TextDecoder().decode(stdin)));
            return { code: 0, out: "", err: "" };
          }),
      };
      // Desktop's own GitLab host while the Flock sets none.
      const desktop = givenCredentials({
        dir,
        keyring,
        skipped: () => Effect.succeed([]),
        tell: () => Effect.void,
        give: {
          gitlab: (route, token) =>
            giveToken([route], GITLAB_HOST, token).pipe(Effect.map((each) => each[0]!.failed)),
          helle: () => Effect.succeed(null),
          slack: () => Effect.succeed(null),
        },
      });
      const before = yield* desktop;
      const sources: string[] = [];
      const first = yield* reuseGitlab(
        readConnectionLogin(laptop.pluginEnv(), "gitlab", laptopRun),
        (login) => Effect.sync(() => void sources.push(login.host)),
        keyring,
        (token) => before.giveEvery([vmRoute], "gitlab", token),
      );
      expect(sources).toEqual([GITLAB_HOST]);
      expect(first[0]!.failed).not.toBeNull();
      expect((yield* probeGitlab(vm.pluginEnv(), vmRun)).state).toBe("absent");

      reachable = true;
      const restarted = yield* desktop;
      expect(yield* restarted.giveLacking(vmRoute)).toEqual([
        { credential: "gitlab", failed: null },
      ]);
      expect(yield* restarted.giveLacking(vmRoute)).toEqual([]);
      expect(yield* probeGitlab(vm.pluginEnv(), vmRun)).toEqual({
        state: "ok",
        account: "mk",
        detail: `${GITLAB_HOST} as mk`,
      });
      expect(yield* probeGitlab(laptop.pluginEnv(), laptopRun)).toMatchObject({ state: "ok" });
    }),
  ));

test("A Machine given the login that still reads without it is said not to have it", () =>
  runEffect(
    Effect.gen(function* () {
      const said = yield* readBack(
        [
          { name: "vm-mk", failed: null },
          { name: "mini", failed: "glab refused the login; check the token and host" },
          { name: "mac", failed: null },
          { name: "gone", failed: null },
        ],
        (name) =>
          name === "vm-mk"
            ? Effect.succeed({
                state: "absent" as const,
                detail: "no GitLab login for gitlab.com",
                fix: "glab auth login --hostname gitlab.com",
              })
            : name === "mac"
              ? Effect.succeed({
                  state: "ok" as const,
                  account: "mk",
                  detail: "gitlab.cego.dk as mk",
                })
              : Effect.fail("not connected"),
      );
      expect(said).toEqual([
        { name: "vm-mk", failed: "given, but it reads no GitLab login for gitlab.com" },
        { name: "mini", failed: "glab refused the login; check the token and host" },
        { name: "mac", failed: null },
        { name: "gone", failed: "given, but it could not be read back; refresh Connections" },
      ]);
    }),
  ));

test("Give to vm reads gh's token and sends it only on stdin; no login offers the web flow", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Effect.acquireRelease(Rig.make(), (rig) => rig.close().pipe(Effect.orDie));
      const token = "ghp_fakefixture01234567890123456789";
      const commands: string[] = [];
      const run: Runner = (cmd, args) =>
        Effect.sync(() => {
          commands.push(`${cmd} ${Arr.join(args, " ")}`);
          return { code: 0, stdout: token };
        });
      const login = yield* readConnectionLogin(rig.pluginEnv(), "github", run);
      const inputs: string[] = [];
      const target: ShellRoute = {
        ...localRoute([], "vm"),
        execute: (script, stdin) =>
          Effect.sync(() => {
            commands.push(script);
            inputs.push(new TextDecoder().decode(stdin));
            return { code: 1, out: token, err: "gh refused " };
          }),
      };
      const result = yield* giveGithub([target], login.token);
      expect(commands).toContain("gh auth token --hostname github.com");
      expect(
        Arr.some(commands, (command) =>
          pipe_(command, Str.includes("gh auth login --hostname github.com --with-token")),
        ),
      ).toBe(true);
      expect(inputs).toEqual([`${token}\n`]);
      expect(inspect({ commands, result })).not.toContain(token);
      expect(result[0]!.failed).toContain("<redacted>");
      const card = Option.getOrUndefined(
        Arr.findFirst(
          connectionCards([
            {
              profile: "p-vm",
              name: "vm",
              connections: [
                {
                  id: "github",
                  reading: { state: "absent", detail: "no login", fix: "gh auth login --web" },
                },
              ],
              workflows: [],
              problem: null,
            },
          ]),
          (card) => card.id === "github",
        ),
      )!;
      expect(card.primary).toMatchObject({ kind: "login", to: ["p-vm"] });
      const opened: ReadonlyArray<string>[] = [];
      const loginRoute = {
        ...target,
        sh: (script: string) => Effect.succeed(["ssh", "vm", script]),
      };
      yield* githubLogin(loginRoute, (command) =>
        Effect.sync(() => {
          opened.push(command);
          return true;
        }),
      );
      expect(opened).toEqual([["ssh", "vm", "gh auth login --hostname github.com --web"]]);
    }),
  ));

test("setting up Linear restores its skipped step without restoring Helle", () => {
  expect(
    onboardingSkips(
      [
        { step: "linear", status: "skipped", title: "Linear" },
        { step: "helle", status: "skipped", title: "Helle" },
      ],
      [],
      "linear",
    ),
  ).toEqual(["helle"]);
});

test("a failed token read refuses stdout instead of treating it as a credential", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Effect.acquireRelease(Rig.make(), (rig) => rig.close().pipe(Effect.orDie));
      const result = yield* readConnectionLogin(rig.pluginEnv(), "github", () =>
        Effect.succeed({ code: 1, stdout: "diagnostic-with-secret", stderr: "refused" }),
      ).pipe(Effect.flip);
      expect(result).toContain("No reusable github login");
      expect(result).not.toContain("diagnostic-with-secret");
    }),
  ));

test("login commands cannot echo stdin into the paired host's recorded shell result", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-login-output-" });
      for (const cli of ["gh", "glab"]) {
        yield* fs.writeFileString(`${dir}/${cli}`, "#!/bin/sh\ncat >&2\nexit 1\n", { mode: 0o755 });
      }
      const transport: unknown[] = [];
      const search = yield* Config.String("PATH");
      const route: ShellRoute = {
        ...localRoute([], "vm"),
        execute: (script, stdin) =>
          ranWith(["env", `PATH=${dir}:${search}`, "sh", "-c", script], stdin).pipe(
            Effect.tap((result) => Effect.sync(() => void transport.push(result))),
          ),
      };
      yield* giveToken([route], "gitlab.example", "tiny-opaque-secret");
      yield* giveGithub([route], "tiny-opaque-secret");
      expect(inspect(transport)).not.toContain("tiny-opaque-secret");
      expect(transport).toHaveLength(2);
    }),
  ));
