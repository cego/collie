import type { SlackChoices } from "../../../src/slack";

export const SLACK_MANIFEST_URL = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(
  JSON.stringify({
    display_information: {
      name: "Collie",
      description: "Posts approval requests and notifications for Collie",
    },
    features: { bot_user: { display_name: "Collie", always_online: false } },
    oauth_config: {
      scopes: { bot: ["chat:write", "im:write", "channels:read", "groups:read", "users:read"] },
    },
  }),
)}`;

export const slackDestinationRow = (key: string, value: string, choices: SlackChoices | null) => {
  const notification = key === "slack.notification_channel";
  const options = [
    { value: "", label: notification ? "Nowhere: toasts only" : "Nowhere: shares nothing" },
    ...(choices?.channels.map((channel) => ({ value: channel.id, label: `#${channel.name}` })) ??
      []),
  ];
  if (notification) options.push({ value: "dm", label: "A direct message to you" });
  if (value && !options.some((option) => option.value === value)) {
    const person = notification ? choices?.people.find((person) => person.id === value) : undefined;
    options.push({
      value,
      label: person === undefined ? `${value} (not checked)` : `A direct message to ${person.name}`,
    });
  }
  return {
    disabled: choices === null,
    hint:
      choices === null
        ? "Connect Slack, under Connections below, to pick from the channels your Collie is in."
        : null,
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
): PickedDestination => {
  if (choices === null) return { refused: "Connect Slack before picking a destination" };
  if (key === "slack.notification_channel") {
    if (value === "dm")
      return { people: choices.people.map((person) => ({ value: person.id, label: person.name })) };
    if (choices.people.some((person) => person.id === value)) return { value };
  }
  return value === "" || choices.channels.some((channel) => channel.id === value)
    ? { value }
    : { refused: "Pick a channel Collie is in, or refresh Slack" };
};
