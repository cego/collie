// Whether each Machine is In sync with Desktop (CONTEXT.md), and the Flock's line about it.

import { type MachineRow, type NotLive, type OnboardStep, SETTLED } from "./flock";

/** What a Machine lags on, in words, with the steps that fix onboarding. */
export interface Lag {
  readonly part: "version" | "onboarding";
  readonly said: string;
  readonly steps: ReadonlyArray<OnboardStep>;
}

export interface InSync {
  readonly state: "in-sync" | "behind" | "connecting" | NotLive;
  readonly behind: ReadonlyArray<Lag>;
}

/** What Desktop gives its Flock. */
export interface DesktopHolds {
  readonly version: string;
}

export const NOT_LIVE_SAID = {
  unreachable: "Out of reach",
  sso: "Waiting for SSO",
  "no-collie": "Collie isn't installed",
  "update-desktop": "Update Desktop",
} satisfies Record<NotLive, string>;

const RELEASE = /^\d+\.\d+\.\d+$/;

const older = (build: string, than: string) => {
  const [a, b] = [build, than].map((version) => version.split(".").map(Number));
  const at = a!.findIndex((part, i) => part !== b![i]);
  return at !== -1 && a![at]! < b![at]!;
};

const lags = (row: MachineRow, desktop: DesktopHolds): ReadonlyArray<Lag> => {
  const { build, development, onboarded } = row;
  const version: ReadonlyArray<Lag> =
    build !== null &&
    development === null &&
    RELEASE.test(build) &&
    RELEASE.test(desktop.version) &&
    older(build, desktop.version)
      ? [
          {
            part: "version",
            said: `Runs Collie ${build}; Desktop is ${desktop.version}`,
            steps: [],
          },
        ]
      : [];
  const missing = onboarded?.steps.filter(({ status }) => !SETTLED.includes(status)) ?? [];
  const onboarding: ReadonlyArray<Lag> =
    onboarded?.ready === false
      ? [
          {
            part: "onboarding",
            said: `Not onboarded: ${missing.map(({ title }) => title).join(", ") || onboarded.reason}`,
            steps: missing,
          },
        ]
      : [];
  return [...version, ...onboarding];
};

/** A part not known yet is not behind. */
export const inSync = (row: MachineRow, desktop: DesktopHolds): InSync => {
  if (row.state !== "live") return { state: row.state, behind: [] };
  const behind = lags(row, desktop);
  return { state: behind.length === 0 ? "in-sync" : "behind", behind };
};

/** The Machines page's top line, and how many Machines aren't in sync, connecting ones aside. */
export const flockInSync = (rows: ReadonlyArray<MachineRow>, desktop: DesktopHolds) => {
  const lagging = rows.flatMap((row) => {
    const { state, behind } = inSync(row, desktop);
    if (state === "in-sync" || state === "connecting") return [];
    return [
      state === "behind"
        ? `${row.name} is behind on ${behind.map(({ part }) => part).join(" and ")}`
        : `${row.name} is ${NOT_LIVE_SAID[state].toLowerCase()}`,
    ];
  });
  return {
    said:
      lagging.length === 0
        ? `Every Machine is in sync with Desktop ${desktop.version}`
        : `Not in sync with Desktop ${desktop.version}: ${lagging.join("; ")}`,
    count: lagging.length,
  };
};
