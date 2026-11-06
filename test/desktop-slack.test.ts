import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import { expect, test } from "bun:test";
import { slackDestinationRow, pickSlackDestination } from "../desktop/src/shared/slack";
import { CONNECTION_NAMES } from "../desktop/src/shared/connections";
import { CREDENTIAL_SAID } from "../desktop/src/shared/in-sync";
import { slackApi } from "../src/slack";
import { fakeSlack } from "./support/slack";
import { runEffect } from "./support/effect";
import { Effect } from "effect";
import {
  editSetting,
  settingSections,
  NO_FLOCK_SETTINGS,
} from "../desktop/src/shared/flock-settings";

/** The channels the signed-in human is in, as the fake answers their token. */
const yoursIn = Effect.suspend(() =>
  slackApi("xoxe.xoxp-1-user-fixture", fakeSlack().client).channels(),
);

const SIGN_IN_TO_PICK = "Sign in to Slack under Connections to pick a channel you're in";

test("the notification row offers the channels the human is in, and no direct messages", () =>
  runEffect(
    Effect.gen(function* () {
      expect(
        Option.getOrUndefined(
          Arr.findFirst(
            Arr.flatMap(settingSections(NO_FLOCK_SETTINGS, {}, 0), (section) => section.rows),
            (row) => row.key === "slack.notification_channel",
          ),
        )!.defaultSaid,
      ).toBe("Unset: toasts only");
      const yours = yield* yoursIn;
      expect(slackDestinationRow("slack.notification_channel", "", yours)).toEqual({
        disabled: false,
        hint: null,
        options: [
          { value: "", label: "Nowhere: toasts only" },
          { value: "C456", label: "#design" },
          { value: "G234", label: "#releases" },
        ],
      });
      const picked = pickSlackDestination("C456", yours);
      expect(picked).toEqual({ value: "C456" });
      const saved = editSetting(
        NO_FLOCK_SETTINGS,
        "slack.notification_channel",
        "value" in picked ? picked.value : "refused",
        "2026-11-03T14:00:00Z",
      );
      expect(
        "refused" in saved ? saved.refused : saved.settings["slack.notification_channel"]?.value,
      ).toBe("C456");
      for (const outside of ["C123", "dm", "U789"])
        expect(pickSlackDestination(outside, yours)).toEqual({
          refused: "Pick a channel you're in, or refresh Slack",
        });
    }),
  ));

test("a person or direct message chosen before is kept and said to be no longer sent to, and a channel the human left stays unchecked", () =>
  runEffect(
    Effect.gen(function* () {
      const yours = yield* yoursIn;
      expect(
        slackDestinationRow("slack.notification_channel", "U789", yours).options,
      ).toContainEqual({ value: "U789", label: "U789 (direct messages are no longer sent)" });
      expect(
        slackDestinationRow("slack.notification_channel", "D123", yours).options,
      ).toContainEqual({ value: "D123", label: "D123 (direct messages are no longer sent)" });
      expect(
        slackDestinationRow("slack.notification_channel", "C123", yours).options,
      ).toContainEqual({ value: "C123", label: "C123 (not checked)" });
    }),
  ));

test("the approval row offers the channels the human is in and refuses any other", () =>
  runEffect(
    Effect.gen(function* () {
      const yours = yield* yoursIn;
      expect(slackDestinationRow("release.approval_channel", "", yours)).toEqual({
        disabled: false,
        hint: null,
        options: [
          { value: "", label: "Nowhere: shares nothing" },
          { value: "C456", label: "#design" },
          { value: "G234", label: "#releases" },
        ],
      });
      expect(pickSlackDestination("C456", yours)).toEqual({
        value: "C456",
      });
      for (const outside of ["C123", "C999"])
        expect(pickSlackDestination(outside, yours)).toEqual({
          refused: "Pick a channel you're in, or refresh Slack",
        });
      expect(pickSlackDestination("", yours)).toEqual({ value: "" });
    }),
  ));

test("without the human's Slack sign-in both rows are disabled with the sign-in hint, and stored values stay", () => {
  for (const [key, stored] of [
    ["release.approval_channel", "#old-releases"],
    ["slack.notification_channel", "#old-notices"],
  ] as const) {
    const off = slackDestinationRow(key, stored, null);
    expect(off.disabled).toBe(true);
    expect(off.hint).toBe(SIGN_IN_TO_PICK);
    expect(off.options).toContainEqual({ value: stored, label: `${stored} (not checked)` });
    expect(pickSlackDestination("C456", null)).toEqual({ refused: SIGN_IN_TO_PICK });
  }
});

test("Slack is called Slack, never Slack as you", () => {
  expect(CONNECTION_NAMES.slack).toBe("Slack");
  for (const said of [
    ...Rec.values(CONNECTION_NAMES),
    ...Arr.flatMap(Rec.values(CREDENTIAL_SAID), (one) => [one.lacks, one.none]),
    slackDestinationRow("release.approval_channel", "", null).hint,
    slackDestinationRow("slack.notification_channel", "", null).hint,
  ]) {
    expect(said).not.toMatch(/as you\b|yourself/);
  }
});
