//! The view's calls to the Desktop core: any `DesktopRpcs` RPC by its tag, answered off the
//! view's thread and applied to the app on it.

use collie_desktop_protocol::client::{Client, RpcError};
use collie_desktop_protocol::log;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex};

/// Why a call has no answer, in words a person can read.
#[derive(Debug, Clone, PartialEq)]
pub struct CallError(pub String);

impl fmt::Display for CallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A call's failure as the core told it: its reason, and whether the host said no, so that
/// sending the same request again changes nothing.
#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub said: String,
    pub refused: bool,
}

impl From<CallError> for Failure {
    fn from(error: CallError) -> Self {
        Failure {
            said: error.0,
            refused: false,
        }
    }
}

impl From<Failure> for CallError {
    fn from(failure: Failure) -> Self {
        CallError(failure.said)
    }
}

pub type Answer = Box<dyn FnOnce(Result<Value, Failure>) + Send>;
pub type Each = Box<dyn FnMut(Result<Value, Failure>) + Send>;
/// Ends a stream; its subscriber hears nothing after.
pub type Stop = Box<dyn FnOnce() + Send>;
/// Runs once where a stream ends without an error, or the core interrupts it; never after
/// its Stop.
pub type Ended = Box<dyn FnOnce() + Send>;

/// The core as the view reaches it: the live one over stdio, or a test's fake.
pub trait Calls: Send + Sync {
    fn request(&self, tag: &str, payload: Value, answer: Answer);
    fn stream(&self, tag: &str, payload: Value, each: Each, ended: Ended) -> Stop;
}

/// Hands a change to the app to the view's thread.
pub type Post<S> = Arc<dyn Fn(Box<dyn FnOnce(&mut S) + Send>) + Send + Sync>;

pub struct Core<S> {
    calls: Arc<dyn Calls>,
    post: Post<S>,
}

impl<S> Clone for Core<S> {
    fn clone(&self) -> Self {
        Core {
            calls: self.calls.clone(),
            post: self.post.clone(),
        }
    }
}

fn typed<A: DeserializeOwned>(answer: Result<Value, Failure>) -> Result<A, Failure> {
    answer.and_then(|value| {
        serde_json::from_value(value).map_err(|e| Failure {
            said: format!("Desktop's core answered in a shape this app can't read: {e}"),
            refused: false,
        })
    })
}

impl<S: 'static> Core<S> {
    pub fn new(calls: Arc<dyn Calls>, post: Post<S>) -> Self {
        Core { calls, post }
    }

    /// Asks `tag` once; `done` runs on the view's thread with the answer.
    pub fn request<P: Serialize, A: DeserializeOwned + Send + 'static>(
        &self,
        tag: &str,
        payload: P,
        done: impl FnOnce(&mut S, Result<A, CallError>) + Send + 'static,
    ) {
        self.request_refusable(tag, payload, |s, answer: Result<A, Failure>| {
            done(s, answer.map_err(CallError::from))
        });
    }

    /// Asks `tag` once, as `request` does, telling a host's refusal from any other failure.
    pub fn request_refusable<P: Serialize, A: DeserializeOwned + Send + 'static>(
        &self,
        tag: &str,
        payload: P,
        done: impl FnOnce(&mut S, Result<A, Failure>) + Send + 'static,
    ) {
        let post = self.post.clone();
        let payload = serde_json::to_value(payload).unwrap_or(Value::Null);
        let rpc = tag.to_string();
        self.calls.request(
            tag,
            payload,
            Box::new(move |answer| {
                let answer = typed(answer);
                if let Err(failed) = &answer {
                    let what = if failed.refused {
                        "request refused"
                    } else {
                        "request failed"
                    };
                    log::event("calls", what, Some(&failed.said), &[("rpc", &rpc)]);
                }
                post(Box::new(move |s| done(s, answer)));
            }),
        );
    }

    /// Subscribes to `tag`; `each` runs on the view's thread for every value, and once with
    /// the error that ends it.
    pub fn stream<P: Serialize, A: DeserializeOwned + Send + 'static>(
        &self,
        tag: &str,
        payload: P,
        each: impl FnMut(&mut S, Result<A, CallError>) + Send + 'static,
    ) -> Stop {
        self.stream_until(tag, payload, each, |_| {})
    }

    /// `stream`, with `ended` run on the view's thread where the stream ends without an error
    /// or the core interrupts it: not after its Stop.
    pub fn stream_until<P: Serialize, A: DeserializeOwned + Send + 'static>(
        &self,
        tag: &str,
        payload: P,
        each: impl FnMut(&mut S, Result<A, CallError>) + Send + 'static,
        ended: impl FnOnce(&mut S) + Send + 'static,
    ) -> Stop {
        let post = self.post.clone();
        let each = Arc::new(Mutex::new(each));
        let payload = serde_json::to_value(payload).unwrap_or(Value::Null);
        let (rpc, ends, posts) = (tag.to_string(), tag.to_string(), self.post.clone());
        self.calls.stream(
            tag,
            payload,
            Box::new(move |value| {
                if let Err(failed) = &value {
                    log::event(
                        "calls",
                        "stream failed",
                        Some(&failed.said),
                        &[("rpc", &rpc)],
                    );
                }
                let value = typed(value).map_err(CallError::from);
                let each = each.clone();
                post(Box::new(move |s| (each.lock().unwrap())(s, value)));
            }),
            Box::new(move || {
                log::event("calls", "stream ended", None, &[("rpc", &ends)]);
                posts(Box::new(move |s| ended(s)));
            }),
        )
    }
}

/// An RPC's failure as its reason, where its error carries one, and its `refused`.
pub fn said(error: RpcError<Value>) -> Failure {
    match error {
        RpcError::Failed(failed) => Failure {
            said: ["reason", "message"]
                .iter()
                .find_map(|key| failed.get(key).and_then(Value::as_str).map(String::from))
                .unwrap_or_else(|| failed.to_string()),
            refused: failed.get("refused").and_then(Value::as_bool) == Some(true),
        },
        other => Failure {
            said: other.to_string(),
            refused: false,
        },
    }
}

/// The live core: each call answered on a thread of its own.
pub struct Live(pub Client);

impl Calls for Live {
    fn request(&self, tag: &str, payload: Value, answer: Answer) {
        let (client, tag) = (self.0.clone(), tag.to_string());
        std::thread::spawn(move || {
            answer(
                client
                    .request::<_, Value, Value>(&tag, payload)
                    .map_err(said),
            );
        });
    }

    fn stream(&self, tag: &str, payload: Value, mut each: Each, ended: Ended) -> Stop {
        let values = self.0.stream::<_, Value, Value>(tag, payload);
        let release = values.release();
        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stops = stopped.clone();
        let is_stopped = move || stopped.load(std::sync::atomic::Ordering::SeqCst);
        std::thread::spawn(move || {
            for value in values {
                if is_stopped() {
                    return;
                }
                match value {
                    // The core cut it off: it ended, as one that ends without an error.
                    Err(RpcError::Interrupted) => break,
                    value => each(value.map_err(said)),
                }
            }
            if !is_stopped() {
                ended();
            }
        });
        Box::new(move || {
            stops.store(true, std::sync::atomic::Ordering::SeqCst);
            release.interrupt()
        })
    }
}

/// A core a test answers by hand, and the app's changes queued until the test applies them.
pub mod testing {
    use super::*;

    type Subscriber = (String, Arc<Mutex<Option<(Each, Ended)>>>);

    #[derive(Default)]
    pub struct Fake {
        /// Every call, in order: its tag and payload.
        pub asked: Mutex<Vec<(String, Value)>>,
        answers: Mutex<HashMap<String, VecDeque<Result<Value, Failure>>>>,
        waiting: Mutex<Vec<(String, Answer)>>,
        streams: Mutex<Vec<Subscriber>>,
    }

    impl Fake {
        /// The answer the next request of `tag` gets, at once.
        pub fn will_answer(&self, tag: &str, answer: Result<Value, CallError>) {
            let mut answers = self.answers.lock().unwrap();
            answers
                .entry(tag.into())
                .or_default()
                .push_back(answer.map_err(Failure::from));
        }

        /// Answers the oldest request of `tag` still waiting; false where none is.
        pub fn answer(&self, tag: &str, answer: Result<Value, CallError>) -> bool {
            self.answer_with(tag, answer.map_err(Failure::from))
        }

        /// Answers the oldest request of `tag` still waiting with the host's no.
        pub fn refuse(&self, tag: &str, why: &str) -> bool {
            self.answer_with(
                tag,
                Err(Failure {
                    said: why.into(),
                    refused: true,
                }),
            )
        }

        fn answer_with(&self, tag: &str, answer: Result<Value, Failure>) -> bool {
            let mut waiting = self.waiting.lock().unwrap();
            let Some(at) = waiting.iter().position(|(asked, _)| asked == tag) else {
                return false;
            };
            let (_, reply) = waiting.remove(at);
            drop(waiting);
            reply(answer);
            true
        }

        /// Sends `value` to every open stream of `tag`.
        pub fn push(&self, tag: &str, value: Result<Value, CallError>) {
            for (_, each) in self
                .streams
                .lock()
                .unwrap()
                .iter()
                .filter(|(t, _)| t == tag)
            {
                if let Some((each, _)) = each.lock().unwrap().as_mut() {
                    each(value.clone().map_err(Failure::from));
                }
            }
        }

        /// Ends every open stream of `tag` without an error, as the core ends one.
        pub fn end(&self, tag: &str) {
            for (_, each) in self
                .streams
                .lock()
                .unwrap()
                .iter()
                .filter(|(t, _)| t == tag)
            {
                if let Some((_, ended)) = each.lock().unwrap().take() {
                    ended();
                }
            }
        }

        pub fn asked_of(&self, tag: &str) -> Vec<Value> {
            let asked = self.asked.lock().unwrap();
            asked
                .iter()
                .filter(|(t, _)| t == tag)
                .map(|(_, p)| p.clone())
                .collect()
        }
    }

    impl Calls for Fake {
        fn request(&self, tag: &str, payload: Value, answer: Answer) {
            self.asked.lock().unwrap().push((tag.into(), payload));
            let ready = self
                .answers
                .lock()
                .unwrap()
                .get_mut(tag)
                .and_then(VecDeque::pop_front);
            match ready {
                Some(ready) => answer(ready),
                None => self.waiting.lock().unwrap().push((tag.into(), answer)),
            }
        }

        fn stream(&self, tag: &str, payload: Value, each: Each, ended: Ended) -> Stop {
            self.asked.lock().unwrap().push((tag.into(), payload));
            let each = Arc::new(Mutex::new(Some((each, ended))));
            self.streams
                .lock()
                .unwrap()
                .push((tag.into(), each.clone()));
            Box::new(move || {
                each.lock().unwrap().take();
            })
        }
    }

    type Queued<S> = Arc<Mutex<Vec<Box<dyn FnOnce(&mut S) + Send>>>>;

    /// What a test holds: the core it answers and the changes the answers queued.
    pub struct Harness<S> {
        pub fake: Arc<Fake>,
        pub core: Core<S>,
        queued: Queued<S>,
    }

    impl<S: 'static> Harness<S> {
        pub fn new() -> Self {
            let fake = Arc::new(Fake::default());
            let queued: Queued<S> = Arc::default();
            let into = queued.clone();
            let core = Core::new(
                fake.clone(),
                Arc::new(move |change| into.lock().unwrap().push(change)),
            );
            Harness { fake, core, queued }
        }

        /// Applies every change the core's answers have queued, as the view's thread would.
        pub fn settle(&self, state: &mut S) {
            loop {
                let changes = std::mem::take(&mut *self.queued.lock().unwrap());
                if changes.is_empty() {
                    return;
                }
                changes.into_iter().for_each(|change| change(state));
            }
        }
    }

    impl<S: 'static> Default for Harness<S> {
        fn default() -> Self {
            Self::new()
        }
    }
}
