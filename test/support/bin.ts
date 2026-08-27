import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A dir of fake executables put in front of PATH for the current test. */
export class FakeBin {
  private readonly originalPath = process.env.PATH!;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    process.env.PATH = `${dir}:${this.originalPath}`;
  }

  /** `script` is sh; exit code and stdout are what the runner sees. */
  add(name: string, script: string): void {
    const path = join(this.dir, name);
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
  }

  restore(): void {
    process.env.PATH = this.originalPath;
  }
}
