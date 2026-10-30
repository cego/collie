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

test("Add Collie carries only the five post-only bot scopes, without events or Socket Mode", () => {
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
      scopes: { bot: ["chat:write", "im:write", "channels:read", "groups:read", "users:read"] },
    },
  });
});

test("channel rows disable until connected, retain old names, and store channel or chosen person ids", () =>
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
      const off = slackDestinationRow("release.approval_channel", "#old-releases", null);
      expect(off.disabled).toBe(true);
      expect(off.hint).toBe(
        "Connect Slack, under Connections below, to pick from the channels your Collie is in.",
      );
      expect(off.options).toContainEqual({
        value: "#old-releases",
        label: "#old-releases (not checked)",
      });
      const api = slackApi("xoxb-fixture", fakeSlack().client);
      const choices = {
        identity: yield* api.auth(),
        channels: yield* api.channels(),
        people: yield* api.people(),
      };
      const approval = slackDestinationRow("release.approval_channel", "#old-releases", choices);
      expect(approval.disabled).toBe(false);
      expect(approval.options).toContainEqual({ value: "G234", label: "#releases" });
      expect(pickSlackDestination("release.approval_channel", "G234", choices)).toEqual({
        value: "G234",
      });
      const pickedChannel = pickSlackDestination("release.approval_channel", "G234", choices);
      const savedChannel = editSetting(
        NO_FLOCK_SETTINGS,
        "release.approval_channel",
        "value" in pickedChannel ? pickedChannel.value : "refused",
        "2026-10-29T14:00:00Z",
      );
      expect(
        "refused" in savedChannel
          ? savedChannel.refused
          : savedChannel.settings["release.approval_channel"]?.value,
      ).toBe("G234");
      expect(pickSlackDestination("release.approval_channel", "C999", choices)).toHaveProperty(
        "refused",
      );
      const notify = slackDestinationRow("slack.notification_channel", "", choices);
      expect(notify.options).toContainEqual({ value: "", label: "Nowhere: toasts only" });
      expect(notify.options).toContainEqual({ value: "dm", label: "A direct message to you" });
      expect(pickSlackDestination("slack.notification_channel", "dm", choices)).toEqual({
        people: [
          { value: "U456", label: "Sam" },
          { value: "U789", label: "Alex Example" },
        ],
      });
      expect(pickSlackDestination("slack.notification_channel", "U789", choices)).toEqual({
        value: "U789",
      });
      const pickedPerson = pickSlackDestination("slack.notification_channel", "U789", choices);
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
        slackDestinationRow("slack.notification_channel", "U789", choices).options,
      ).toContainEqual({ value: "U789", label: "A direct message to Alex Example" });
    }),
  ));
