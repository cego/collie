import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { Cause, Config, ConfigProvider, Effect, FileSystem, Path, Semaphore } from "effect";

const buildingFixture = Semaphore.makeUnsafe(1);

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

export const gitWorktreeCases = (repo: string) =>
  `  "worktree list --porcelain") printf 'worktree %s\\nbranch refs/heads/master\\n' "${repo}" ;;
  "worktree add"*) mkdir -p "$3" && printf 'gitdir: %s/.gitdir\\n' "$3" > "$3/.git" ;;`;

export const loggedGit = (dir: string, log: string) =>
  Effect.gen(function* () {
    const real = Bun.which("git");
    const bin = yield* Effect.acquireRelease(FakeBin.make(dir), (bin) => bin.restore());
    yield* bin.add("git", `echo "$*" >> "${log}"\nexec "${real}" "$@"`);
    return yield* Effect.succeed(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(log)).pipe(
        Effect.map((text) => Arr.filter(Str.split(text, "\n"), (line) => line !== "")),
        Effect.orElseSucceed(() => []),
      ),
    );
  });

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

  // WARNING: Write a fresh file and rename it over the old: Linux refuses to write a running executable (ETXTBSY).
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

  private writes = 0;

  restore() {
    return Effect.sync(() => {
      Bun.env.PATH = this.originalPath;
    });
  }
}
