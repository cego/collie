// Whether a Harness will work in a directory, or stop and ask first. Claude asks
// once per directory and remembers the answer in ~/.claude.json; this file is
// Claude's, so unreadable data is always left untouched.

import { Effect, FileSystem, Path, Schema, type PlatformError } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { isYamlMap, YamlMapSchema, type YamlMap } from "./yaml";
import { currentPid, withLock } from "./lock";

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
  /** Writing goes through the pid lock, which is what pulls in the spawner. */
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
  const real = yield* fs.realPath(cwd).pipe(Effect.catch(() => Effect.succeed(cwd)));
  return real === cwd ? [cwd] : [cwd, real];
});

function projects(config: YamlMap): YamlMap {
  return isYamlMap(config.projects) ? config.projects : {};
}

function trustedIn(config: YamlMap, cwds: ReadonlyArray<string>): boolean {
  const entries = projects(config);
  return cwds.some((path) => {
    const entry = entries[path];
    return isYamlMap(entry) && entry.hasTrustDialogAccepted === true;
  });
}

/** A grant is worth retrying while claude is writing, but not for ever. */
const GRANT_ATTEMPTS = 3;
const CHANGED = "changed" as const;

export function claudeTrust(home: string, backupDir: string): Trust {
  const configPath = `${home}/.claude.json`;

  /** The file as claude last wrote it, or null when it is not there or cannot be read. */
  const readRaw = Effect.fn("Trust.readRaw")(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(configPath))) return null;
    return yield* fs.readFileString(configPath).pipe(Effect.catch(() => Effect.succeed(null)));
  });

  /** Those same bytes and what they decode to, so a write can check them both. */
  const readConfig = Effect.fn("Trust.readConfig")(function* () {
    const raw = yield* readRaw();
    const config =
      raw === null
        ? null
        : yield* Schema.decodeUnknownEffect(ClaudeConfigJson)(raw).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
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

  /**
   * The lock keeps collie's own grants apart; claude takes no lock, so its writes are kept
   * by giving up rather than by excluding them. Each attempt is built on the bytes it just
   * read and lands only while those bytes are still the ones on disk, so a claude write in
   * that window costs this grant a retry instead of costing the user their configuration.
   */
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
    // The bytes this grant was built on, which are the ones a restore has to put back —
    // and no more readable than the file they came from, which holds claude's own secrets.
    yield* fs.writeFileString(backup, raw);
    yield* fs.chmod(backup, info.mode & 0o777);
    const tmp = `${configPath}.herdr-${yield* currentPid}`;
    yield* fs.writeFileString(tmp, `${Schema.encodeSync(ClaudeConfigJson)(config)}\n`);
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
