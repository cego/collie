//! A notice from the core posted through a fake notifier, and its click raising the window.

use collie_desktop_board::notify::{Clicked, Notifier, deliver};
use collie_desktop_protocol::rpc::Notice;
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Fake {
    posted: Mutex<Vec<(Notice, Clicked)>>,
}

impl Notifier for Fake {
    fn post(&self, notice: &Notice, clicked: Clicked) {
        self.posted.lock().unwrap().push((notice.clone(), clicked));
    }
}

#[test]
fn a_notice_is_posted_once_and_its_click_brings_the_window_forward() {
    let (core, notices) = channel();
    let asked = Notice {
        title: "Needs you".into(),
        body: "Release 0.119.0 asks a question".into(),
        silent: false,
    };
    core.send(asked.clone()).unwrap();
    drop(core);
    let fake = Fake::default();
    let raised: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
    let raises = raised.clone();
    deliver(notices, &fake, move |token| {
        raises.lock().unwrap().push(token)
    });

    let posted = fake.posted.lock().unwrap();
    assert_eq!(posted.iter().map(|(n, _)| n).collect::<Vec<_>>(), [&asked]);
    assert!(
        raised.lock().unwrap().is_empty(),
        "nothing raised before a click"
    );
    (posted[0].1)(Some("xdg-token".into()));
    assert_eq!(*raised.lock().unwrap(), [Some("xdg-token".to_string())]);
}
