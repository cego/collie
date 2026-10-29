// Whether this Machine is Short of memory, read from its own sources
// (ADR-draft-new-work-waits-while-its-machine-is-short-of-memory, D1).

import * as Rec from "effect/Record";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { FakeBin } from "./support/bin";
import { linuxMemory, macMemory, shortOfMemory, type Memory } from "../src/memory";
import { shell } from "../src/mr";

const GiB = 1024 ** 3;
const known = (available: number, total: number, pressure: number | null = null): Memory => ({
  known: true,
  available,
  total,
  pressure,
});

test("short under the share of total memory_hold sets, and not exactly at it", () => {
  expect(shortOfMemory(known(9.9 * GiB, 100 * GiB), 10)).toBe(true);
  expect(shortOfMemory(known(10 * GiB, 100 * GiB), 10)).toBe(false);
});

test("pressure of 10 or more is short whatever is available", () => {
  expect(shortOfMemory(known(50 * GiB, 100 * GiB, 10), 10)).toBe(true);
  expect(shortOfMemory(known(50 * GiB, 100 * GiB, 9.99), 10)).toBe(false);
});

test("memory_hold 0 is never short, the pressure rule included", () => {
  expect(shortOfMemory(known(0, 100 * GiB, 90), 0)).toBe(false);
});

test("an unknown reading is not short", () => {
  expect(shortOfMemory({ known: false, from: "/proc/meminfo" }, 10)).toBe(false);
});

let dir: string;
let bin: FakeBin;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      dir = yield* fs.makeTempDirectory({ prefix: "collie-memory-" });
      bin = yield* FakeBin.make(`${dir}/bin`);
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.restore();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(dir, { recursive: true });
    }),
  ),
);

const proc = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${dir}/proc/pressure`, { recursive: true });
    for (const [name, text] of Rec.toEntries(files))
      yield* fs.writeFileString(`${dir}/proc/${name}`, text);
    return `${dir}/proc`;
  });

const MEMINFO =
  "MemTotal:       65000000 kB\nMemFree:         1000000 kB\nMemAvailable:    8000000 kB\nBuffers:          100 kB\n";

test("Linux reads MemAvailable, MemTotal and the full avg10 of memory pressure", () =>
  runEffect(
    Effect.gen(function* () {
      const root = yield* proc({
        meminfo: MEMINFO,
        "pressure/memory":
          "some avg10=12.50 avg60=3.00 avg300=1.00 total=100\nfull avg10=4.25 avg60=1.00 avg300=0.50 total=50\n",
      });
      expect(yield* linuxMemory(root)).toEqual(known(8000000 * 1024, 65000000 * 1024, 4.25));
    }),
  ));

test("a Linux kernel without pressure information is read by memory alone", () =>
  runEffect(
    Effect.gen(function* () {
      const root = yield* proc({ meminfo: MEMINFO });
      expect(yield* linuxMemory(root)).toEqual(known(8000000 * 1024, 65000000 * 1024));
    }),
  ));

test("a meminfo that is missing or unparsable is unknown, naming it", () =>
  runEffect(
    Effect.gen(function* () {
      const missing = `${dir}/nowhere`;
      expect(yield* linuxMemory(missing)).toEqual({ known: false, from: `${missing}/meminfo` });
      const root = yield* proc({ meminfo: "MemTotal: 0 kB\n" });
      expect(yield* linuxMemory(root)).toEqual({ known: false, from: `${root}/meminfo` });
    }),
  ));

const sysctl = (level: string, memsize: string) =>
  bin.add(
    "sysctl",
    `case "$*" in "-n kern.memorystatus_level") echo ${level} ;; "-n hw.memsize") echo ${memsize} ;; *) exit 1 ;; esac`,
  );

test("macOS reads the share available and the total from sysctl, with no pressure", () =>
  runEffect(
    Effect.gen(function* () {
      yield* sysctl("13", String(64 * GiB));
      expect(yield* macMemory(shell)).toEqual(known((64 * GiB * 13) / 100, 64 * GiB));
    }),
  ));

test("a sysctl that fails or says nothing usable is unknown", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("sysctl", "exit 1");
      expect(yield* macMemory(shell)).toEqual({ known: false, from: "sysctl" });
      yield* sysctl("lots", String(64 * GiB));
      expect(yield* macMemory(shell)).toEqual({ known: false, from: "sysctl" });
    }),
  ));
