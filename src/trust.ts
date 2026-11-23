// WARNING: claude's config is not ours: unreadable data is always left untouched.
import * as Arr from "effect/Array";
import { Effect, FileSystem, Path, Schema, type PlatformError } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { isYamlMap, YamlMapSchema, type YamlMap } from "./yaml";
import { currentPid, withLock } from "./lock";

export type TrustState = "trusted" | "untrusted" | "unknown";

export interface TrustResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface Trust {
  readonly state: (
    cwd: string,
  ) => Effect.Effect<TrustState, PlatformError.PlatformError, FileSystem.FileSystem>;
  readonly grant: (
    cwd: string,
  ) => Effect.Effect<
    TrustResult,
    PlatformError.PlatformError | Schema.SchemaError,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >;
}

const ClaudeConfigJson = Schema.fromJsonString(YamlMapSchema);

const paths = Effect.fn("Trust.paths")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const real = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
  return real === cwd ? [cwd] : [cwd, real];
});

function projects(config: YamlMap) {
  return isYamlMap(config.projects) ? config.projects : {};
}

function trustedIn(config: YamlMap, cwds: ReadonlyArray<string>) {
  const entries = projects(config);
  return Arr.some(cwds, (path) => {
    const entry = entries[path];
    return isYamlMap(entry) && entry.hasTrustDialogAccepted === true;
  });
}

const GRANT_ATTEMPTS = 3;
const CHANGED = "changed" as const;

export function claudeTrust(home: string, backupDir: string) {
  const configPath = `${home}/.claude.json`;

  const readRaw = Effect.fn("Trust.readRaw")(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(configPath))) return null;
    return yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => null));
  });

  const readConfig = Effect.fn("Trust.readConfig")(function* () {
    const raw = yield* readRaw();
    const config =
      raw === null
        ? null
        : yield* Schema.decodeEffect(ClaudeConfigJson)(raw).pipe(Effect.orElseSucceed(() => null));
    return { raw, config };
  });

  const state = Effect.fn("Trust.state")(function* (cwd: string) {
    const { config } = yield* readConfig();
    if (config === null) return "unknown" as const;
    return trustedIn(config, yield* paths(cwd)) ? ("trusted" as const) : ("untrusted" as const);
  });

  const grant = Effect.fn("Trust.grant")(function* (cwd: string) {
    const lock = `${configPath}.herdr-lock`;
    return yield* withLock(
      lock,
      Effect.succeed({ ok: false, message: `${lock} is held by another collie; nothing written` }),
      writeGrant(cwd),
    );
  });

  // WARNING: claude takes no lock, so each attempt lands only while the bytes it read are still on disk.
  const writeGrant = Effect.fn("Trust.writeGrant")(function* (cwd: string) {
    for (let attempt = 0; attempt < GRANT_ATTEMPTS; attempt++) {
      const result = yield* tryGrant(cwd);
      if (result !== CHANGED) return result;
    }
    return { ok: false, message: `${configPath} kept changing under the grant; nothing written` };
  });

  const tryGrant = Effect.fn("Trust.tryGrant")(function* (cwd: string) {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const { raw, config } = yield* readConfig();
    if (raw === null || config === null) {
      return {
        ok: false,
        message:
          raw === null
            ? "claude has not run on this machine yet, so it will ask you the first time"
            : `${configPath} is not readable JSON; left alone`,
      };
    }
    const cwds = yield* paths(cwd);
    if (trustedIn(config, cwds)) return { ok: true, message: `${cwd} is already trusted` };

    const entries = projects(config);
    config.projects = entries;
    for (const projectPath of cwds) {
      const current = entries[projectPath];
      const updated: YamlMap = { mcpServers: {} };
      if (isYamlMap(current)) Object.assign(updated, current);
      updated.hasTrustDialogAccepted = true;
      entries[projectPath] = updated;
    }

    const info = yield* fs.stat(configPath);
    const backup = pathService.join(backupDir, "claude.json.bak");
    // WARNING: the backup holds claude's secrets, so it is no more readable than the original.
    yield* fs.writeFileString(backup, raw);
    yield* fs.chmod(backup, info.mode & 0o777);
    const tmp = `${configPath}.herdr-${yield* currentPid}`;
    yield* fs.writeFileString(
      tmp,
      `${yield* Schema.encodeEffect(ClaudeConfigJson)(config).pipe(Effect.orDie)}\n`,
    );
    yield* fs.chmod(tmp, info.mode & 0o777);
    if ((yield* readRaw()) !== raw) {
      yield* fs.remove(tmp, { force: true });
      return CHANGED;
    }
    yield* fs.rename(tmp, configPath);

    if ((yield* state(cwd)) !== "trusted") {
      yield* fs.copyFile(backup, configPath);
      return { ok: false, message: `could not record trust for ${cwd}; ${configPath} restored` };
    }
    return {
      ok: true,
      message: `trusted ${cwd} for claude (previous config saved to ${backup})`,
    };
  });

  return { state, grant };
}
