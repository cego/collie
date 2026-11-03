import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import {
  SLACK_MANIFEST_URL,
  slackDestinationRow,
  pickSlackDestination,
} from "../desktop/src/shared/slack";
import { slackApi } from "../src/slack";
import { fakeSlack } from "./support/slack";
import { runEffect } from "./support/effect";
import { Effect } from "effect";
import {
  editSetting,
  settingSections,
  NO_FLOCK_SETTINGS,
} from "../desktop/src/shared/flock-settings";

/** The bot's Slack choices and the human's own channels, as the fake answers each token. */
const slackDestinations = Effect.gen(function* () {
  const fake = fakeSlack();
  const bot = slackApi("xoxb-fixture", fake.client);
  return {
    choices: {
      identity: yield* bot.auth(),
      channels: yield* bot.channels(),
      people: yield* bot.people(),
    },
    yours: yield* slackApi("xoxe.xoxp-1-user-fixture", fake.client).channels(),
  };
});

test("Add Collie keeps the five post-only bot scopes and lets a human sign in as themselves with PKCE, without events or Socket Mode", () => {
  const url = new URL(SLACK_MANIFEST_URL);
  expect(url.origin + url.pathname).toBe("https://api.slack.com/apps");
  expect(url.searchParams.get("new_app")).toBe("1");
  expect(JSON.parse(url.searchParams.get("manifest_json")!)).toEqual({
    display_information: {
      name: "Collie",
      description: "Posts approval requests and notifications for Collie",
    },
    features: { bot_user: { display_name: "Collie", always_online: false } },
    oauth_config: {
      pkce_enabled: true,
      redirect_urls: ["http://localhost:47328/slack/callback"],
      scopes: {
        bot: ["chat:write", "im:write", "channels:read", "groups:read", "users:read"],
        user: ["chat:write", "channels:read", "groups:read"],
      },
    },
  });
});

test("the notification row disables until connected and stores a channel or a chosen person's id", () =>
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
      const off = slackDestinationRow("slack.notification_channel", "#old-notices", null, null);
      expect(off.disabled).toBe(true);
      expect(off.hint).toBe(
        "Connect Slack, under Connections below, to pick from the channels your Collie is in.",
      );
      expect(off.options).toContainEqual({
        value: "#old-notices",
        label: "#old-notices (not checked)",
      });
      const { choices, yours } = yield* slackDestinations;
      const notify = slackDestinationRow("slack.notification_channel", "", choices, yours);
      expect(notify).toEqual({
        disabled: false,
        hint: null,
        options: [
          { value: "", label: "Nowhere: toasts only" },
          { value: "C123", label: "#engineering" },
          { value: "G234", label: "#releases" },
          { value: "dm", label: "A direct message to you" },
        ],
      });
      expect(pickSlackDestination("slack.notification_channel", "C123", choices, yours)).toEqual({
        value: "C123",
      });
      expect(pickSlackDestination("slack.notification_channel", "C456", choices, yours)).toEqual({
        refused: "Pick a channel Collie is in, or refresh Slack",
      });
      expect(pickSlackDestination("slack.notification_channel", "dm", choices, yours)).toEqual({
        people: [
          { value: "U456", label: "Sam" },
          { value: "U789", label: "Alex Example" },
        ],
      });
      expect(pickSlackDestination("slack.notification_channel", "U789", choices, yours)).toEqual({
        value: "U789",
      });
      const pickedPerson = pickSlackDestination(
        "slack.notification_channel",
        "U789",
        choices,
        yours,
      );
      const savedPerson = editSetting(
        NO_FLOCK_SETTINGS,
        "slack.notification_channel",
        "value" in pickedPerson ? pickedPerson.value : "refused",
        "2026-10-29T14:00:00Z",
      );
      expect(
        "refused" in savedPerson
          ? savedPerson.refused
          : savedPerson.settings["slack.notification_channel"]?.value,
      ).toBe("U789");
      expect(
        slackDestinationRow("slack.notification_channel", "U789", choices, yours).options,
      ).toContainEqual({ value: "U789", label: "A direct message to Alex Example" });
    }),
  ));

test("the approval row offers the channels the human is in, not the bot's, and refuses any other", () =>
  runEffect(
    Effect.gen(function* () {
      const { choices, yours } = yield* slackDestinations;
      expect(slackDestinationRow("release.approval_channel", "", choices, yours)).toEqual({
        disabled: false,
        hint: null,
        options: [
          { value: "", label: "Nowhere: shares nothing" },
          { value: "C456", label: "#design" },
          { value: "G234", label: "#releases" },
        ],
      });
      const picked = pickSlackDestination("release.approval_channel", "C456", choices, yours);
      expect(picked).toEqual({ value: "C456" });
      const saved = editSetting(
        NO_FLOCK_SETTINGS,
        "release.approval_channel",
        "value" in picked ? picked.value : "refused",
        "2026-10-29T14:00:00Z",
      );
      expect(
        "refused" in saved ? saved.refused : saved.settings["release.approval_channel"]?.value,
      ).toBe("C456");
      for (const outside of ["C123", "C999"])
        expect(pickSlackDestination("release.approval_channel", outside, choices, yours)).toEqual({
          refused: "Pick a channel you're in, or refresh Slack",
        });
      expect(pickSlackDestination("release.approval_channel", "", choices, yours)).toEqual({
        value: "",
      });
    }),
  ));

test("without the human's Slack sign-in the approval row is disabled with the sign-in hint, and a stored value stays unchecked", () =>
  runEffect(
    Effect.gen(function* () {
      const { choices, yours } = yield* slackDestinations;
      const off = slackDestinationRow("release.approval_channel", "#old-releases", choices, null);
      expect(off).toEqual({
        disabled: true,
        hint: "Sign in to Slack as yourself under Connections to pick a channel you're in",
        options: [
          { value: "", label: "Nowhere: shares nothing" },
          { value: "#old-releases", label: "#old-releases (not checked)" },
        ],
      });
      expect(
        pickSlackDestination("release.approval_channel", "C123", choices, null),
      ).toHaveProperty("refused");
      expect(
        slackDestinationRow("release.approval_channel", "C123", choices, yours).options,
      ).toContainEqual({ value: "C123", label: "C123 (not checked)" });
    }),
  ));
