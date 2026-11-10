//! `DesktopRpcs` as the Rune shell speaks it to Desktop's main process: the generated types,
//! Effect RPC's envelope, and an NDJSON client over the core's stdio.

pub mod client;
pub mod core;
/// Included, not a module file, so `cargo fmt` leaves the generator's output as it wrote it.
#[allow(clippy::large_enum_variant)]
pub mod generated {
    include!("generated.rs");
}
pub mod rpc;
pub mod spoken;

/// A field both optional and nullable: absent is `None`, `null` is `Some(None)`.
pub(crate) mod double_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<T: Serialize, S: Serializer>(
        value: &Option<Option<T>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        value
            .as_ref()
            .map(Option::as_ref)
            .unwrap_or(None)
            .serialize(serializer)
    }

    pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}
