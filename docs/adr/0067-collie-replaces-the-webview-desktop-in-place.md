# Collie replaces the webview desktop in place

**Status: accepted for Collie 1.0.0.** Requested by the human on 2026-11-12: carry the resource
optimizations into the Rune branch, remove the Nuxt app, and cut existing desktop
installations directly over to the native app named Collie.

## Decision

The Rune shell is the only desktop app built by this branch. The TypeScript core,
host protocol and shared decision logic remain. Nuxt/Vue and the Electrobun UI
runtime, their build configuration and view-only tests are removed. The released
host and terminal optimizations are inherited by merging current master, including
ADR-0063's bounded refresh ownership and ADR-0064's scoped board reads.

Keep application identity `dk.cego.collie.desktop`, stable update filenames and
installed launcher paths. A display name is not an installation identifier:
Linux's `app/bin/launcher` and macOS's `collie-desktop.app` keep existing shortcuts
and updater ownership valid while presenting Collie to the human. Preserve the
existing state, credential and channel directories, including legacy macOS roots.
No settings export/import or second onboarding is needed. The native UI embeds the
official black-and-white Collie tile from `assets/brand/`, also used for the packaged
app icons.

Electrobun 2.0.2's native helper validates the replacement's launcher, version
metadata and `Resources/uninstall` before exchanging bundles. The build fetches
that target-specific native manager from Collie 0.132.2, verifies the decompressed
archive against `release.pub`, and retains only the manager. It requires no Bun,
CEF or webview. The manifest includes `schemaVersion: 1`; metadata carries the
original identifier and internal name, plus `displayName: Collie`.

Subsequent native updates verify the signed tar again at launch, match the requested
identity/version/hash, require executable shell and core files, and exchange
directories atomically. A refusal keeps the installed bundle and clears the
pending handover so launching the app cannot enter a restart loop. Restart stops
the old core before executing the launcher again. An installation lock serializes
concurrent launches; a waiting launch also re-executes the installed shell after
another launch replaces it.

CI requires the native bundle, core typecheck, Rust behavior tests and schema
contract checks. The release builds the same native artifacts for Linux x64 and
Apple silicon, including the existing signed Setup/DMG installer names. This
cutover ships as Collie 1.0.0, published from the version tag after the required checks pass.

## Evidence and limits

Focused host/terminal tests prove the port, and bundle, installer, identity, state
and update tests cover the cutover contract. Native runtime tests cover the
replaced view; tests importing deleted Vue components leave with those components.
Retained TypeScript decision tests and benchmark fixture/analysis utilities remain.

The old helper considers a successful process spawn a successful update; it has
no readiness handshake. Therefore a native bundle launch smoke is needed in
addition to archive validation. Linux headless validation is available here;
macOS signing/archive checks run in platform CI. Gatekeeper, real GPU/multi-monitor
interaction and assistive-technology walkthroughs remain platform evidence, not
claims made by unit tests or the earlier spike measurements.
