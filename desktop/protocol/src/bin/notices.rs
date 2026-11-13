//! Reads the core's stdout on stdin and prints each notification it asks the shell for, as
//! JSON: the Rust half of `test/rune-shell.test.ts`.

use collie_desktop_protocol::client::Client;
use std::io::{BufReader, Write};

fn main() {
    let client = Client::new(BufReader::new(std::io::stdin()), std::io::sink()).expect("a client");
    let mut out = std::io::stdout().lock();
    for notice in client.notices().into_iter().flatten() {
        serde_json::to_writer(&mut out, &notice).expect("written");
        out.write_all(b"\n").expect("written");
    }
}
