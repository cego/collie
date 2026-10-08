# Collie is released for macOS on Apple silicon

**Status: accepted, to be built.**

A colleague's Mac (macOS, arm64) could not install Collie. `install-desktop.sh` stops
unless it runs on Linux x64. Checking a signature needs OpenSSL 3, which macOS does not
have. Their herdr 0.7.1 has no `herdr machine`, and they were not told what upgrading it
would do to the sessions they had running.

## What was true before

The release builds the runner for `darwin-arm64` and `darwin-x64` by cross-compiling on
Linux, and `install.sh` already names those assets. No macOS machine has ever run one of
them: the release smokes only `linux-x64`, and CI runs only on Linux. Desktop is built on
a Linux runner, and Electrobun builds only for the platform it runs on, so there is no
Desktop for a Mac. Both installers check an Ed25519 signature with `openssl pkeyutl`.
LibreSSL, which is macOS's `/usr/bin/openssl`, cannot do that, and neither can OpenSSL
1.1. So a Mac needed Homebrew's OpenSSL and a RHEL 8 Machine needed EPEL's. `collie
doctor` says that herdr is older than `min_herdr_version` and links to herdr's install
page. It does not say what an upgrade will do to running panes.

## Decision

**D1. The macOS runner that is published is the one that ran on a Mac.** The release
still cross-compiles `darwin-arm64` and `darwin-x64`. Before the release is signed, a
macOS (arm64) job runs `tools/smoke.sh` against the published `darwin-arm64` file. If
Bun's cross-build does not carry a signature Apple silicon accepts, that job ad-hoc signs
the binary first (`codesign --sign -`). The release key then signs those exact bytes.

**D2. Desktop is released for `macos-arm64`, built on a macOS runner.** Electrobun signs
with an Apple Developer ID, and notarizes, when the release has credentials for it.
Without them the app is ad-hoc signed. `install-desktop.sh` installs it either way. It
fetches the DMG with `curl`, so the DMG is not quarantined, verifies it, and copies the
app into `~/Applications`. Desktop then updates itself through Electrobun, and checks
every update against the release key, as it does on Linux. No Desktop is released for
`darwin-x64`.

**D3. Every release asset is signed twice.** The Ed25519 signature (`<asset>.sig`) stays
what the runner and Desktop check in-process, so nothing already installed changes. A
second signature, ECDSA P-256 over SHA-256 (`<asset>.p256.sig`), is made with a second
CI secret (`COLLIE_SIGNING_KEY_P256`). Its public half is `release-p256.pub`, beside
`release.pub`. The two shell installers check only this second signature, with
`openssl dgst -sha256 -verify`. LibreSSL, OpenSSL 1.1 and OpenSSL 3 can all do that, so
no platform needs OpenSSL 3 any more.

**D4. Collie explains an old herdr and never upgrades it.** `collie doctor` reports the
herdr client and the running herdr server separately. It also says what an upgrade does
to running panes. Before herdr 0.9.0 ("endpoint generation 1"), the running server has to
stop once, which ends every program in its panes. From 0.9.0 on, `herdr update` leaves
the running server and its panes alone, and a server restart picks up the server-side
changes. `herdr update --handoff` is named as herdr's experimental way to keep panes
across the stop. Collie never runs `herdr update` or `herdr server stop` itself. Stopping
a server ends the human's work, so when to do it is the human's choice. `prepare.sh` does
not link the plugin into a herdr older than the manifest's `min_herdr_version`. It says
so and leaves the explanation to `doctor`.

**D5. Desktop on macOS starts with the PATH of the user's login shell.** An app opened
from Finder or the Dock gets launchd's minimal PATH, so `herdr`, `collie`, `claude`,
`git` and `ssh` would not resolve as they do in a terminal. Desktop reads the PATH once at
start from the user's `$SHELL`, as an interactive login shell, and runs everything with
it.

## Rejected

- **Requiring Homebrew's OpenSSL**, or installing it from the script. That adds a
  prerequisite the platform can do without, and it changes the system to install an
  app. Homebrew may not be there either.
- **Replacing Ed25519 with P-256 everywhere.** Every installed Desktop checks its updates
  against the Ed25519 key, so replacing it would strand them. Signing with both keys
  changes nothing that is already installed.
- **Checking Ed25519 on macOS with Swift's CryptoKit.** It needs the Swift toolchain, and
  it compiles for seconds on every check.
- **Building Desktop's macOS bundle on Linux.** Electrobun cannot cross-build.
- **Desktop for Intel Macs.** It needs an Intel macOS runner for a shrinking set of
  machines. The runner still covers the TUI plugin on an Intel Mac.

## Consequences

The release needs a second signing secret. Until `COLLIE_SIGNING_KEY_P256` is set,
`tools/sign.ts` refuses to sign and no release is published. That is how a missing
Ed25519 key is treated already.

A DMG downloaded in a browser is quarantined. If the release is not notarized,
Gatekeeper refuses it. The documented install is the script, which avoids the quarantine.
Notarization becomes available when an Apple Developer ID is configured.

`collie upgrade` stages a Desktop update only on Linux. On macOS, Desktop finds the same
update itself within the hour (`ponytail:` the ceiling). Staging it on macOS needs
Electrobun's macOS paths and a process check that does not use `/proc`.

CI gains macOS jobs. The repository is public, so they cost nothing.
