// Whether a Harness will work in a directory, or stop and ask first. Claude asks
// once per directory and remembers the answer in ~/.claude.json; this file is
// Claude's, so unreadable data is always left untouched.

import { Effect, FileSystem, Path, Schema, type PlatformError } from "effect";
import { isYamlMap, YamlMapSchema, type YamlMap } from "./yaml";

export type TrustState = "trusted" | "untrusted" | "unknown";

export interface TrustResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface Trust {
  /** `unknown` when the harness has left nothing here to read. */
  readonly state: (
    cwd: string,
  ) => Effect.Effect<TrustState, PlatformError.PlatformError, FileSystem.FileSystem>;
  readonly grant: (
    cwd: string,
  ) => Effect.Effect<TrustResult, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>;
}

const ClaudeConfigJson = Schema.fromJsonString(YamlMapSchema);

const paths = Effect.fn("Trust.paths")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const real = yield* fs.realPath(cwd).pipe(Effect.catch(() => Effect.succeed(cwd)));
  return real === cwd ? [cwd] : [cwd, real];
});

function projects(config: YamlMap): YamlMap {
  return isYamlMap(config.projects) ? config.projects : {};
}

export function claudeTrust(home: string, backupDir: string): Trust {
  const read = Effect.fn("Trust.read")(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = `${home}/.claude.json`;
    if (!(yield* fs.exists(path))) return null;
    return yield* fs.readFileString(path).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ClaudeConfigJson)),
      Effect.catch(() => Effect.succeed(null)),
    );
  });

  const state = Effect.fn("Trust.state")(function* (cwd: string) {
    const config = yield* read();
    if (config === null) return "unknown" as const;
    const entries = projects(config);
    for (const path of yield* paths(cwd)) {
      const entry = entries[path];
      if (isYamlMap(entry) && entry.hasTrustDialogAccepted === true) return "trusted" as const;
    }
    return "untrusted" as const;
  });

  const grant = Effect.fn("Trust.grant")(function* (cwd: string) {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const path = pathService.join(home, ".claude.json");
    const config = yield* read();
    if (config === null) {
      return {
        ok: false,
        message: (yield* fs.exists(path))
          ? `${path} is not readable JSON; left alone`
          : "claude has not run on this machine yet, so it will ask you the first time",
      };
    }
    if ((yield* state(cwd)) === "trusted") {
      return { ok: true, message: `${cwd} is already trusted` };
    }

    const entries = projects(config);
    config.projects = entries;
    for (const projectPath of yield* paths(cwd)) {
      const current = entries[projectPath];
      const updated: YamlMap = { mcpServers: {} };
      if (isYamlMap(current)) Object.assign(updated, current);
      updated.hasTrustDialogAccepted = true;
      entries[projectPath] = updated;
    }

    const backup = pathService.join(backupDir, "claude.json.bak");
    yield* fs.copyFile(path, backup);
    const tmp = `${path}.herdr-${globalThis.process.pid}`;
    yield* fs.writeFileString(tmp, `${Schema.encodeSync(ClaudeConfigJson)(config)}\n`);
    const info = yield* fs.stat(path);
    yield* fs.chmod(tmp, info.mode & 0o777);
    yield* fs.rename(tmp, path);

    if ((yield* state(cwd)) !== "trusted") {
      yield* fs.copyFile(backup, path);
      return { ok: false, message: `could not record trust for ${cwd}; ${path} restored` };
    }
    return {
      ok: true,
      message: `trusted ${cwd} for claude (previous config saved to ${backup})`,
    };
  });

  return { state, grant };
}
