import * as Arr from "effect/Array";
import { isDirectMessage } from "../../../src/slack";
import type { SlackChannel } from "../../../src/slack";

export const SLACK_CLIENT_ID = "2673706937.12461393591409";
// WARNING: the port the shared app's settings name as its callback; changing it breaks sign-in.
export const SLACK_CALLBACK_PORT = 47_328;
export const SLACK_CALLBACK_PATH = "/slack/callback";
export const SLACK_REDIRECT_URL = `http://localhost:${SLACK_CALLBACK_PORT}${SLACK_CALLBACK_PATH}`;
export { SLACK_USER_SCOPES } from "../../../src/slack";

type Channels = ReadonlyArray<typeof SlackChannel.Type>;

export const SIGN_IN_TO_PICK = "Sign in to Slack under Connections to pick a channel you're in";

export const slackDestinationRow = (key: string, value: string, yours: Channels | null) => {
  const options = [
    {
      value: "",
      label:
        key === "slack.notification_channel" ? "Nowhere: toasts only" : "Nowhere: shares nothing",
    },
    ...Arr.map(yours ?? [], (channel) => ({ value: channel.id, label: `#${channel.name}` })),
  ];
  if (value && !Arr.some(options, (option) => option.value === value)) {
    options.push({
      value,
      label: isDirectMessage(value)
        ? `${value} (direct messages are no longer sent)`
        : `${value} (not checked)`,
    });
  }
  return { disabled: yours === null, hint: yours === null ? SIGN_IN_TO_PICK : null, options };
};

export const pickSlackDestination: (
  value: string,
  yours: Channels | null,
) => { readonly refused: string } | { readonly value: string } = (value, yours) => {
  if (yours === null) {
    return { refused: SIGN_IN_TO_PICK };
  }
  return value === "" || Arr.some(yours, (channel) => channel.id === value)
    ? { value }
    : { refused: "Pick a channel you're in, or refresh Slack" };
};
