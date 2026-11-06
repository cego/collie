//! The RPCs the spike speaks, each part read through its generated type and written back,
//! so whatever a type lacks is dropped as it would be in the shell.

use crate::generated::{ActionFailed, FlockItem, SyncNowPayload, SyncNowSuccess};
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

/// `value` as the RPC `tag`'s `part` reads it; a part the spike does not type is kept as is.
pub fn retyped(tag: &str, part: Part, value: Value) -> serde_json::Result<Value> {
    match (tag, part) {
        ("flock", Part::Chunk) => through::<FlockItem>(value),
        ("syncNow", Part::Payload) => through::<SyncNowPayload>(value),
        ("syncNow", Part::Done) => through::<SyncNowSuccess>(value),
        ("syncNow", Part::Error) => through::<ActionFailed>(value),
        _ => Ok(value),
    }
}
