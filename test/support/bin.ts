import { Config, Effect, FileSystem, Path } from "effect";

/**
 * The `case` arms a fake git needs before a mutating run can be given a checkout:
 * `worktree list --porcelain` names the repository, and `worktree add` really makes the
 * directory and the `.git` file git writes there — which is a checkout's identity.
 */
export const gitWorktreeCases = (repo: string) =>
  `  "worktree list --porcelain") printf 'worktree %s\\nbranch refs/heads/master\\n' "${repo}" ;;
  "worktree add"*) mkdir -p "$3" && printf 'gitdir: %s/.gitdir\\n' "$3" > "$3/.git" ;;`;

/** A dir of fake executables put in front of PATH for the current test. */
export class FakeBin {
  private constructor(
    readonly dir: string,
    private readonly originalPath: string,
  ) {}

  static make(dir: string) {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const originalPath = yield* Config.string("PATH").pipe(Config.withDefault(""));
      yield* fs.makeDirectory(dir, { recursive: true });
      Bun.env.PATH = `${dir}:${originalPath}`;
      return new FakeBin(dir, originalPath);
    });
  }

  /** `script` is sh; exit code and stdout are what the runner sees. */
  add(name: string, script: string) {
    return Effect.gen(
      function* (this: FakeBin) {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(this.dir, name);
        yield* fs.writeFileString(file, `#!/bin/sh\n${script}\n`);
        yield* fs.chmod(file, 0o755);
      }.bind(this),
    );
  }

  restore() {
    return Effect.sync(() => {
      Bun.env.PATH = this.originalPath;
    });
  }
}
