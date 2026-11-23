/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/global-console -- prepares an offline benchmark's copy, never a host's live state. */
// WARNING: opened once, so a tree that imports records has done so before any sample.
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const [snapshot, views] = Bun.argv.slice(2);
if (snapshot === undefined || views === undefined) {
  console.error("usage: bun bench/board-reads/prepare.ts <snapshot> <views.json>");
  process.exit(2);
}
const root = new URL("../../", import.meta.url).pathname;
const work = `${root}.scratch/board-reads`;
const run = (argv: ReadonlyArray<string>) => {
  const ran = Bun.spawnSync([...argv], {
    cwd: root,
    env: { ...Bun.env, COLLIE_HOST: "/bin/false" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (ran.exitCode !== 0) {
    process.exit(ran.exitCode ?? 1);
  }
};

if (!existsSync(`${root}node_modules/effect/package.json`)) {
  run(["bun", "install", "--frozen-lockfile"]);
}
if (existsSync(work)) {
  rmSync(work, { recursive: true });
}
mkdirSync(`${work}/bin`, { recursive: true });
mkdirSync(`${work}/home`, { recursive: true });
const git = Bun.which("git");
if (git === null) {
  process.exit(1);
}
writeFileSync(
  `${work}/bin/git`,
  `#!/bin/sh
sub=
skip=
for arg in "$@"; do
  if [ -n "$skip" ]; then skip=; continue; fi
  case "$arg" in
    -C|-c|--git-dir|--work-tree) skip=1 ;;
    -*) ;;
    *) sub="$arg"; break ;;
  esac
done
case "$sub" in
  rev-parse|log|show|cat-file|merge-base|for-each-ref|ls-files|rev-list|diff|show-ref|describe|ls-tree) ;;
  *) echo "board-reads: git $sub refused" >&2; exit 1 ;;
esac
GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 exec ${git} "$@"
`,
);
chmodSync(`${work}/bin/git`, 0o755);
for (const tool of ["gh", "glab", "herdr", "hc", "collie", "claude", "codex", "opencode", "pi"]) {
  writeFileSync(
    `${work}/bin/${tool}`,
    `#!/bin/sh\necho "board-reads: ${tool} refused" >&2\nexit 1\n`,
  );
  chmodSync(`${work}/bin/${tool}`, 0o755);
}
// WARNING: cp -a keeps modification times, which a build before Run records reads.
run(["cp", "-a", snapshot, `${work}/state`]);
cpSync(views, `${work}/views.json`);
run(["bun", "bench/board-reads/run.ts", "--open"]);
