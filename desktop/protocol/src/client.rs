//! A blocking `DesktopRpcs` client over the core's stdio: one reader thread routes each
//! frame to the call it answers, and the core's stdout ending ends every open call.

use crate::rpc::{Exit, FromCore, Notice, Reason, ToCore};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::io::{self, BufRead, Write};
use std::marker::PhantomData;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

#[derive(Debug, PartialEq)]
pub enum RpcError<E> {
    /// The RPC's own error, as its Schema says.
    Failed(E),
    Defect(Value),
    Interrupted,
    /// The core's stdout ended before the call did.
    CoreGone,
    /// A frame or value the Rust types could not read.
    Protocol(String),
}

impl<E: fmt::Debug> fmt::Display for RpcError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RpcError::Failed(error) => write!(f, "the RPC failed: {error:?}"),
            RpcError::Defect(defect) => write!(f, "the Desktop core died answering: {defect}"),
            RpcError::Interrupted => write!(f, "the call was interrupted"),
            RpcError::CoreGone => write!(f, "the Desktop core is gone: it exited mid-call"),
            RpcError::Protocol(why) => write!(f, "unreadable from the Desktop core: {why}"),
        }
    }
}

impl<E: fmt::Debug> std::error::Error for RpcError<E> {}

enum Reply {
    Chunk(Vec<Value>),
    Exit(Exit),
    Broken(String),
}

/// Each open call's inbox by request id; `None` once the core is gone.
type Open = Arc<Mutex<Option<HashMap<u64, Sender<Reply>>>>>;

#[derive(Clone)]
pub struct Client {
    out: Arc<Mutex<Box<dyn Write + Send>>>,
    open: Open,
    next: Arc<AtomicU64>,
    notices: Arc<Mutex<Option<Receiver<Notice>>>>,
    restarts: Arc<Mutex<Option<Receiver<()>>>>,
    restarting: Arc<AtomicBool>,
}

impl Client {
    /// Says `Hello` on `output`, the core's stdin, and reads `input`, its stdout.
    pub fn new(
        input: impl BufRead + Send + 'static,
        output: impl Write + Send + 'static,
    ) -> io::Result<Client> {
        let client = Client {
            out: Arc::new(Mutex::new(Box::new(output))),
            open: Arc::new(Mutex::new(Some(HashMap::new()))),
            next: Arc::new(AtomicU64::new(0)),
            notices: Arc::new(Mutex::new(None)),
            restarts: Arc::new(Mutex::new(None)),
            restarting: Arc::new(AtomicBool::new(false)),
        };
        let (notify, notices) = channel();
        *client.notices.lock().unwrap() = Some(notices);
        let (restart, restarts) = channel();
        *client.restarts.lock().unwrap() = Some(restarts);
        let restarting = client.restarting.clone();
        client.send(&ToCore::Hello)?;
        let open = client.open.clone();
        std::thread::spawn(move || {
            for line in input.lines().map_while(Result::ok) {
                let frame = serde_json::from_str(&line);
                let mut open = open.lock().unwrap();
                let Some(calls) = open.as_mut() else { break };
                // A call whose caller has gone has nobody to tell, so sends are not checked.
                match frame {
                    Ok(FromCore::Chunk { request_id, values }) => {
                        calls
                            .get(&request_id)
                            .map(|inbox| inbox.send(Reply::Chunk(values)));
                    }
                    Ok(FromCore::Exit { request_id, exit }) => {
                        calls
                            .remove(&request_id)
                            .map(|inbox| inbox.send(Reply::Exit(exit)));
                    }
                    Ok(FromCore::Defect { defect }) => calls.drain().for_each(|(_, inbox)| {
                        let cause = vec![Reason::Die {
                            defect: defect.clone(),
                        }];
                        let _ = inbox.send(Reply::Exit(Exit::Failure { cause }));
                    }),
                    Ok(FromCore::ClientProtocolError { error }) => {
                        calls.drain().for_each(|(_, inbox)| {
                            let _ = inbox.send(Reply::Broken(error.to_string()));
                        })
                    }
                    Ok(FromCore::Notify(notice)) => {
                        let _ = notify.send(notice);
                    }
                    Ok(FromCore::Restart) => {
                        restarting.store(true, Ordering::Release);
                        let _ = restart.send(());
                    }
                    Ok(FromCore::Pong) | Err(_) => {}
                }
            }
            open.lock().unwrap().take();
        });
        Ok(client)
    }

    /// The notifications the core asks for, once; they end with the core.
    pub fn notices(&self) -> Option<Receiver<Notice>> {
        self.notices.lock().unwrap().take()
    }

    pub fn restarts(&self) -> Option<Receiver<()>> {
        self.restarts.lock().unwrap().take()
    }

    pub fn restarting(&self) -> bool {
        self.restarting.load(Ordering::Acquire)
    }

    fn send(&self, frame: &ToCore) -> io::Result<()> {
        let mut out = self.out.lock().unwrap();
        serde_json::to_writer(&mut *out, frame)?;
        out.write_all(b"\n")?;
        out.flush()
    }

    /// Asks `tag`, and answers the inbox its replies come to: empty where the core is gone.
    fn call(&self, tag: &str, payload: impl Serialize) -> (u64, Receiver<Reply>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (inbox, replies) = channel();
        match self.open.lock().unwrap().as_mut() {
            Some(calls) => calls.insert(id, inbox),
            None => return (id, replies),
        };
        let request = ToCore::Request {
            id,
            tag: tag.into(),
            payload: serde_json::to_value(payload).unwrap_or(Value::Null),
            headers: Vec::new(),
        };
        if self.send(&request).is_err() {
            self.open
                .lock()
                .unwrap()
                .as_mut()
                .map(|calls| calls.remove(&id));
        }
        (id, replies)
    }

    pub fn request<P: Serialize, A: DeserializeOwned, E: DeserializeOwned>(
        &self,
        tag: &str,
        payload: P,
    ) -> Result<A, RpcError<E>> {
        let (_, replies) = self.call(tag, payload);
        match replies.recv() {
            Ok(Reply::Exit(exit)) => decoded(ended(exit)?.unwrap_or(Value::Null)),
            Ok(Reply::Chunk(_)) => Err(RpcError::Protocol(format!("{tag} answered with a chunk"))),
            Ok(Reply::Broken(why)) => Err(RpcError::Protocol(why)),
            Err(_) => Err(RpcError::CoreGone),
        }
    }

    /// A stream's values, each chunk acked as it is taken; dropping it interrupts the stream.
    pub fn stream<P: Serialize, A: DeserializeOwned, E: DeserializeOwned>(
        &self,
        tag: &str,
        payload: P,
    ) -> Subscription<A, E> {
        let (id, replies) = self.call(tag, payload);
        Subscription {
            client: self.clone(),
            id,
            release: Release {
                client: self.clone(),
                id,
                sent: Arc::new(AtomicBool::new(false)),
            },
            replies,
            taken: VecDeque::new(),
            ended: false,
            types: PhantomData,
        }
    }
}

fn decoded<A: DeserializeOwned, E>(value: Value) -> Result<A, RpcError<E>> {
    serde_json::from_value(value).map_err(|why| RpcError::Protocol(why.to_string()))
}

fn ended<E: DeserializeOwned>(exit: Exit) -> Result<Option<Value>, RpcError<E>> {
    match exit {
        Exit::Success { value } => Ok(value),
        Exit::Failure { cause } => Err(match cause.into_iter().next() {
            Some(Reason::Fail { error }) => match serde_json::from_value(error) {
                Ok(error) => RpcError::Failed(error),
                Err(why) => RpcError::Protocol(why.to_string()),
            },
            Some(Reason::Die { defect }) => RpcError::Defect(defect),
            Some(Reason::Interrupt { .. }) | None => RpcError::Interrupted,
        }),
    }
}

pub struct Subscription<A, E> {
    client: Client,
    id: u64,
    release: Release,
    replies: Receiver<Reply>,
    taken: VecDeque<Value>,
    ended: bool,
    types: PhantomData<fn() -> (A, E)>,
}

impl<A, E> Subscription<A, E> {
    /// Tells the core the shell is done with the stream; nothing more comes from it.
    pub fn interrupt(&mut self) {
        if self.ended {
            return;
        }
        self.ended = true;
        self.taken.clear();
        self.release.interrupt();
    }

    /// Interrupts the stream from elsewhere, such as a view leaving while a thread reads it.
    pub fn release(&self) -> Release {
        self.release.clone()
    }
}

#[derive(Clone)]
pub struct Release {
    client: Client,
    id: u64,
    sent: Arc<AtomicBool>,
}

impl Release {
    pub fn interrupt(&self) {
        if self.sent.swap(true, Ordering::Relaxed) {
            return;
        }
        // A core that is gone has nothing left to interrupt.
        let _ = self.client.send(&ToCore::Interrupt {
            request_id: self.id,
        });
    }
}

impl<A: DeserializeOwned, E: DeserializeOwned> Iterator for Subscription<A, E> {
    type Item = Result<A, RpcError<E>>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(value) = self.taken.pop_front() {
                return Some(decoded(value));
            }
            if self.ended {
                return None;
            }
            match self.replies.recv() {
                Ok(Reply::Chunk(values)) => {
                    let _ = self.client.send(&ToCore::Ack {
                        request_id: self.id,
                    });
                    self.taken.extend(values);
                }
                Ok(Reply::Exit(exit)) => {
                    self.ended = true;
                    return ended(exit).err().map(Err);
                }
                Ok(Reply::Broken(why)) => {
                    self.ended = true;
                    return Some(Err(RpcError::Protocol(why)));
                }
                Err(_) => {
                    self.ended = true;
                    return Some(Err(RpcError::CoreGone));
                }
            }
        }
    }
}

impl<A, E> Drop for Subscription<A, E> {
    fn drop(&mut self) {
        self.interrupt();
    }
}
