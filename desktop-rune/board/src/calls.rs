//! The view's calls to the Desktop core: any `DesktopRpcs` RPC by its tag, answered off the
//! view's thread and applied to the app on it.

use collie_desktop_protocol::client::{Client, RpcError};
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

pub type Answer = Box<dyn FnOnce(Result<Value, CallError>) + Send>;
pub type Each = Box<dyn FnMut(Result<Value, CallError>) + Send>;
/// Ends a stream; its subscriber hears nothing after.
pub type Stop = Box<dyn FnOnce() + Send>;

/// The core as the view reaches it: the live one over stdio, or a test's fake.
pub trait Calls: Send + Sync {
    fn request(&self, tag: &str, payload: Value, answer: Answer);
    fn stream(&self, tag: &str, payload: Value, each: Each) -> Stop;
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

fn typed<A: DeserializeOwned>(answer: Result<Value, CallError>) -> Result<A, CallError> {
    answer.and_then(|value| {
        serde_json::from_value(value).map_err(|e| {
            CallError(format!(
                "Desktop's core answered in a shape this app can't read: {e}"
            ))
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
        let post = self.post.clone();
        let payload = serde_json::to_value(payload).unwrap_or(Value::Null);
        self.calls.request(
            tag,
            payload,
            Box::new(move |answer| {
                let answer = typed(answer);
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
        let post = self.post.clone();
        let each = Arc::new(Mutex::new(each));
        let payload = serde_json::to_value(payload).unwrap_or(Value::Null);
        self.calls.stream(
            tag,
            payload,
            Box::new(move |value| {
                let value = typed(value);
                let each = each.clone();
                post(Box::new(move |s| (each.lock().unwrap())(s, value)));
            }),
        )
    }
}

/// An RPC's failure as its reason, where its error carries one.
fn said(error: RpcError<Value>) -> CallError {
    CallError(match error {
        RpcError::Failed(failed) => ["reason", "message"]
            .iter()
            .find_map(|key| failed.get(key).and_then(Value::as_str).map(String::from))
            .unwrap_or_else(|| failed.to_string()),
        other => other.to_string(),
    })
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

    fn stream(&self, tag: &str, payload: Value, mut each: Each) -> Stop {
        let values = self.0.stream::<_, Value, Value>(tag, payload);
        let release = values.release();
        std::thread::spawn(move || {
            for value in values {
                each(value.map_err(said));
            }
        });
        Box::new(move || release.interrupt())
    }
}

/// A core a test answers by hand, and the app's changes queued until the test applies them.
pub mod testing {
    use super::*;

    type Subscriber = (String, Arc<Mutex<Option<Each>>>);

    #[derive(Default)]
    pub struct Fake {
        /// Every call, in order: its tag and payload.
        pub asked: Mutex<Vec<(String, Value)>>,
        answers: Mutex<HashMap<String, VecDeque<Result<Value, CallError>>>>,
        waiting: Mutex<Vec<(String, Answer)>>,
        streams: Mutex<Vec<Subscriber>>,
    }

    impl Fake {
        /// The answer the next request of `tag` gets, at once.
        pub fn will_answer(&self, tag: &str, answer: Result<Value, CallError>) {
            let mut answers = self.answers.lock().unwrap();
            answers.entry(tag.into()).or_default().push_back(answer);
        }

        /// Answers the oldest request of `tag` still waiting; false where none is.
        pub fn answer(&self, tag: &str, answer: Result<Value, CallError>) -> bool {
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
                if let Some(each) = each.lock().unwrap().as_mut() {
                    each(value.clone());
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

        fn stream(&self, tag: &str, payload: Value, each: Each) -> Stop {
            self.asked.lock().unwrap().push((tag.into(), payload));
            let each = Arc::new(Mutex::new(Some(each)));
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
