import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { Cause, Config, ConfigProvider, Effect, FileSystem, Path, Semaphore } from "effect";

const buildingFixture = Semaphore.makeUnsafe(1);

/** Repeated protocol clients must start within the same budget as the native executables. */
export const fixtureBinary = (kind: "ssh" | "codex") =>
  Effect.suspend(() =>
    buildingFixture.withPermits(1)(
      Effect.gen(function* () {
        const provided = yield* Config.String(
          kind === "ssh" ? "COLLIE_TEST_FAKE_SSH" : "COLLIE_TEST_CODEX_SERVER",
        ).pipe(Config.withDefault(""));
        if (provided !== "") return provided;
        const home = yield* Config.String("HOME");
        const fs = yield* FileSystem.FileSystem;
        const file = `${home}/collie-fixtures/${kind}`;
        if (yield* fs.exists(file)) return file;
        yield* fs.makeDirectory(`${home}/collie-fixtures`, { recursive: true });
        const built = yield* Effect.promise(() =>
          Bun.build({
            entrypoints: [
              `${import.meta.dir}/${kind === "ssh" ? "fake-ssh-main" : "codex-server"}.ts`,
            ],
            target: "bun",
            bytecode: true,
            format: "esm",
            compile: { outfile: file },
          }),
        );
        if (!built.success)
          return yield* new Cause.UnknownError(
            built.logs,
            `Could not build the ${kind} protocol fixture`,
          );
        return file;
      }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv())),
    ),
  );

/**
 * The `case` arms a fake git needs before a mutating run can be given a checkout:
 * `worktree list --porcelain` names the repository, and `worktree add` really makes the
 * directory and the `.git` file git writes there — which is a checkout's identity.
 */
export const gitWorktreeCases = (repo: string) =>
  `  "worktree list --porcelain") printf 'worktree %s\\nbranch refs/heads/master\\n' "${repo}" ;;
  "worktree add"*) mkdir -p "$3" && printf 'gitdir: %s/.gitdir\\n' "$3" > "$3/.git" ;;`;

/** A git in `dir`, first on PATH while the scope lasts, that logs each start's arguments. */
export const loggedGit = (dir: string, log: string) =>
  Effect.gen(function* () {
    const real = Bun.which("git");
    const bin = yield* Effect.acquireRelease(FakeBin.make(dir), (bin) => bin.restore());
    yield* bin.add("git", `echo "$*" >> "${log}"\nexec "${real}" "$@"`);
    return yield* Effect.succeed(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(log)).pipe(
        Effect.map((text) => Arr.filter(Str.split(text, "\n"), (line) => line !== "")),
        Effect.orElseSucceed((): string[] => []),
      ),
    );
  });

/** A dir of fake executables put in front of PATH for the current test. */
export class FakeBin {
  private constructor(
    readonly dir: string,
    private readonly originalPath: string,
  ) {}

  static make(dir: string) {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const originalPath = yield* Config.String("PATH").pipe(Config.withDefault(""));
      yield* fs.makeDirectory(dir, { recursive: true });
      Bun.env.PATH = `${dir}:${originalPath}`;
      return new FakeBin(dir, originalPath);
    });
  }

  /**
   * `script` is sh; exit code and stdout are what the runner sees.
   *
   * Written to a fresh file and renamed over the old one, never written in place: Linux
   * refuses to open a running executable for writing, so a test that replaced a stub
   * while a previous copy of it was still executing failed with ETXTBSY. A rename
   * replaces the name without touching the file the running process holds open.
   */
  add(name: string, script: string) {
    return Effect.gen(
      function* (this: FakeBin) {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(this.dir, name);
        const staged = `${file}.${process.pid}.${++this.writes}.tmp`;
        yield* fs.writeFileString(staged, `#!/bin/sh\n${script}\n`);
        yield* fs.chmod(staged, 0o755);
        yield* fs.rename(staged, file);
      }.bind(this),
    );
  }

  /** Makes each staged name its own, so two writes in one process cannot collide. */
  private writes = 0;

  restore() {
    return Effect.sync(() => {
      Bun.env.PATH = this.originalPath;
    });
  }
}
