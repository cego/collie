//! A dialog that picks several files (ADR-draft-collie-desktop-is-drawn-by-rune D2), which
//! Rune's own `open_file` does not: the XDG desktop portal's FileChooser with `multiple` on
//! Linux, rfd's panel on macOS. It blocks, so Linux calls it off the view's thread.

use std::path::PathBuf;

/// The files chosen; none where the human cancelled.
pub fn pick_files(title: &str) -> Result<Vec<PathBuf>, String> {
    imp::pick_files(title)
}

/// A `file://` URI's local path, as the portal answers.
pub fn uri_path(uri: &str) -> Option<PathBuf> {
    crate::attachments::uri_list_paths(uri).0.into_iter().next()
}

#[cfg(target_os = "linux")]
mod imp {
    use super::uri_path;
    use futures_util::StreamExt;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::time::Duration;
    use zbus::{Connection, Proxy};
    use zbus::{OwnedObjectPath, OwnedVariant as OwnedValue, Variant as Value};

    const DEST: &str = "org.freedesktop.portal.Desktop";
    const PATH: &str = "/org/freedesktop/portal/desktop";

    pub fn pick_files(title: &str) -> Result<Vec<PathBuf>, String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        runtime.block_on(ask(title))
    }

    fn said(e: zbus::Error) -> String {
        format!("The file dialog could not open: {e}")
    }

    async fn ask(title: &str) -> Result<Vec<PathBuf>, String> {
        let conn = Connection::session().await.map_err(said)?;
        let portal = Proxy::new(&conn, DEST, PATH, "org.freedesktop.portal.FileChooser")
            .await
            .map_err(said)?;
        let token = format!("collie_chat_{}", std::process::id());
        let sender = conn
            .unique_name()
            .ok_or("The file dialog could not open: no bus name")?
            .trim_start_matches(':')
            .replace('.', "_");
        let path = format!("{PATH}/request/{sender}/{token}");
        let request = Proxy::new(&conn, DEST, path.as_str(), "org.freedesktop.portal.Request")
            .await
            .map_err(said)?;
        let mut responses = request.receive_signal("Response").await.map_err(said)?;
        let options: HashMap<&str, Value> = HashMap::from([
            ("handle_token", Value::from(token.as_str())),
            ("multiple", Value::from(true)),
            ("modal", Value::from(true)),
        ]);
        let handle: OwnedObjectPath = tokio::time::timeout(
            Duration::from_secs(30),
            portal.call("OpenFile", &("", title, options)),
        )
        .await
        .map_err(|_| "The file dialog did not open in time".to_string())?
        .map_err(said)?;
        if handle.as_str() != path {
            let request = Proxy::new(
                &conn,
                DEST,
                handle.as_str(),
                "org.freedesktop.portal.Request",
            )
            .await
            .map_err(said)?;
            responses = request.receive_signal("Response").await.map_err(said)?;
        }
        let message = responses
            .next()
            .await
            .ok_or("The file dialog closed without an answer")?;
        let (status, results): (u32, HashMap<String, OwnedValue>) =
            message.body().deserialize().map_err(said)?;
        if status != 0 {
            return Ok(Vec::new());
        }
        let uris: Vec<String> = results
            .get("uris")
            .and_then(|v| v.try_clone().ok())
            .and_then(|v| Vec::<String>::try_from(v).ok())
            .unwrap_or_default();
        Ok(uris.iter().filter_map(|uri| uri_path(uri)).collect())
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::path::PathBuf;

    pub fn pick_files(title: &str) -> Result<Vec<PathBuf>, String> {
        Ok(rfd::FileDialog::new()
            .set_title(title)
            .pick_files()
            .unwrap_or_default())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod imp {
    use std::path::PathBuf;

    pub fn pick_files(_: &str) -> Result<Vec<PathBuf>, String> {
        Err("This platform has no dialog for several files".into())
    }
}
