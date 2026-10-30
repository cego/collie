import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { probeGitlab, probeGithub, probeLinearMcp } from "../src/connection-probes";
import { ConnectionReading } from "../src/connection-model";
import { writeConfigValue } from "../src/config";
import { parseYaml } from "../src/yaml";
import { type Ran, type Runner } from "../src/mr";
import { Rig } from "./support/recorder";
import { runEffect } from "./support/effect";

test("GitLab is read on the host Collie works against, never glab's default, and identifies the token's user", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Effect.acquireRelease(Rig.make(), (rig) => rig.close().pipe(Effect.orDie));
      const fs = yield* FileSystem.FileSystem;
      const glab = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          host: Schema.String,
          hosts: Schema.Record(Schema.String, Schema.Struct({ token: Schema.String })),
        }),
      )(
        parseYaml(yield* fs.readFileString(`${import.meta.dir}/fixtures/connections/glab.yml`)),
      ).pipe(Effect.orDie);
      const asked: string[] = [];
      const run: Runner = (cmd, args) =>
        Effect.sync((): Ran => {
          const said = Arr.join(args, " ");
          asked.push(said);
          if (said === "config get host --global") return { code: 0, stdout: glab.host };
          const token = /^config get token --host (\S+)$/.exec(said);
          if (token !== null) return { code: 0, stdout: glab.hosts[token[1]!]?.token ?? "" };
          if (said === "api --hostname gitlab.cego.dk user")
            return { code: 0, stdout: '{"username":"mk"}' };
          if (
            cmd === "env" &&
            said === "GITLAB_HOST=gitlab.com glab api --hostname gitlab.com user"
          )
            return { code: 0, stdout: '{"username":"mk-on-gitlab-com"}' };
          throw new Error(`unexpected glab ${said}`);
        });
      expect(yield* probeGitlab(rig.pluginEnv(), run)).toEqual({
        state: "ok",
        account: "mk",
        detail: "gitlab.cego.dk as mk",
      });
      yield* writeConfigValue(rig.userDir, "gitlab_host", "gitlab.com");
      const configured = rig.pluginEnv({ GITLAB_TOKEN: "configured-fixture-token" });
      expect(yield* probeGitlab(configured, run)).toEqual({
        state: "ok",
        account: "mk-on-gitlab-com",
        detail: "gitlab.com as mk-on-gitlab-com",
      });
      expect(asked).toContain("GITLAB_HOST=gitlab.com glab api --hostname gitlab.com user");
      expect(
        yield* probeGitlab(configured, () =>
          Effect.succeed({ code: 1, stdout: "", stderr: "401 token refused" }),
        ),
      ).toEqual({
        state: "broken",
        detail: "gitlab.com did not accept its GitLab login",
        fix: "glab auth login --hostname gitlab.com",
      });
      yield* writeConfigValue(rig.userDir, "gitlab_host", null);
      expect(
        yield* probeGitlab(rig.pluginEnv(), () => Effect.succeed({ code: 127, stdout: "" })),
      ).toEqual({
        state: "absent",
        detail: "no GitLab login for gitlab.cego.dk",
        fix: "glab auth login --hostname gitlab.cego.dk",
      });
    }),
  ));

test("GitHub names the active gh account, distinguishes absent from invalid, and offers the login command", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Effect.acquireRelease(Rig.make(), (rig) => rig.close().pipe(Effect.orDie));
      const fs = yield* FileSystem.FileSystem;
      for (const [fixture, code, state] of [
        ["ok", 0, "ok"],
        ["absent", 1, "absent"],
        ["broken", 1, "broken"],
      ] as const) {
        const stderr = yield* fs.readFileString(
          `${import.meta.dir}/fixtures/connections/gh-auth-${fixture}.txt`,
        );
        const asked: string[] = [];
        const found = yield* probeGithub(rig.pluginEnv(), (cmd, args) => {
          asked.push(Arr.join([cmd, ...args], " "));
          return Effect.succeed({ code, stdout: "", stderr });
        });
        expect(asked).toEqual(["gh auth status --active --hostname github.com"]);
        expect(found.state).toBe(state);
        if (found.state === "ok") expect(found.account).toBe("mk");
        else expect(found.fix).toBe("gh auth login --hostname github.com --web");
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(ConnectionReading))(found).pipe(
            Effect.orDie,
          ),
        ).not.toContain("gho_");
      }
    }),
  ));

test("Linear is found in Claude, Codex and OpenCode configs; disabled and unreadable servers are not claimed available", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Effect.acquireRelease(Rig.make(), (rig) => rig.close().pipe(Effect.orDie));
      const fs = yield* FileSystem.FileSystem;
      const env = rig.pluginEnv();
      expect(yield* probeLinearMcp(env)).toMatchObject({
        state: "absent",
        fix: "claude mcp add --transport http --scope user linear-server https://mcp.linear.app/mcp",
      });
      for (const [fixture, target, account] of [
        ["codex.toml", `${env.home}/.codex/config.toml`, "tickets"],
        ["opencode.jsonc", `${env.home}/.config/opencode/opencode.jsonc`, "linear"],
      ] as const) {
        yield* fs.makeDirectory(
          pipe_(
            target,
            Str.slice(
              0,
              Option.getOrElse(pipe_(target, Str.lastIndexOf("/")), () => -1),
            ),
          ),
          { recursive: true },
        );
        yield* fs.copyFile(`${import.meta.dir}/fixtures/connections/${fixture}`, target);
        const found = yield* probeLinearMcp(env);
        expect(found).toMatchObject({ state: "ok", account });
        expect(found.detail).toContain(target);
        yield* fs.remove(target);
      }
      const file = `${env.home}/.claude.json`;
      yield* fs.writeFileString(
        file,
        '{"mcpServers":{"linear-server":{"url":"https://mcp.linear.app/mcp"}}}',
      );
      expect(yield* probeLinearMcp(env)).toMatchObject({ state: "ok", account: "linear-server" });
      yield* fs.writeFileString(file, "broken");
      expect(yield* probeLinearMcp(env)).toMatchObject({
        state: "broken",
        fix: `fix or remove ${file}`,
      });
      yield* fs.remove(file);
      yield* fs.writeFileString(
        `${env.home}/.codex/config.toml`,
        '[mcp_servers.linear]\nurl="https://mcp.linear.app/mcp"\nenabled=false\n',
      );
      expect((yield* probeLinearMcp(env)).state).toBe("absent");
    }),
  ));
