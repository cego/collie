import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { probeGitlab, probeGithub, probeLinearMcp } from "../src/connection-probes";
import { ConnectionReading } from "../src/connection-model";
import { writeConfigValue } from "../src/config";
import { parseYaml } from "../src/yaml";
import { type Ran, type Runner } from "../src/mr";
import { Rig } from "./support/recorder";
import { runEffect } from "./support/effect";

test("GitLab uses glab's configured host or Collie's explicit host, and identifies the token's user", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Effect.acquireRelease(Rig.make(), (rig) => rig.close().pipe(Effect.orDie));
      const fs = yield* FileSystem.FileSystem;
      const config = Schema.decodeUnknownSync(Schema.Struct({ host: Schema.String }))(
        parseYaml(yield* fs.readFileString(`${import.meta.dir}/fixtures/connections/glab.yml`)),
      );
      const asked: string[] = [];
      const run: Runner = (cmd, args) =>
        Effect.sync((): Ran => {
          asked.push(args.join(" "));
          if (args.join(" ") === "config get host --global")
            return { code: 0, stdout: config.host };
          if (args[0] === "config") return { code: 0, stdout: "fixture-token" };
          if (args.join(" ") === "api --hostname gitlab.example user")
            return { code: 0, stdout: '{"username":"mk"}' };
          if (
            cmd === "env" &&
            args.join(" ") === "GITLAB_HOST=other.example glab api --hostname other.example user"
          )
            return { code: 0, stdout: '{"username":"other-mk"}' };
          throw new Error(`unexpected glab ${args.join(" ")}`);
        });
      expect(yield* probeGitlab(rig.pluginEnv(), run)).toEqual({
        state: "ok",
        account: "mk",
        detail: "gitlab.example as mk",
      });
      yield* writeConfigValue(rig.userDir, "gitlab_host", "other.example");
      const configured = rig.pluginEnv({ GITLAB_TOKEN: "configured-fixture-token" });
      expect(yield* probeGitlab(configured, run)).toEqual({
        state: "ok",
        account: "other-mk",
        detail: "other.example as other-mk",
      });
      expect(asked).toContain("GITLAB_HOST=other.example glab api --hostname other.example user");
      expect(
        yield* probeGitlab(configured, () =>
          Effect.succeed({ code: 1, stdout: "", stderr: "401 token refused" }),
        ),
      ).toEqual({
        state: "broken",
        detail: "other.example did not accept its GitLab login",
        fix: "glab auth login --hostname other.example",
      });
      yield* writeConfigValue(rig.userDir, "gitlab_host", null);
      expect(
        yield* probeGitlab(rig.pluginEnv(), () => Effect.succeed({ code: 127, stdout: "" })),
      ).toMatchObject({ state: "absent", fix: "glab auth login --hostname gitlab.com" });
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
          asked.push([cmd, ...args].join(" "));
          return Effect.succeed({ code, stdout: "", stderr });
        });
        expect(asked).toEqual(["gh auth status --active --hostname github.com"]);
        expect(found.state).toBe(state);
        if (found.state === "ok") expect(found.account).toBe("mk");
        else expect(found.fix).toBe("gh auth login --hostname github.com --web");
        expect(Schema.encodeSync(Schema.fromJsonString(ConnectionReading))(found)).not.toContain(
          "gho_",
        );
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
        yield* fs.makeDirectory(target.slice(0, target.lastIndexOf("/")), { recursive: true });
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
