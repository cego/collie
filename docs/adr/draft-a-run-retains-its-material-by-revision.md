# ADR-draft-a-run-retains-its-material-by-revision

Status: draft

A Run's attachments, plan, evidence files, and handoffs have separate readers. Their
paths alone cannot identify what someone inspected after a file changes or disappears.

The owning host keeps an [Artefact](../../CONTEXT.md) catalogue in its existing SQLite
database. Discovery keys map collection references to persistent ids. Each changed
SHA-256 digest receives the next content revision and an immutable Run-owned snapshot.
Equal bytes at different origins remain different entries. Returning to earlier bytes
creates another revision. Existing references and attachment inheritance keep their meaning.

Legacy creation time is unknown. Source mtime describes modification; host registration,
observation, and revision detection are separate dates. No reader substitutes ctime for creation.

Receipts and their request results commit together. A receipt identifies the displayed
revision, so an old acknowledgement cannot make a newer revision seen. Clearing a receipt
is deliberate; replay returns its earlier result without applying it again. The normal
Actor audit accompanies human and agent operations. This installation has one operator's
shared receipt, not a separate receipt per front door.

Catalogue changes notify only their Run through StoreWrites. Unchanged observations
write no audit and publish no Run change. A side job rotates through eight retained Runs
per round at a 30-second interval. Selected records reconcile on first access; explicit
refresh waits for an observation. Catalogue operations never modify proof results.

Desktop fetches bounded parts of the selected revision and verifies size and digest.
Native previews fence completions by installation, Run, id, revision, opening serial,
and selection generation. Selected text or image presentation can acknowledge a revision;
video requires a completed native surface frame. Listing, prefetching, tool reads, opening,
and saving do not acknowledge inspection. Explicit Mark seen remains available to every Actor.

The pinned Rune player serves macOS. Linux uses GStreamer on a worker with a one-frame
appsink queue and Rune's public native surface. Playback starts paused and releases on
selection, tab, revision, or record changes. Linux bundles carry the required plugins,
libraries, scanner, and distribution copyright notices. Unsupported media keeps open/save
actions. No webview or provider account integration is introduced.

External material is registered, not fetched. A provider resource's identity includes
its namespace, so equal ids in two accounts stay apart; a new version or destination is
the next revision. A provider observation and a retained export are separate facts: an
edited export changes the retained copy, never the provider version. Collie ships no
provider reader, so external updates are shown as untracked rather than guessed; a
documented reader can be added behind one observation boundary without changing the
catalogue. Opening a link is a handoff, never an inspection.

Snapshots belong to the owning Run and disappear with its cleanup. They are not backups.
Registration and cross-Run search extend this catalogue in subsequent slices.
