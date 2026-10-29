import { expect, test } from "bun:test";
import { Config, Effect, FileSystem } from "effect";
import { inspect } from "node:util";
import { readConnectionLogin } from "../src/connection-login";
import { githubLogin, reuseGitlab } from "../desktop/src/bun/connection-reuse";
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
          commands.push(`${cmd} ${args.join(" ")}`);
          return { code: 0, stdout: args.includes("host") ? "gitlab.example.org" : secret };
        });
      const targets: ShellRoute[] = ["vm", "mini"].map((name) => ({
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

test("Give to vm reads gh's token and sends it only on stdin; no login offers the web flow", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Effect.acquireRelease(Rig.make(), (rig) => rig.close().pipe(Effect.orDie));
      const token = "ghp_fakefixture01234567890123456789";
      const commands: string[] = [];
      const run: Runner = (cmd, args) =>
        Effect.sync(() => {
          commands.push(`${cmd} ${args.join(" ")}`);
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
        commands.some((command) =>
          command.includes("gh auth login --hostname github.com --with-token"),
        ),
      ).toBe(true);
      expect(inputs).toEqual([`${token}\n`]);
      expect(inspect({ commands, result })).not.toContain(token);
      expect(result[0]!.failed).toContain("<redacted>");
      const card = connectionCards([
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
      ]).find((card) => card.id === "github")!;
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
