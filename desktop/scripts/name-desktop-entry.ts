// Pinned Hutch runs hooks in Cottontail, which cannot parse Effect's modules.
const entry = Bun.spawnSync(
  ["bun", new URL("./bun/name-desktop-entry.ts", import.meta.url).pathname],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);
if (entry.exitCode !== 0) process.exit(entry.exitCode);
