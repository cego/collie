// Pinned Hutch runs hooks in Cottontail, which cannot parse Effect's modules.
const icons = Bun.spawnSync(["bun", new URL("./bun/mac-icons.ts", import.meta.url).pathname], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
if (icons.exitCode !== 0) process.exit(icons.exitCode);
