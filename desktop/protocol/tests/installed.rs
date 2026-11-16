use collie_desktop_protocol::core::channel_root;
use std::path::Path;

#[test]
fn linux_keeps_the_installed_channel_and_uses_the_existing_stable_data_for_a_checkout() {
    let home = Path::new("/home/test");
    assert_eq!(
        channel_root(
            home,
            Some("/data".into()),
            false,
            Path::new("/data/dk.cego.collie.desktop/collie-desktop/app/bin/launcher")
        ),
        Path::new("/data/dk.cego.collie.desktop/collie-desktop")
    );
    assert_eq!(
        channel_root(
            home,
            Some("relative".into()),
            false,
            Path::new("/checkout/target/debug/collie-desktop-board")
        ),
        home.join(".local/share/dk.cego.collie.desktop/stable")
    );
}

#[test]
fn macos_prefers_the_current_update_in_a_legacy_root_over_another_install_marker() {
    let dir = std::env::temp_dir().join(format!("collie-channel-{}", std::process::id()));
    let identity = dir.join("Library/Application Support/dk.cego.collie.desktop");
    let legacy = identity.join("collie-desktop");
    std::fs::create_dir_all(identity.join("stable")).unwrap();
    std::fs::write(identity.join("stable/.electrobun-uninstall.json"), "{}").unwrap();
    std::fs::create_dir_all(legacy.join("self-extraction")).unwrap();
    std::fs::write(legacy.join("self-extraction/newhash.tar"), "retained").unwrap();
    let app = dir.join("Applications/collie-desktop.app");
    std::fs::create_dir_all(app.join("Contents/Resources")).unwrap();
    std::fs::write(
        app.join("Contents/Resources/version.json"),
        r#"{"hash":"newhash"}"#,
    )
    .unwrap();
    assert_eq!(
        channel_root(&dir, None, true, &app.join("Contents/MacOS/launcher")),
        legacy
    );
    std::fs::remove_file(legacy.join("self-extraction/newhash.tar")).unwrap();
    assert_eq!(
        channel_root(&dir, None, true, &app.join("Contents/MacOS/launcher")),
        identity.join("stable")
    );
    std::fs::remove_dir_all(&dir).unwrap();
}
