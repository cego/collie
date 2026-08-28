// Whether a Harness will work in a directory, or stop and ask first. claude asks
// once per directory and remembers the answer in ~/.claude.json; there is no
// command for it, so this writes the key it looks for — carefully, because that
// file is claude's, not ours, and it holds far more than this.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type TrustState = "trusted" | "untrusted" | "unknown";

export interface Trust {
  /** `unknown` when the harness has left nothing here to read. */
  state(cwd: string): TrustState;
  grant(cwd: string): { ok: boolean; message: string };
}

interface ClaudeConfig {
  projects?: Record<string, Record<string, unknown>>;
}

/** Both spellings of one directory: claude records whichever it was started with. */
function paths(cwd: string): string[] {
  try {
    const real = realpathSync(cwd);
    return real === cwd ? [cwd] : [cwd, real];
  } catch {
    return [cwd];
  }
}

export function claudeTrust(home: string, backupDir: string): Trust {
  const path = join(home, ".claude.json");

  const read = (): ClaudeConfig | null => {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as ClaudeConfig;
    } catch {
      // Not ours to repair, and certainly not ours to overwrite.
      return null;
    }
  };

  return {
    state(cwd) {
      const config = read();
      if (!config) return "unknown";
      const projects = config.projects ?? {};
      return paths(cwd).some((p) => projects[p]?.hasTrustDialogAccepted === true)
        ? "trusted"
        : "untrusted";
    },

    grant(cwd) {
      const config = read();
      if (!config) {
        return {
          ok: false,
          message: existsSync(path)
            ? `${path} is not readable JSON; left alone`
            : `claude has not run on this machine yet, so it will ask you the first time`,
        };
      }
      if (this.state(cwd) === "trusted") return { ok: true, message: `${cwd} is already trusted` };

      const projects = (config.projects ??= {});
      for (const p of paths(cwd)) {
        // `mcpServers` is the one field every entry claude writes has.
        projects[p] = { mcpServers: {}, ...(projects[p] ?? {}), hasTrustDialogAccepted: true };
      }

      const backup = join(backupDir, "claude.json.bak");
      copyFileSync(path, backup);
      // Rename so a reader never sees a half-written config — and carry the original
      // mode over with it, because a rename replaces the file, permissions and all.
      const tmp = `${path}.herdr-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
      chmodSync(tmp, statSync(path).mode & 0o777);
      renameSync(tmp, path);

      if (this.state(cwd) !== "trusted") {
        copyFileSync(backup, path);
        return { ok: false, message: `could not record trust for ${cwd}; ${path} restored` };
      }
      return { ok: true, message: `trusted ${cwd} for claude (previous config saved to ${backup})` };
    },
  };
}
