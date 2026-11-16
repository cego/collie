//! Streams recorded from Desktop's `terminal` stream (`core/record-terminal.ts`, at 100 by 30),
//! played into the VT state: the screen's text, chosen cells' colours and the cursor after each.

use base64::Engine;
use collie_desktop_protocol::generated::TerminalEvent;
use collie_desktop_terminal::config::GHOSTTY;
use collie_desktop_terminal::vt::{Frame, Rgb, Vt};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/terminal");

const WHITE: Rgb = Rgb(0xff, 0xff, 0xff);
/// Ghostty's palette 2, 4 and 14.
const GREEN: Rgb = Rgb(0xb5, 0xbd, 0x68);
const BLUE: Rgb = Rgb(0x81, 0xa2, 0xbe);
const BRIGHT_CYAN: Rgb = Rgb(0x70, 0xc0, 0xb1);

fn played(name: &str) -> (Vt, Frame) {
    let mut vt = Vt::new(100, 30, &GHOSTTY);
    let recorded = std::fs::read_to_string(format!("{FIXTURES}/{name}.ndjson")).unwrap();
    for line in recorded.lines() {
        if let TerminalEvent::Frame(frame) = serde_json::from_str(line).unwrap() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(frame.bytes)
                .unwrap();
            vt.write(&bytes);
        }
    }
    let frame = vt.frame();
    (vt, frame)
}

#[test]
fn a_herdr_pane_running_ls_color_shows_its_listing_coloured_and_the_prompt_after_it() {
    let (_, frame) = played("herdr-ls");
    assert_eq!(
        (0..4).map(|y| frame.line(y)).collect::<Vec<_>>(),
        [
            "journald.conf  networkd.conf  sleep.conf   system-generators  user.conf",
            "logind.conf    pstore.conf    system       timesyncd.conf",
            "network        resolved.conf  system.conf  user",
            "mk@vm-mk:~/work/gitte2/gitlab.cego.dk$",
        ]
    );
    let network = frame.cell(0, 2);
    assert_eq!((network.fg, network.bold), (BLUE, true));
    let plain = frame.cell(0, 0);
    assert_eq!((plain.fg, plain.bold), (WHITE, false));
    let user = frame.cell(0, 3);
    assert_eq!((user.fg, user.bold), (GREEN, true));
    assert_eq!(frame.cursor.map(|c| (c.x, c.y)), Some((39, 3)));
}

#[test]
fn vim_in_a_herdr_pane_fills_the_screen_with_its_coloured_file_and_its_status_line() {
    let (_, frame) = played("herdr-vim");
    assert_eq!(frame.line(0), "#  This file is part of systemd.");
    assert_eq!(frame.cell(0, 0).fg, BRIGHT_CYAN);
    assert_eq!(frame.line(28), "#SystemMaxFileSize=");
    let status = frame.line(29);
    assert!(
        status.starts_with("\"/etc/systemd/journald.conf\" [readonly] 49L, 1406B"),
        "{status:?}"
    );
    assert_eq!(frame.cell(82, 29).text, "1");
    assert!(status.ends_with("Top"), "{status:?}");
    assert_eq!(frame.cursor.map(|c| (c.x, c.y)), Some((0, 0)));
}

#[test]
fn a_core_attachs_first_paint_brings_the_terminal_as_it_was_and_its_prompt_redrawn() {
    let (_, frame) = played("core-attach");
    assert_eq!(
        (0..4).map(|y| frame.line(y)).collect::<Vec<_>>(),
        [
            "mk@vm-mk:~/work/gitte2/gitlab.cego.dk$ ls --color /etc/systemd",
            "journald.conf  logind.conf  network  networkd.conf  pstore.conf  resolved.conf  sleep.conf  system",
            "system.conf  system-generators  timesyncd.conf  user  user.conf",
            "mk@vm-mk:~/work/gitte2/gitlab.cego.dk$",
        ]
    );
    let network = frame.cell(28, 1);
    assert_eq!(
        (network.text.as_str(), network.fg, network.bold),
        ("n", BLUE, true)
    );
    let user = frame.cell(0, 3);
    assert_eq!((user.fg, user.bold), (GREEN, true));
    assert_eq!(frame.cursor.map(|c| (c.x, c.y)), Some((39, 3)));
}
