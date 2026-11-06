//! Effect RPC's frames as `RpcSerialization.layerNdjson` writes them, one JSON object a line:
//! `FromClientEncoded` and Desktop's `Hello` to the core, `FromServerEncoded` from it.
//! Payloads, values and errors stay JSON here; [`crate::spoken`] gives them their types.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum ToCore {
    /// Sent first, so the core ends whatever an earlier shell left running.
    Hello,
    Request {
        id: u64,
        tag: String,
        payload: Value,
        headers: Vec<(String, String)>,
    },
    Ack {
        #[serde(rename = "requestId")]
        request_id: u64,
    },
    Interrupt {
        #[serde(rename = "requestId")]
        request_id: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum FromCore {
    Chunk {
        #[serde(rename = "requestId")]
        request_id: u64,
        values: Vec<Value>,
    },
    Exit {
        #[serde(rename = "requestId")]
        request_id: u64,
        exit: Exit,
    },
    Defect {
        defect: Value,
    },
    Pong,
    ClientProtocolError {
        error: Value,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum Exit {
    Success {
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "present"
        )]
        value: Option<Value>,
    },
    Failure {
        cause: Vec<Reason>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum Reason {
    Fail {
        error: Value,
    },
    Die {
        defect: Value,
    },
    Interrupt {
        #[serde(rename = "fiberId", default)]
        fiber_id: Option<Value>,
    },
}

/// A key that is there, even holding `null`, is `Some`.
fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}
