//! Reads NDJSON frames on stdin, each through the Rust types, and writes them back on stdout:
//! the Rust half of `test/rune-contract.test.ts`.

use collie_desktop_protocol::rpc::{Exit, FromCore, Reason, ToCore};
use collie_desktop_protocol::spoken::{Part, retyped};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut tags = HashMap::new();
    let mut out = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let frame: Value = serde_json::from_str(&line?)?;
        let to_core = matches!(
            frame["_tag"].as_str(),
            Some("Hello" | "Request" | "Ack" | "Interrupt")
        );
        let written = if to_core {
            let mut frame: ToCore = serde_json::from_value(frame)?;
            if let ToCore::Request {
                id, tag, payload, ..
            } = &mut frame
            {
                tags.insert(*id, tag.clone());
                *payload = retyped(tag, Part::Payload, payload.take())?;
            }
            serde_json::to_string(&frame)?
        } else {
            let mut frame: FromCore = serde_json::from_value(frame)?;
            match &mut frame {
                FromCore::Chunk { request_id, values } => {
                    let tag = &tags[request_id];
                    for value in values {
                        *value = retyped(tag, Part::Chunk, value.take())?;
                    }
                }
                FromCore::Exit { request_id, exit } => {
                    let tag = &tags[request_id];
                    match exit {
                        Exit::Success { value: Some(value) } => {
                            *value = retyped(tag, Part::Done, value.take())?;
                        }
                        Exit::Failure { cause } => {
                            for reason in cause {
                                if let Reason::Fail { error } = reason {
                                    *error = retyped(tag, Part::Error, error.take())?;
                                }
                            }
                        }
                        Exit::Success { value: None } => {}
                    }
                }
                _ => {}
            }
            serde_json::to_string(&frame)?
        };
        writeln!(out, "{written}")?;
    }
    Ok(())
}
