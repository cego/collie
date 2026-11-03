import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import type { SlackChannel, SlackChoices } from "../../../src/slack";

/** Where Slack sends a human back after they sign in as themselves; the manifest names it. */
export const SLACK_CALLBACK_PORT = 47328;
export const SLACK_CALLBACK_PATH = "/slack/callback";
export const SLACK_REDIRECT_URL = `http://localhost:${SLACK_CALLBACK_PORT}${SLACK_CALLBACK_PATH}`;
export const SLACK_USER_SCOPES = ["chat:write", "channels:read", "groups:read"];

export const SLACK_MANIFEST_URL = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(
  JSON.stringify({
    display_information: {
      name: "Collie",
      description: "Posts approval requests and notifications for Collie",
    },
    features: { bot_user: { display_name: "Collie", always_online: false } },
    oauth_config: {
      pkce_enabled: true,
      redirect_urls: [SLACK_REDIRECT_URL],
      scopes: {
        bot: ["chat:write", "im:write", "channels:read", "groups:read", "users:read"],
        user: SLACK_USER_SCOPES,
      },
    },
  }),
)}`;

type Channels = ReadonlyArray<typeof SlackChannel.Type>;

export const SIGN_IN_TO_PICK =
  "Sign in to Slack as yourself under Connections to pick a channel you're in";

const asOptions = (channels: Channels) =>
  Arr.map(channels, (channel) => ({ value: channel.id, label: `#${channel.name}` }));

/** The notification row offers the bot's `choices`; the approval row the human's own `yours`. */
export const slackDestinationRow = (
  key: string,
  value: string,
  choices: SlackChoices | null,
  yours: Channels | null,
) => {
  const notification = key === "slack.notification_channel";
  const offered = notification ? (choices?.channels ?? null) : yours;
  const options = [
    { value: "", label: notification ? "Nowhere: toasts only" : "Nowhere: shares nothing" },
    ...asOptions(offered ?? []),
  ];
  if (notification) options.push({ value: "dm", label: "A direct message to you" });
  if (value && !Arr.some(options, (option) => option.value === value)) {
    const person = notification
      ? Option.getOrUndefined(
          Option.map(Option.fromNullishOr(choices), (present_) =>
            Option.getOrUndefined(Arr.findFirst(present_.people, (person) => person.id === value)),
          ),
        )
      : undefined;
    options.push({
      value,
      label: person === undefined ? `${value} (not checked)` : `A direct message to ${person.name}`,
    });
  }
  return {
    disabled: offered === null,
    hint:
      offered !== null
        ? null
        : notification
          ? "Connect Slack, under Connections below, to pick from the channels your Collie is in."
          : SIGN_IN_TO_PICK,
    options,
  };
};

type PickedDestination =
  | { readonly refused: string }
  | { readonly people: ReadonlyArray<{ readonly value: string; readonly label: string }> }
  | { readonly value: string };
export const pickSlackDestination = (
  key: string,
  value: string,
  choices: SlackChoices | null,
  yours: Channels | null,
): PickedDestination => {
  if (key !== "slack.notification_channel") {
    if (yours === null) return { refused: SIGN_IN_TO_PICK };
    return value === "" || Arr.some(yours, (channel) => channel.id === value)
      ? { value }
      : { refused: "Pick a channel you're in, or refresh Slack" };
  }
  if (choices === null) return { refused: "Connect Slack before picking a destination" };
  if (value === "dm")
    return {
      people: Arr.map(choices.people, (person) => ({ value: person.id, label: person.name })),
    };
  if (Arr.some(choices.people, (person) => person.id === value)) return { value };
  return value === "" || Arr.some(choices.channels, (channel) => channel.id === value)
    ? { value }
    : { refused: "Pick a channel Collie is in, or refresh Slack" };
};
