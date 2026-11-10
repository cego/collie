//! Posts the notifications the main process asks for, and brings the window forward when one
//! is clicked.

use collie_desktop_protocol::rpc::Notice;
use std::sync::mpsc::Receiver;

/// Called with the activation token the click came with, where the platform gives one.
pub type Clicked = Box<dyn Fn(Option<String>) + Send>;

pub trait Notifier {
    fn post(&self, notice: &Notice, clicked: Clicked);
}

/// Posts each notice until the core is gone.
pub fn deliver(
    notices: Receiver<Notice>,
    notifier: &dyn Notifier,
    raise: impl Fn(Option<String>) + Clone + Send + 'static,
) {
    for notice in notices {
        notifier.post(&notice, Box::new(raise.clone()));
    }
}

/// `org.freedesktop.Notifications` on the session bus: Rune posts none on Linux.
#[cfg(target_os = "linux")]
pub mod freedesktop {
    use super::{Clicked, Notice, Notifier};
    use std::collections::HashMap;
    use std::sync::mpsc::{Sender, channel};
    use zbus::Variant as Value;

    const NAME: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";

    /// A thread of its own holds the bus, and the clicks of what it posted.
    pub struct Freedesktop(Sender<(Notice, Clicked)>);

    impl Freedesktop {
        pub fn start() -> Freedesktop {
            let (post, posts) = channel::<(Notice, Clicked)>();
            std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("a runtime");
                if let Err(error) = runtime.block_on(serve(posts)) {
                    eprintln!("notifications: {error}");
                }
            });
            Freedesktop(post)
        }
    }

    impl Notifier for Freedesktop {
        fn post(&self, notice: &Notice, clicked: Clicked) {
            let _ = self.0.send((notice.clone(), clicked));
        }
    }

    async fn serve(posts: std::sync::mpsc::Receiver<(Notice, Clicked)>) -> zbus::Result<()> {
        use futures_util::StreamExt;
        let bus = zbus::Connection::session().await?;
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface(NAME)
            .build()?;
        let mut signals = zbus::MessageStream::for_match_rule(rule, &bus, None).await?;
        let (posted, mut asked) = tokio::sync::mpsc::unbounded_channel();
        std::thread::spawn(move || posts.into_iter().for_each(|post| drop(posted.send(post))));
        let mut clicks: HashMap<u32, (Clicked, Option<String>)> = HashMap::new();
        loop {
            tokio::select! {
                post = asked.recv() => {
                    let Some((notice, clicked)) = post else { return Ok(()) };
                    let hints: HashMap<&str, Value> =
                        HashMap::from([("suppress-sound", Value::from(notice.silent))]);
                    let reply = bus
                        .call_method(Some(NAME), PATH, Some(NAME), "Notify", &(
                            "Collie", 0u32, "", notice.title.as_str(), notice.body.as_str(),
                            vec!["default", "Open"], hints, -1i32,
                        ))
                        .await;
                    // No notification daemon drops this one, not the ones after it.
                    match reply.and_then(|reply| reply.body().deserialize::<u32>()) {
                        Ok(id) => drop(clicks.insert(id, (clicked, None))),
                        Err(error) => eprintln!("notifications: {error}"),
                    }
                }
                Some(Ok(signal)) = signals.next() => {
                    let header = signal.header();
                    match header.member().map(|m| m.as_str()) {
                        // Sent before ActionInvoked, so the click can carry it.
                        Some("ActivationToken") => {
                            let (id, token): (u32, String) = signal.body().deserialize()?;
                            if let Some(click) = clicks.get_mut(&id) { click.1 = Some(token) }
                        }
                        Some("ActionInvoked") => {
                            let (id, _action): (u32, String) = signal.body().deserialize()?;
                            if let Some((clicked, token)) = clicks.remove(&id) { clicked(token) }
                        }
                        Some("NotificationClosed") => {
                            let (id, _why): (u32, u32) = signal.body().deserialize()?;
                            clicks.remove(&id);
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

/// Notification Center through rune-mac, which posts only from a bundled, signed app.
pub mod mac {
    use super::{Clicked, Notice, Notifier};
    use rune_mac::notify::{Click, Notification, on_click, post};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    pub struct Mac {
        clicks: Arc<Mutex<HashMap<String, Clicked>>>,
        posted: AtomicU64,
    }

    impl Mac {
        /// Installs the one click handler macOS calls, so start it at launch.
        pub fn start() -> Mac {
            let clicks: Arc<Mutex<HashMap<String, Clicked>>> = Arc::default();
            let heard = clicks.clone();
            on_click(move |click: Click| {
                if let Some(clicked) = heard.lock().unwrap().remove(&click.id) {
                    clicked(None)
                }
            });
            Mac {
                clicks,
                posted: AtomicU64::new(0),
            }
        }
    }

    impl Notifier for Mac {
        fn post(&self, notice: &Notice, clicked: Clicked) {
            let id = format!("notice-{}", self.posted.fetch_add(1, Ordering::Relaxed));
            let shown =
                Notification::new(id.clone(), notice.title.clone()).body(notice.body.clone());
            if post(&shown) {
                self.clicks.lock().unwrap().insert(id, clicked);
            }
        }
    }
}
