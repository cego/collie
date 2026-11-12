//! An update applied at launch, against a fake install directory. The tars and their signatures
//! are `fixtures/update/`, signed by `src/signing.ts`'s `signRelease` with a test key.

use collie_desktop_update::{Applied, apply_staged, exchange};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/update");
const BUNDLE: &str = "app";

fn fixture(name: &str) -> Vec<u8> {
    fs::read(format!("{FIXTURES}/{name}")).unwrap()
}

fn key() -> String {
    String::from_utf8(fixture("release-test.pub")).unwrap()
}

/// An install with 0.130.0 in place, its launcher saying so.
fn installed() -> tempfile::TempDir {
    let install = tempfile::tempdir().unwrap();
    let bundle = install.path().join(BUNDLE);
    fs::create_dir_all(bundle.join("bin")).unwrap();
    let launcher = bundle.join("bin/launcher");
    fs::write(&launcher, "#!/bin/sh\necho 0.130.0\n").unwrap();
    fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
    install
}

fn stage(install: &Path, tar: &[u8], signature: Option<&[u8]>) {
    let staged = install.join(".update");
    fs::create_dir_all(&staged).unwrap();
    fs::write(staged.join(format!("{BUNDLE}.tar")), tar).unwrap();
    fs::write(staged.join(format!("{BUNDLE}.tar.json")), r#"{"version":"0.131.0","hash":"new0131","identifier":"dk.cego.collie.desktop","channel":"stable"}"#).unwrap();
    if let Some(signature) = signature {
        fs::write(staged.join(format!("{BUNDLE}.tar.sig")), signature).unwrap();
    }
}

/// What the installed launcher says when it is run.
fn launched(install: &Path) -> String {
    let launcher = install.join(BUNDLE).join("bin/launcher");
    // Another test's fork can hold the launcher open for writing until it execs.
    let out = (0..50)
        .find_map(|_| match Command::new(&launcher).output() {
            Err(e) if e.kind() == std::io::ErrorKind::ExecutableFileBusy => None,
            out => Some(out),
        })
        .expect("the launcher stayed busy")
        .expect("the installed bundle runs");
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

fn leftovers(install: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(install)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

#[test]
fn a_staged_bundle_with_a_valid_signature_replaces_the_installed_one() {
    let install = installed();
    stage(
        install.path(),
        &fixture("bundle.tar"),
        Some(&fixture("bundle.tar.sig")),
    );
    assert_eq!(
        apply_staged(install.path(), BUNDLE, &key()),
        Applied::Installed
    );
    assert_eq!(launched(install.path()), "0.131.0");
    assert_eq!(
        leftovers(install.path()),
        [".collie-update.lock", BUNDLE],
        "nothing staged is left"
    );
}

#[test]
fn nothing_staged_leaves_the_installed_bundle_alone() {
    let install = installed();
    assert_eq!(
        apply_staged(install.path(), BUNDLE, &key()),
        Applied::Nothing
    );
    assert_eq!(launched(install.path()), "0.130.0");
}

#[test]
fn a_bundle_whose_signature_does_not_match_is_refused_and_the_installed_one_remains() {
    let install = installed();
    let mut tar = fixture("bundle.tar");
    // The launcher's text, changed after it was signed.
    let at = tar.windows(7).position(|w| w == b"0.131.0").unwrap();
    tar[at] = b'9';
    stage(install.path(), &tar, Some(&fixture("bundle.tar.sig")));
    let Applied::Refused(why) = apply_staged(install.path(), BUNDLE, &key()) else {
        panic!("a tampered bundle was not refused");
    };
    assert!(why.contains("does not match its signature"), "{why}");
    assert_eq!(launched(install.path()), "0.130.0");
    assert_eq!(
        leftovers(install.path()),
        [".collie-update.lock", BUNDLE],
        "the refused bundle is thrown away"
    );
}

#[test]
fn a_bundle_signed_by_another_key_is_refused() {
    let install = installed();
    stage(
        install.path(),
        &fixture("bundle.tar"),
        Some(&fixture("bundle.tar.sig")),
    );
    let release = include_str!("../../../release.pub");
    assert!(matches!(
        apply_staged(install.path(), BUNDLE, release),
        Applied::Refused(_)
    ));
    assert_eq!(launched(install.path()), "0.130.0");
}

#[test]
fn an_unsigned_bundle_is_refused_and_the_installed_one_remains() {
    let install = installed();
    stage(install.path(), &fixture("bundle.tar"), None);
    let Applied::Refused(why) = apply_staged(install.path(), BUNDLE, &key()) else {
        panic!("an unsigned bundle was not refused");
    };
    assert!(why.contains("unsigned"), "{why}");
    assert_eq!(launched(install.path()), "0.130.0");
    assert_eq!(leftovers(install.path()), [".collie-update.lock", BUNDLE]);
}

#[test]
fn a_bundle_that_fails_halfway_through_unpacking_leaves_the_installed_one_runnable() {
    let install = installed();
    // Signed as it is, so it passes verification and fails as it is unpacked.
    stage(
        install.path(),
        &fixture("truncated.tar"),
        Some(&fixture("truncated.tar.sig")),
    );
    assert!(matches!(
        apply_staged(install.path(), BUNDLE, &key()),
        Applied::Refused(_)
    ));
    assert_eq!(launched(install.path()), "0.130.0");
    assert_eq!(
        leftovers(install.path()),
        [".collie-update.lock", BUNDLE],
        "the half-unpacked bundle is gone"
    );
}

#[test]
fn the_installed_and_unpacked_bundles_trade_places_in_one_step() {
    let install = installed();
    let next = install.path().join("next");
    fs::create_dir_all(next.join("bin")).unwrap();
    fs::write(next.join("bin/launcher"), "#!/bin/sh\necho 0.131.0\n").unwrap();
    fs::set_permissions(next.join("bin/launcher"), fs::Permissions::from_mode(0o755)).unwrap();
    exchange(&next, &install.path().join(BUNDLE)).unwrap();
    assert_eq!(launched(install.path()), "0.131.0");
    let old = fs::read_to_string(next.join("bin/launcher")).unwrap();
    assert!(old.contains("0.130.0"), "{old}");
}

#[test]
fn collies_release_key_is_one_the_shell_reads() {
    let install = installed();
    stage(install.path(), &fixture("bundle.tar"), Some(b"not base64"));
    let release = include_str!("../../../release.pub");
    let Applied::Refused(why) = apply_staged(install.path(), BUNDLE, release) else {
        panic!("not refused");
    };
    assert!(
        why.contains("does not match"),
        "the release key itself was refused: {why}"
    );
}

#[test]
fn the_install_and_bundle_are_found_from_the_running_shell() {
    use collie_desktop_update::installed_from;
    assert_eq!(
        installed_from(Path::new(
            "/data/dk.cego.collie.desktop/stable/app/bin/launcher"
        )),
        Some((
            Path::new("/data/dk.cego.collie.desktop/stable").into(),
            "app".into()
        ))
    );
    assert_eq!(
        installed_from(Path::new("/opt/collie/collie-desktop/collie-desktop")),
        Some((Path::new("/opt/collie").into(), "collie-desktop".into()))
    );
    assert_eq!(
        installed_from(Path::new(
            "/Applications/Collie.app/Contents/MacOS/collie-desktop"
        )),
        Some((Path::new("/Applications").into(), "Collie.app".into()))
    );
}

#[test]
fn a_signed_bundle_for_another_requested_version_does_not_replace_the_app() {
    let install = installed();
    stage(
        install.path(),
        &fixture("bundle.tar"),
        Some(&fixture("bundle.tar.sig")),
    );
    fs::write(install.path().join(".update/app.tar.json"), r#"{"version":"99.0.0","hash":"new0131","identifier":"dk.cego.collie.desktop","channel":"stable"}"#).unwrap();
    assert!(matches!(
        apply_staged(install.path(), BUNDLE, &key()),
        Applied::Refused(_)
    ));
    assert_eq!(launched(install.path()), "0.130.0");
}

#[test]
fn concurrent_launches_wait_for_the_install_lock_and_apply_an_update_once() {
    use std::os::fd::AsRawFd;
    use std::sync::{Arc, Barrier, mpsc};
    use std::time::Duration;

    let install = installed();
    stage(
        install.path(),
        &fixture("bundle.tar"),
        Some(&fixture("bundle.tar.sig")),
    );
    let lock = fs::File::create(install.path().join(".collie-update.lock")).unwrap();
    // SAFETY: the file remains open until after both launches finish.
    assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) }, 0);
    let ready = Arc::new(Barrier::new(3));
    let (send, receive) = mpsc::channel();
    std::thread::scope(|threads| {
        for _ in 0..2 {
            let (send, ready, path) = (send.clone(), ready.clone(), install.path());
            threads.spawn(move || {
                ready.wait();
                send.send(apply_staged(path, BUNDLE, &key())).unwrap();
            });
        }
        ready.wait();
        let premature = receive.recv_timeout(Duration::from_millis(100));
        // Release even if the assertion fails, so waiting launches can finish.
        assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_UN) }, 0);
        assert!(
            matches!(premature, Err(mpsc::RecvTimeoutError::Timeout)),
            "a launch ignored the installation lock: {premature:?}"
        );
    });
    let outcomes = [receive.recv().unwrap(), receive.recv().unwrap()];
    assert!(outcomes.contains(&Applied::Installed), "{outcomes:?}");
    assert!(outcomes.contains(&Applied::Relaunch), "{outcomes:?}");
    assert_eq!(launched(install.path()), "0.131.0");
    assert!(!install.path().join(".update").exists());
}

#[test]
fn a_launcher_moved_by_another_update_restarts_beside_the_installed_core() {
    let install = installed();
    stage(
        install.path(),
        &fixture("bundle.tar"),
        Some(&fixture("bundle.tar.sig")),
    );
    assert_eq!(
        apply_staged(install.path(), BUNDLE, &key()),
        Applied::Installed
    );
    // /proc/self/exe of the waiting Linux process points at the removed old bundle.
    let moved = install
        .path()
        .join(".update/unpacked/collie-desktop/bin/launcher (deleted)");
    let (root, bundle) = collie_desktop_update::installed_from(&moved).unwrap();
    assert_eq!(root, install.path());
    assert_eq!(bundle, BUNDLE);
    let launcher = root.join(bundle).join("bin/launcher");
    assert_eq!(
        String::from_utf8(Command::new(&launcher).output().unwrap().stdout)
            .unwrap()
            .trim(),
        "0.131.0"
    );
    assert!(
        Command::new(launcher.parent().unwrap().join("collie-core"))
            .status()
            .unwrap()
            .success()
    );
}
