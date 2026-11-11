//! What the chat needs of the app it sits in: its own state, and the Desktop core to call.

use crate::chat::Chat;
use collie_desktop_protocol::generated::About;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// A request's answer, applied on the view's thread.
pub type Done<S> = Box<dyn FnOnce(&mut S, Result<Value, String>) + Send>;
/// Each value of a stream, and the error that ends it, applied on the view's thread.
pub type Each<S> = Box<dyn FnMut(&mut S, Result<Value, String>) + Send>;
/// Ends a stream; nothing more of it is heard.
pub type Stop = Box<dyn FnOnce() + Send>;

/// The app around the chat: the main window's, or the chat's own popped-out window's.
pub trait Host: Sized + 'static {
    fn chat(&self) -> &Chat;
    fn chat_mut(&mut self) -> &mut Chat;
    /// Asks the core `tag` once; without a core nothing is asked.
    fn request(&self, tag: &str, payload: Value, done: Done<Self>);
    /// Subscribes to `tag`; none without a core.
    fn stream(&self, tag: &str, payload: Value, each: Each<Self>) -> Option<Stop>;
    /// A text delta of the `turn`th turn arrived, for the app's timing marks.
    fn heard_chunk(&mut self, _turn: u64) {}
    /// The human pressed the card a message was sent about.
    fn open_about(&mut self, _about: &About) {}
    /// The chat went to its own window (`out`) or came back beside the board.
    fn popped(&mut self, _out: bool) {}
}

/// Asks `tag` with a typed payload and answer.
pub fn ask<S: Host, A: DeserializeOwned>(
    s: &S,
    tag: &str,
    payload: impl Serialize,
    done: impl FnOnce(&mut S, Result<A, String>) + Send + 'static,
) {
    let payload = serde_json::to_value(payload).unwrap_or(Value::Null);
    s.request(
        tag,
        payload,
        Box::new(move |s, answer| done(s, answer.and_then(decoded))),
    );
}

/// Subscribes to `tag` with typed values.
pub fn listen<S: Host, A: DeserializeOwned>(
    s: &S,
    tag: &str,
    payload: impl Serialize,
    mut each: impl FnMut(&mut S, Result<A, String>) + Send + 'static,
) -> Option<Stop> {
    let payload = serde_json::to_value(payload).unwrap_or(Value::Null);
    s.stream(
        tag,
        payload,
        Box::new(move |s, value| each(s, value.and_then(decoded))),
    )
}

fn decoded<A: DeserializeOwned>(value: Value) -> Result<A, String> {
    serde_json::from_value(value)
        .map_err(|e| format!("Desktop's core answered in a shape the chat can't read: {e}"))
}
