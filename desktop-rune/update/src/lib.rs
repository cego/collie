//! Installs at launch the update Desktop's main process staged, `<install>/.update/<bundle>.tar`
//! with its `.sig`: verified as `src/signing.ts` verifies a release, and only then swapped in.

use base64::Engine;
use ed25519_dalek::pkcs8::DecodePublicKey;
use ed25519_dalek::{Signature, VerifyingKey};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub enum Applied {
    Nothing,
    Installed,
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
        .or_else(|| exe.parent())?;
    Some((
        bundle.parent()?.to_path_buf(),
        bundle.file_name()?.to_str()?.to_string(),
    ))
}

pub fn apply_staged(install: &Path, bundle: &str, release_key: &str) -> Applied {
    let staged = install.join(".update");
    let installed = install.join(bundle);
    let aside = staged.join("previous");
    // A swap cut off between its two renames left the installed bundle aside.
    if !installed.exists() && aside.exists() {
        let _ = fs::rename(&aside, &installed);
    }
    let Ok(tar) = fs::read(staged.join(format!("{bundle}.tar"))) else {
        return Applied::Nothing;
    };
    let signature = fs::read_to_string(staged.join(format!("{bundle}.tar.sig"))).ok();
    let applied = match verify(&tar, signature.as_deref(), release_key) {
        Err(why) => Applied::Refused(why),
        Ok(()) => match swap(&tar, &staged, &installed, &aside, bundle) {
            Ok(()) => Applied::Installed,
            Err(e) => Applied::Refused(format!("it could not be installed: {e}")),
        },
    };
    // Kept where the installed bundle is still aside, for the next launch to put back.
    if installed.exists() {
        let _ = fs::remove_dir_all(&staged);
    }
    applied
}

fn swap(tar: &[u8], staged: &Path, installed: &Path, aside: &Path, bundle: &str) -> io::Result<()> {
    let unpacked = staged.join("unpacked");
    let _ = fs::remove_dir_all(&unpacked);
    tar::Archive::new(tar).unpack(&unpacked)?;
    let next = unpacked.join(bundle);
    if !next.is_dir() {
        return Err(io::Error::other(format!("the update holds no {bundle}")));
    }
    let _ = fs::remove_dir_all(aside);
    fs::rename(installed, aside)?;
    if let Err(e) = fs::rename(&next, installed) {
        fs::rename(aside, installed)?;
        return Err(e);
    }
    Ok(())
}
