//! The RPCs the spike speaks, each part read through its generated type and written back,
//! so whatever a type lacks is dropped as it would be in the shell.

use crate::generated::{
    ActionFailed, AguiEvent, FlockItem, SayPayload, SyncNowPayload, SyncNowSuccess,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    Payload,
    /// A value of a stream's chunk.
    Chunk,
    /// What a successful exit carries: void for a stream.
    Done,
    Error,
}

fn through<T: DeserializeOwned + Serialize>(value: Value) -> serde_json::Result<Value> {
    serde_json::to_value(serde_json::from_value::<T>(value)?)
}

/// `value` as the RPC `tag`'s `part` reads it; a part the spike does not type is refused, so
/// the contract test cannot pass it through untyped.
pub fn retyped(tag: &str, part: Part, value: Value) -> serde_json::Result<Value> {
    match (tag, part) {
        // A stream ends with void, as `flock`'s payload is.
        ("flock" | "say", Part::Done) | ("flock", Part::Payload) => through::<()>(value),
        ("flock", Part::Chunk) => through::<FlockItem>(value),
        ("syncNow", Part::Payload) => through::<SyncNowPayload>(value),
        ("syncNow", Part::Done) => through::<SyncNowSuccess>(value),
        ("syncNow", Part::Error) => through::<ActionFailed>(value),
        ("say", Part::Payload) => through::<SayPayload>(value),
        ("say", Part::Chunk) => through::<AguiEvent>(value),
        ("artefacts", Part::Payload) => through::<crate::generated::ArtefactsPayload>(value),
        ("artefacts", Part::Done) => through::<crate::generated::ArtefactCollection>(value),
        ("artefactRead", Part::Payload) => through::<crate::generated::ArtefactReadPayload>(value),
        ("artefactRead", Part::Done) => through::<crate::generated::RunFile>(value),
        ("artefactSeen", Part::Payload) => through::<crate::generated::ArtefactSeenPayload>(value),
        ("artefactSeen", Part::Done) => through::<crate::generated::Artefact>(value),
        ("artefactRegister", Part::Payload) => {
            through::<crate::generated::ArtefactRegisterPayload>(value)
        }
        ("artefactImport", Part::Payload) => {
            through::<crate::generated::ArtefactImportPayload>(value)
        }
        ("artefactRegister" | "artefactImport", Part::Done) => {
            through::<crate::generated::ArtefactRegistered>(value)
        }
        ("artefacts" | "artefactRead" | "artefactSeen" | "artefactRegister" | "artefactImport", Part::Error) => {
            through::<ActionFailed>(value)
        }
        _ => Err(serde::de::Error::custom(format!(
            "{tag}'s {part:?} has no Rust type"
        ))),
    }
}
