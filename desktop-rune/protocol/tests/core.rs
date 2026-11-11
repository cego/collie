//! The core started as the shell starts it keeps Desktop's state apart from a Desktop beside
//! it, while what it spawns sees the user's own state directory. Needs `bun` and `bun install`.

use collie_desktop_protocol::core::Core;
use collie_desktop_protocol::generated::{StagePathsPayload, StagedOrRefusedItem};
use serde_json::Value;

#[test]
fn the_core_keeps_desktops_state_apart_and_its_children_see_the_users() {
    let dir = std::env::temp_dir().join(format!("collie-rune-core-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let state = dir.join("state");
    let saw = dir.join("login-shell-saw");
    // Desktop's first child: the login shell it reads its environment from.
    let shell = dir.join("login-shell");
    std::fs::write(
        &shell,
        format!(
            "#!/bin/sh\nprintf '%s' \"$XDG_STATE_HOME\" > '{}'\nexit 1\n",
            saw.display()
        ),
    )
    .unwrap();
    // `collie bridge` as Desktop starts it: it never answers, so no Machine is reached.
    let bridge = dir.join("fake-bridge");
    std::fs::write(&bridge, "#!/bin/sh\nexec cat >/dev/null\n").unwrap();
    for script in [&shell, &bridge] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    // SAFETY: this file's only test, set before the core or any thread starts.
    unsafe {
        std::env::set_var("HOME", &dir);
        std::env::set_var("XDG_STATE_HOME", &state);
    }
    let collie = serde_json::to_string(&[bridge.to_str().unwrap()]).unwrap();
    let core = Core::start_with(&[
        ("SHELL", shell.as_os_str()),
        ("COLLIE_DESKTOP_COLLIE", collie.as_ref()),
    ]);
    // A file attached to the chat is kept in Desktop's own state.
    let attached = dir.join("notes.txt");
    std::fs::write(&attached, "attached").unwrap();
    let staged = core.client.request::<_, Vec<StagedOrRefusedItem>, Value>(
        "stagePaths",
        StagePathsPayload {
            paths: vec![attached.to_string_lossy().into_owned()],
        },
    );
    let heard = std::fs::read_to_string(&saw);
    core.stop();

    assert!(matches!(
        staged.expect("staged").as_slice(),
        [StagedOrRefusedItem::StagedOrRefusedItem0(_)]
    ));
    assert!(
        state
            .join("collie-desktop-rune-spike/state/collie-desktop/attachments")
            .is_dir()
    );
    assert!(!state.join("collie-desktop").exists());
    assert_eq!(heard.expect("the login shell ran"), state.to_str().unwrap());
    let _ = std::fs::remove_dir_all(&dir);
}
