# A message on a human's say is posted as that human

**Status: accepted, built.** Amends D3 of
[ADR-draft-a-release-shares-its-merge-request-on-a-humans-say](draft-a-release-shares-its-merge-request-on-a-humans-say.md):
the share goes through the Slack Connection, but under the human's own Slack user, not
the shared bot.

The shared Collie app posts with one bot token (`xoxb-`). A merge request shared "for
approval" therefore reads as a bot asking. Teammates review a person's request, not a bot's.

## Decision

**D1. One identity: the human's.** Every message Collie posts in Slack, a **Post for
approval** and a notification alike, is posted with the human's own Slack user token.
Slack is one Connection, `slack`, the human signed in as themselves. Collie has no bot
token: an older Collie's `slack.env` or `SLACK_BOT_TOKEN` is never read, and a Machine
holding only that reads `absent` until the human signs in. This amends this record's first
decision, which kept notifications with the bot: one sign-in is all a human sets up, and
nothing can fall back to a bot that posts under another name.

**D2. Each human signs in to the shared app from Desktop with PKCE.** The shared Collie
app turns on PKCE and registers a `http://localhost` redirect. Desktop ships the app's
public client ID and asks only for user scopes: `chat:write`, `channels:read`,
`groups:read`. No client secret leaves Slack.
Turning on PKCE marks the app as a public client, and only Slack support can undo that.

**D3. Desktop owns the grant.** Desktop keeps the refresh token in its keyring, renews it,
and gives each Machine only the current access token. A Machine never renews, because a
rotated refresh token works only once.

**D4. Never the bot instead.** Before posting, the host checks with Slack that the token
belongs to the human who signed in, in their workspace. A missing, expired or
mismatched user token posts nothing. The Run then asks the human to share the link
themselves, as it does without a Slack Connection. The Connection names the fix.

## Limits Slack sets

- Slack writes its own attribution under a user-token post, reported as "Sent using
  <app name>". Slack does not document it, its wording cannot be changed, and it cannot be
  turned off. The closest Collie gets is "Sent using Collie", never "Sent with Collie".
- Refresh tokens of a PKCE app expire after 30 days. A human away for longer signs in again.
- A Machine set up without Desktop has no user token, so it never posts for approval or
  notifications.
- Slack does not notify a human of their own message, so a notification posted as them
  does not ping them; Desktop's toast does.
- The user scopes cannot open a direct message, so notifications go to channels only.

## Considered

- **A second app only for user posts.** This leaves the bot app's one-way PKCE switch alone,
  but means two installs and a footer that names the second app.
- **Pasting the app page's User OAuth Token.** That token exists only for the person who
  installed the app.
- **`username`/`icon_url` with `chat:write.customize`.** This makes the bot look like the
  human without being them. Rejected.
