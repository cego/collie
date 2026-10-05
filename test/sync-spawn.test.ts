// A synchronous spawn can lose its child's exit and spin its process forever
// (oven-sh/bun#34069): a test worker that does it times out every test it has left.

import { expect, test } from "bun:test";

const root = new URL("../", import.meta.url).pathname;

test("nothing the suite runs spawns a process synchronously", async () => {
  const offenders: string[] = [];
  for (const file of new Bun.Glob("{src,test}/**/*.{ts,tsx}").scanSync({ cwd: root })) {
    const text = await Bun.file(`${root}${file}`).text();
    if (/\b(spawn|exec|execFile)Sync\(/.test(text)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
