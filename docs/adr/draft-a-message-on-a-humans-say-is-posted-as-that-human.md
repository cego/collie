# A message on a human's say is posted as that human

**Status: accepted, built.** Amends D3 of
[ADR-draft-a-release-shares-its-merge-request-on-a-humans-say](draft-a-release-shares-its-merge-request-on-a-humans-say.md):
the share goes through the Slack Connection, but under the human's own Slack user, not
the shared bot.

The shared Collie app posts with one bot token (`xoxb-`). A merge request shared "for
approval" therefore reads as a bot asking. Teammates review a person's request, not a bot's.

## Decision

**D1. Two kinds of message, two identities.** A message a human asked for, today only
**Post for approval**, is posted with that human's Slack user token. A message Collie
sends on its own, a notification, stays with the bot token. Neither path uses the other's
token. They are two Connections: `slack`, Collie's bot, and `slack-user`, the human
signed in as themselves. The release workflow uses `slack-user`, and notifications use
`slack`. When this lands, CONTEXT.md's **Connection** entry names both.

**D2. Each human signs in to the shared app from Desktop with PKCE.** The shared Collie
app turns on PKCE and registers a `http://localhost` redirect. Desktop asks only for user
scopes: `chat:write`, `channels:read`, `groups:read`. No client secret leaves Slack.
Turning on PKCE marks the app as a public client, and only Slack support can undo that.

**D3. Desktop owns the grant.** Desktop keeps the refresh token in its keyring, renews it,
and gives each Machine only the current access token. A Machine never renews, because a
rotated refresh token works only once.

**D4. Never the bot instead.** Before posting, the host checks with Slack that the token
belongs to the human who signed in, in the bot's workspace. A missing, expired or
mismatched user token posts nothing. The Run then asks the human to share the link
themselves, as it does without a Slack Connection. The Connection names the fix.

## Limits Slack sets

- Slack writes its own attribution under a user-token post, reported as "Sent using
  <app name>". Slack does not document it, its wording cannot be changed, and it cannot be
  turned off. The closest Collie gets is "Sent using Collie", never "Sent with Collie".
- Refresh tokens of a PKCE app expire after 30 days. A human away for longer signs in again.
- A Machine set up without Desktop has no user token, so it never posts for approval.

## Considered

- **A second app only for user posts.** This leaves the bot app's one-way PKCE switch alone,
  but means two installs and a footer that names the second app.
- **Pasting the app page's User OAuth Token.** That token exists only for the person who
  installed the app.
- **`username`/`icon_url` with `chat:write.customize`.** This makes the bot look like the
  human without being them. Rejected.
