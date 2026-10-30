// Whether each Machine is In sync with Desktop (CONTEXT.md), and the Flock's line about it.

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import {
  CREDENTIALS,
  type Credential,
  type MachineRow,
  type NotLive,
  type OnboardStep,
  SETTLED,
} from "./flock";

/** What a Machine lags on, in words, with the steps that fix onboarding. */
export interface Lag {
  readonly part: "version" | "settings" | "definitions" | "credentials" | "onboarding";
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
  slack: { lacks: "Slack's token", none: "Slack token" },
} satisfies Record<Credential, { lacks: string; none: string }>;

export const NOT_LIVE_SAID = {
  unreachable: "Out of reach",
  sso: "Waiting for SSO",
  "no-collie": "Collie isn't installed",
  "update-desktop": "Update Desktop",
} satisfies Record<NotLive, string>;

const RELEASE = /^\d+\.\d+\.\d+$/;

const older = (build: string, than: string) => {
  const [a, b] = Arr.map([build, than], (version) => Arr.map(Str.split(version, "."), Number));
  const at = Option.getOrElse(
    Arr.findFirstIndex(a!, (part, i) => part !== b![i]),
    () => -1,
  );
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
  const missing =
    Option.getOrUndefined(
      Option.map(Option.fromNullishOr(onboarded), (present) =>
        Arr.filter(present.steps, ({ status }) => !SETTLED.includes(status)),
      ),
    ) ?? [];
  const onboarding: ReadonlyArray<Lag> =
    onboarded?.ready === false
      ? [
          {
            part: "onboarding",
            said: `Not onboarded: ${
              Arr.join(
                Arr.map(missing, ({ title }) => title),
                ", ",
              ) ||
              (onboarded.reason ?? "doctor says it isn't ready")
            }`,
            steps: missing,
          },
        ]
      : [];
  const failed = row.settings?.failed ?? null;
  const settings: ReadonlyArray<Lag> =
    failed === null
      ? []
      : [{ part: "settings", said: `Settings didn't sync: ${failed}`, steps: [] }];
  const unshared = row.definitions?.failed ?? null;
  const definitions: ReadonlyArray<Lag> =
    unshared === null
      ? []
      : [
          {
            part: "definitions",
            said: `Definitions didn't sync: ${unshared}${development === null ? "" : " (a development checkout, updated by hand)"}`,
            steps: [],
          },
        ];
  const credentials = Arr.flatMap(desktop.credentials, (credential): ReadonlyArray<Lag> => {
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
  return [...version, ...settings, ...definitions, ...credentials, ...onboarding];
};

/** A part not known yet is not behind. */
export const inSync = (row: MachineRow, desktop: DesktopHolds): InSync => {
  if (row.state !== "live") return { state: row.state, behind: [] };
  const behind = lags(row, desktop);
  return { state: behind.length === 0 ? "in-sync" : "behind", behind };
};

/** Whether Sync now is offered: onboarding has its own steps. */
export const syncable = (verdict: InSync) =>
  Arr.some(verdict.behind, ({ part }) => part !== "onboarding");

/** The Collie a Machine's row says it runs. */
export const buildOf = ({ build, development }: Pick<MachineRow, "build" | "development">) =>
  development !== null
    ? `development build ${development}`
    : build !== null
      ? `Collie ${build}`
      : "Build not known yet";

/** The Machines page's top line, then why each Machine is behind, as the Flock chat reads it. */
export const flockInSyncSaid = (rows: ReadonlyArray<MachineRow>, desktop: DesktopHolds) =>
  Arr.join(
    [
      flockInSync(rows, desktop).said,
      ...Arr.flatMap(rows, (row) => {
        const { behind } = inSync(row, desktop);
        return behind.length === 0
          ? []
          : [
              `${row.name}: ${Arr.join(
                Arr.map(behind, ({ said }) => said),
                "; ",
              )}`,
            ];
      }),
    ],
    ". ",
  );

/** The Machines page's top line, and how many Machines aren't in sync, connecting ones aside. */
export const flockInSync = (rows: ReadonlyArray<MachineRow>, desktop: DesktopHolds) => {
  const lagging = Arr.flatMap(rows, (row) => {
    const { state, behind } = inSync(row, desktop);
    if (state === "in-sync" || state === "connecting") return [];
    return [
      `${row.name}: ${state === "behind" ? `behind on ${Arr.join([...new Set(Arr.map(behind, ({ part }) => part))], " and ")}` : NOT_LIVE_SAID[state]}`,
    ];
  });
  const none = Arr.map(
    Arr.filter(
      CREDENTIALS,
      (credential) => credential !== "slack" && !desktop.credentials.includes(credential),
    ),
    (credential) => `Desktop has no ${CREDENTIAL_SAID[credential].none} to give`,
  );
  return {
    said: Arr.join(
      [
        lagging.length === 0
          ? `Every Machine is in sync with Desktop ${desktop.version}`
          : `Not in sync with Desktop ${desktop.version}: ${Arr.join(lagging, "; ")}`,
        ...none,
      ],
      ". ",
    ),
    count: lagging.length,
  };
};
