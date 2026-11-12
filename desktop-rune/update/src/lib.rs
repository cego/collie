//! Installs at launch the update Desktop's main process staged, `<install>/.update/<bundle>.tar`
//! with its `.sig`: verified as `src/signing.ts` verifies a release, and only then swapped in.

use base64::Engine;
use ed25519_dalek::pkcs8::DecodePublicKey;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Deserialize, PartialEq, Eq)]
struct Identity {
    identifier: String,
    channel: String,
    version: String,
    hash: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Applied {
    Nothing,
    Installed,
    /// Another launcher consumed the staged update while this one waited.
    Relaunch,
    Refused(String),
}

const REFUSED: &str =
    "the download does not match its signature from Collie's release key, so it was refused";

/// `src/signing.ts`'s `verifyRelease`: a detached Ed25519 signature, base64.
pub fn verify(bytes: &[u8], signature: Option<&str>, release_key: &str) -> Result<(), String> {
    let signature = signature
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("the download is unsigned, so it was refused")?;
    let key = VerifyingKey::from_public_key_pem(release_key.trim())
        .map_err(|e| format!("the release key cannot be read: {e}"))?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(signature)
        .map_err(|_| REFUSED)?;
    let signature = Signature::from_slice(&decoded).map_err(|_| REFUSED)?;
    key.verify_strict(bytes, &signature)
        .map_err(|_| REFUSED.into())
}

/// The install directory and the bundle in it, from the shell's own path: on Linux
/// `<install>/<bundle>/collie-desktop`, on macOS `<install>/Collie.app/Contents/MacOS/…`.
pub fn installed_from(exe: &Path) -> Option<(PathBuf, String)> {
    let bundle = exe
        .ancestors()
        .find(|dir| dir.extension().is_some_and(|ext| ext == "app"))
        .or_else(|| {
            let parent = exe.parent()?;
            if parent.file_name()? == "bin" {
                parent.parent()
            } else {
                Some(parent)
            }
        })?;
    // Linux reports a running executable's new path after an exchange, even after that
    // old bundle was deleted. A launch caught there still restarts from the installed app.
    if let Some(unpacked) = bundle.parent()
        && unpacked.file_name()? == "unpacked"
        && unpacked.parent()?.file_name()? == ".update"
    {
        let install = unpacked.parent()?.parent()?;
        let name = if install.join("app/bin/launcher").is_file() {
            "app".to_string()
        } else {
            bundle.file_name()?.to_str()?.to_string()
        };
        return Some((install.into(), name));
    }
    Some((
        bundle.parent()?.to_path_buf(),
        bundle.file_name()?.to_str()?.to_string(),
    ))
}

pub fn apply_staged(install: &Path, bundle: &str, release_key: &str) -> Applied {
    let staged = install.join(".update");
    let archive = staged.join(format!("{bundle}.tar"));
    let pending = archive.is_file();
    // Keep the lock outside .update: removing a locked file lets a later launcher acquire
    // a different inode while an earlier launcher still holds the original one.
    let _lock = match lock_install(install) {
        Ok(lock) => lock,
        Err(e) => return Applied::Refused(format!("the installation could not be locked: {e}")),
    };
    let installed = install.join(bundle);
    let Ok(tar) = fs::read(archive) else {
        return if pending {
            Applied::Relaunch
        } else {
            Applied::Nothing
        };
    };
    let signature = fs::read_to_string(staged.join(format!("{bundle}.tar.sig"))).ok();
    let applied = match verify(&tar, signature.as_deref(), release_key) {
        Err(why) => Applied::Refused(why),
        Ok(()) => match swap(&tar, &staged, &installed, bundle) {
            Ok(()) => Applied::Installed,
            Err(e) => Applied::Refused(format!("it could not be installed: {e}")),
        },
    };
    // Holds the bundle the swap replaced, or a refused one.
    let _ = fs::remove_dir_all(&staged);
    applied
}

fn lock_install(install: &Path) -> io::Result<fs::File> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(install.join(".collie-update.lock"))?;
    loop {
        // SAFETY: the descriptor is valid. Dropping the File releases this process's lock.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } == 0 {
            return Ok(lock);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn swap(tar: &[u8], staged: &Path, installed: &Path, bundle: &str) -> io::Result<()> {
    let expected: Identity =
        serde_json::from_slice(&fs::read(staged.join(format!("{bundle}.tar.json")))?)?;
    let unpacked = staged.join("unpacked");
    let _ = fs::remove_dir_all(&unpacked);
    tar::Archive::new(tar).unpack(&unpacked)?;
    // The stable Linux installer calls its installed bundle `app`.
    let next = unpacked.join(if bundle == "app" {
        "collie-desktop"
    } else {
        bundle
    });
    if !next.is_dir() {
        return Err(io::Error::other(format!("the update holds no {bundle}")));
    }
    let resources = if bundle.ends_with(".app") {
        "Contents/Resources"
    } else {
        "Resources"
    };
    let actual: Identity =
        serde_json::from_slice(&fs::read(next.join(resources).join("version.json"))?)?;
    if actual != expected
        || actual.identifier != "dk.cego.collie.desktop"
        || actual.channel != "stable"
    {
        return Err(io::Error::other(
            "the signed bundle does not match the requested Collie update",
        ));
    }
    let executables = if bundle.ends_with(".app") {
        "Contents/MacOS"
    } else {
        "bin"
    };
    for name in ["launcher", "collie-core"] {
        use std::os::unix::fs::PermissionsExt;
        let file = fs::symlink_metadata(next.join(executables).join(name))?;
        if !file.is_file() || file.permissions().mode() & 0o111 == 0 {
            return Err(io::Error::other(
                "the update has no runnable shell and core",
            ));
        }
    }
    exchange(&next, installed)
}

/// Swaps `a` and `b` in one rename, so neither path is ever missing.
pub fn exchange(a: &Path, b: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let path = |p: &Path| CString::new(p.as_os_str().as_bytes()).map_err(io::Error::other);
    let (a, b) = (path(a)?, path(b)?);
    // SAFETY: both are NUL-terminated paths that outlive the call.
    #[cfg(target_os = "linux")]
    let done = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            a.as_ptr(),
            libc::AT_FDCWD,
            b.as_ptr(),
            libc::RENAME_EXCHANGE,
        )
    };
    // SAFETY: as above.
    #[cfg(target_os = "macos")]
    let done = unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_SWAP) };
    if done == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
