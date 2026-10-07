// Whether each Machine is In sync with Desktop (CONTEXT.md), and the Flock's line about it.

import { type Credential, type MachineRow, type NotLive, type OnboardStep, SETTLED } from "./flock";

/** What a Machine lags on, in words, with the steps that fix onboarding. */
export interface Lag {
  readonly part: "version" | "settings" | "credentials" | "onboarding";
  readonly said: string;
  readonly steps: ReadonlyArray<OnboardStep>;
}

export interface InSync {
  readonly state: "in-sync" | "behind" | "connecting" | NotLive;
  readonly behind: ReadonlyArray<Lag>;
}

/** What Desktop gives its Flock; a version that isn't a release asks nothing of one. */
export interface DesktopHolds {
  readonly version: string;
  readonly credentials: ReadonlyArray<Credential>;
}

export const CREDENTIAL_SAID = {
  gitlab: { lacks: "the GitLab token", none: "GitLab token" },
  helle: { lacks: "Helle's token", none: "Helle token" },
} satisfies Record<Credential, { lacks: string; none: string }>;

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
            said: `Not onboarded: ${missing.map(({ title }) => title).join(", ") || (onboarded.reason ?? "doctor says it isn't ready")}`,
            steps: missing,
          },
        ]
      : [];
  const failed = row.settings?.failed ?? null;
  const settings: ReadonlyArray<Lag> =
    failed === null
      ? []
      : [{ part: "settings", said: `Settings didn't sync: ${failed}`, steps: [] }];
  const credentials = desktop.credentials.flatMap((credential): ReadonlyArray<Lag> => {
    const held = row.credentials[credential];
    if (held === undefined || held.given) return [];
    const lacks = `Lacks ${CREDENTIAL_SAID[credential].lacks}`;
    return [
      {
        part: "credentials",
        said: held.failed === null ? lacks : `${lacks}: ${held.failed}`,
        steps: [],
      },
    ];
  });
  return [...version, ...settings, ...credentials, ...onboarding];
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
      `${row.name}: ${state === "behind" ? `behind on ${[...new Set(behind.map(({ part }) => part))].join(" and ")}` : NOT_LIVE_SAID[state]}`,
    ];
  });
  const none = (["gitlab", "helle"] as const)
    .filter((credential) => !desktop.credentials.includes(credential))
    .map((credential) => `Desktop has no ${CREDENTIAL_SAID[credential].none} to give`);
  return {
    said: [
      lagging.length === 0
        ? `Every Machine is in sync with Desktop ${desktop.version}`
        : `Not in sync with Desktop ${desktop.version}: ${lagging.join("; ")}`,
      ...none,
    ].join(". "),
    count: lagging.length,
  };
};
