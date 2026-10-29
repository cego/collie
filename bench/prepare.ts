// Run once per tree before its samples. Only Bun's own API here: a base tree has no
// node_modules until this installs them, and `read.ts` imports them.

for (const argv of [
  ["bun", "install", "--frozen-lockfile"],
  [process.execPath, "bench/read.ts", "prepare"],
]) {
  const ran = Bun.spawnSync(argv, { stdio: ["ignore", "inherit", "inherit"] });
  if (ran.exitCode !== 0) process.exit(ran.exitCode ?? 1);
}
