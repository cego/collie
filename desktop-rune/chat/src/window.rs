//! The chat in its own window, popped out of the board's (`app.vue`'s `#chat` window). It
//! reaches the core through what the app hands it, and tells the board's window when it closes.

use crate::chat::{self, Chat};
use crate::host::{Done, Each, Host, Stop};
use collie_desktop_protocol::generated::About;
use rune::{Cx, El, Tx};
use serde_json::Value;

pub type Request = Box<dyn Fn(&str, Value, Done<Alone>)>;
pub type Streams = Box<dyn Fn(&str, Value, Each<Alone>) -> Stop>;

#[derive(Default)]
pub struct Alone {
    pub chat: Chat,
    pub request: Option<Request>,
    pub stream: Option<Streams>,
    /// Tells the board's window that the chat is back beside it.
    pub back: Option<Box<dyn Fn()>>,
    /// Asks the board's window to open the card a message is about; only it opens one.
    pub about: Option<Box<dyn Fn(About)>>,
}

impl Host for Alone {
    fn chat(&self) -> &Chat {
        &self.chat
    }

    fn chat_mut(&mut self) -> &mut Chat {
        &mut self.chat
    }

    fn request(&self, tag: &str, payload: Value, done: Done<Self>) {
        if let Some(request) = &self.request {
            request(tag, payload, done);
        }
    }

    fn stream(&self, tag: &str, payload: Value, each: Each<Self>) -> Option<Stop> {
        self.stream
            .as_ref()
            .map(|stream| stream(tag, payload, each))
    }

    fn open_about(&mut self, about: &About) -> Option<String> {
        if let Some(open) = &self.about {
            open(about.clone());
        }
        None
    }
}

/// The window opened: the chat reads its conversation there.
pub fn opened(s: &mut Alone) {
    s.chat.alone = true;
    s.chat.popped = true;
    chat::open(s);
}

/// The window closed: its subscriptions and any reply end, and the chat is back beside the
/// board.
pub fn closed(s: &mut Alone, _: &mut Tx) {
    chat::close(s);
    s.chat.popped = false;
    if let Some(back) = &s.back {
        back();
    }
}

pub fn view(s: &Alone, cx: &mut Cx<Alone>) -> El {
    let k = rune_theme_opencode::kit(cx.system_dark());
    let mut layer = Vec::new();
    let pane = crate::pane::chat::<Alone>(&s.chat, k, &mut layer);
    rune_kit::root(pane, layer)
}
