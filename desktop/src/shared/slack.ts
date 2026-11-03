import * as Arr from "effect/Array";
import type { SlackChannel } from "../../../src/slack";

/** The shared Collie app's public client ID; a PKCE sign-in needs no secret. */
export const SLACK_CLIENT_ID = "2673706937.12461393591409";
/** Where Slack sends a human back after they sign in; the app's settings name it. */
export const SLACK_CALLBACK_PORT = 47328;
export const SLACK_CALLBACK_PATH = "/slack/callback";
export const SLACK_REDIRECT_URL = `http://localhost:${SLACK_CALLBACK_PORT}${SLACK_CALLBACK_PATH}`;
export const SLACK_USER_SCOPES = ["chat:write", "channels:read", "groups:read"];

type Channels = ReadonlyArray<typeof SlackChannel.Type>;

export const SIGN_IN_TO_PICK = "Sign in to Slack under Connections to pick a channel you're in";

/** Both rows offer the channels the human is in, since everything is posted as them. */
export const slackDestinationRow = (key: string, value: string, yours: Channels | null) => {
  const options = [
    {
      value: "",
      label:
        key === "slack.notification_channel" ? "Nowhere: toasts only" : "Nowhere: shares nothing",
    },
    ...Arr.map(yours ?? [], (channel) => ({ value: channel.id, label: `#${channel.name}` })),
  ];
  if (value && !Arr.some(options, (option) => option.value === value))
    options.push({
      value,
      label: /^U[A-Z0-9]+$/.test(value)
        ? `${value} (direct messages are no longer sent)`
        : `${value} (not checked)`,
    });
  return { disabled: yours === null, hint: yours === null ? SIGN_IN_TO_PICK : null, options };
};

export const pickSlackDestination = (
  value: string,
  yours: Channels | null,
): { readonly refused: string } | { readonly value: string } => {
  if (yours === null) return { refused: SIGN_IN_TO_PICK };
  return value === "" || Arr.some(yours, (channel) => channel.id === value)
    ? { value }
    : { refused: "Pick a channel you're in, or refresh Slack" };
};
