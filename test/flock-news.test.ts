// The Flock chat hears every Herd's News on every Machine as one batch: what matters most
// first, then by time, a screen's worth, and what it left out said per Machine.

import { expect, test } from "bun:test";
import { BATCH } from "../src/news";
import { flockBatch, flockNewsText, wakes } from "../desktop/src/bun/flock-tools";

const item = (
  key: string,
  significance: "routine" | "try-it" | "decision" | "consequential",
  at: string,
) => ({
  key,
  run: key.split(":")[0]!,
  text: `${key} happened.`,
  at,
  significance,
});

test("every Herd on every Machine is one batch, what matters most first and then by time", () => {
  const batch = flockBatch([
    {
      machine: "mk-pc",
      herd: "h1",
      items: [
        item("r1:ended", "consequential", "2026-10-05T10:00:00Z"),
        item("r2:ready", "try-it", "2026-10-05T09:00:00Z"),
      ],
    },
    {
      machine: "vm-mk",
      herd: "h1",
      items: [item("r3:asking", "decision", "2026-10-05T11:00:00Z")],
    },
    {
      machine: "vm-mk",
      herd: "h2",
      items: [item("r4:ended", "consequential", "2026-10-05T08:00:00Z")],
    },
  ]);
  expect(batch.items.map(({ machine, item }) => `${machine}:${item.key}`)).toEqual([
    "vm-mk:r3:asking",
    "vm-mk:r4:ended",
    "mk-pc:r1:ended",
    "mk-pc:r2:ready",
  ]);
  expect(flockNewsText(batch)).toContain("- [decision] vm-mk:r3: r3:asking happened.");
});

test("a batch is a screen's worth, and says per Machine what it left out", () => {
  const many = Array.from({ length: BATCH + 7 }, (_, n) =>
    item(`r${n}:ended`, "routine", `2026-10-05T10:${String(n).padStart(2, "0")}:00Z`),
  );
  const batch = flockBatch([
    {
      machine: "mk-pc",
      herd: "h1",
      items: [item("rx:asking", "decision", "2026-10-01T00:00:00Z")],
    },
    { machine: "vm-mk", herd: "h1", items: many },
  ]);
  expect(batch.items).toHaveLength(BATCH);
  expect(batch.items[0]!.item.key).toBe("rx:asking");
  expect(flockNewsText(batch)).toContain("and 8 older or less pressing items on vm-mk");
  expect(flockNewsText(batch)).not.toContain("on mk-pc");
});

test("only a decision or a consequential item is worth speaking first about", () => {
  expect(
    wakes(
      flockBatch([
        { machine: "m", herd: "h", items: [item("a", "try-it", "t"), item("b", "routine", "t")] },
      ]),
    ),
  ).toBe(false);
  expect(
    wakes(flockBatch([{ machine: "m", herd: "h", items: [item("a", "consequential", "t")] }])),
  ).toBe(true);
  expect(
    wakes(flockBatch([{ machine: "m", herd: "h", items: [item("a", "decision", "t")] }])),
  ).toBe(true);
});
