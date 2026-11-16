//! The chat's states on no core, for headless snapshots:
//! `cargo run -p collie-desktop-chat --example states -- --scene tools --snap tools.png`.

use collie_desktop_chat::agui::{Message, Part, Role};
use collie_desktop_chat::window::{Alone, view};
use collie_desktop_protocol::generated::About;
use rune::AppSpec;

fn said(id: &str, words: &str) -> Message {
    Message::user(id, vec![Part::Text(words.into())], None)
}

fn reply(id: &str, parts: Vec<Part>) -> Message {
    Message {
        id: id.into(),
        role: Role::Assistant,
        parts,
        about: None,
    }
}

fn tool(id: &str, name: &str, args: &str, output: Option<&str>) -> Part {
    Part::ToolCall {
        id: id.into(),
        name: name.into(),
        arguments: args.into(),
        output: output.map(String::from),
    }
}

const ANSWER: &str = "## What needs you\n\nTwo cards are **waiting on you**:\n\n1. **Review support-backoffice !283**: open, and nothing has checked it.\n2. **Content release 1.8.0**: asks for your go-ahead to deploy to production.\n\n### Your options\n\n- **Deploy both to prod**: starts the manual jobs and repeats the smoke checks.\n- **Hold production**: 1.8.0 stays on stage.\n\nThe rest of the Flock is working. Run `collie herd` for the full list.\n\n```sh\ncollie run show run-a43b9344\n```";

fn conversation(a: &mut Alone) {
    a.chat.loaded = true;
    a.chat.transcript.messages = vec![
        Message::user(
            "u1",
            vec![Part::Text("What needs me right now?".into())],
            Some(About {
                machine: "vm-mk".into(),
                task: "t1".into(),
                run: "run-a43b9344".into(),
                name: "Content release 1.8.0".into(),
            }),
        ),
        reply(
            "a1",
            vec![
                Part::Thinking("Read the board first, then the release's evidence.".into()),
                tool(
                    "c1",
                    "mcp__collie__collie_herd",
                    r#"{"machine":"vm-mk"}"#,
                    Some("7 cards"),
                ),
                tool(
                    "c2",
                    "mcp__collie__collie_news",
                    r#"{"machine":"vm-mk"}"#,
                    Some("2 items"),
                ),
                tool(
                    "c3",
                    "mcp__collie__collie_run",
                    r#"{"machine":"vm-mk","run":"run-a43b9344"}"#,
                    Some("waiting"),
                ),
                Part::Text(ANSWER.into()),
            ],
        ),
        said(
            "u2",
            "Hold production for now. What did the stage smoke checks show?",
        ),
        reply(
            "a2",
            vec![
                tool(
                    "c4",
                    "mcp__collie__collie_receipts",
                    r#"{"machine":"vm-mk","run":"run-a43b9344"}"#,
                    Some("\u{1b}[32mpassed\u{1b}[0m 12 checks"),
                ),
                Part::Text(
                    "All 12 smoke checks passed on stage. I've told the Run to **hold production**."
                        .into(),
                ),
            ],
        ),
    ];
}

fn empty(a: &mut Alone) {
    a.chat.loaded = true;
}

fn loading(_: &mut Alone) {}

fn tools(a: &mut Alone) {
    conversation(a);
    a.chat.expanded.insert("tools-a1-1".into());
    a.chat.expanded.insert("tool-c2".into());
    a.chat.expanded.insert("thought-a1-0".into());
}

fn working(a: &mut Alone) {
    conversation(a);
    a.chat
        .transcript
        .messages
        .push(said("u3", "Is the bump done?"));
    a.chat.transcript.messages.push(reply(
        "a3",
        vec![tool(
            "c5",
            "mcp__collie__collie_herd",
            r#"{"machine":"build"}"#,
            None,
        )],
    ));
    a.chat.transcript.running = true;
}

fn question(a: &mut Alone) {
    conversation(a);
    a.chat
        .transcript
        .messages
        .push(said("u3", "Help me choose"));
    a.chat.transcript.messages.push(reply(
        "a3",
        vec![tool(
            "q1",
            "AskUserQuestion",
            r#"{"questions":[{"question":"Which one first?","header":"Order","multiSelect":false,"options":[{"label":"The sweep","description":"It is older"},{"label":"The bump","description":"It unblocks two Runs"}]}]}"#,
            None,
        )],
    ));
    a.chat.transcript.running = true;
}

fn error(a: &mut Alone) {
    conversation(a);
    a.chat
        .transcript
        .messages
        .push(said("u3", "What is in the file I attached?"));
    a.chat.transcript.error =
        Some("Desktop no longer has missing-attachment; attach it again.".into());
}

fn reconnecting(a: &mut Alone) {
    conversation(a);
    a.chat.trouble = Some("Desktop's core went away.".into());
    a.chat.retry_at = Some(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
            + 8000.0,
    );
}

fn popped(a: &mut Alone) {
    conversation(a);
    a.chat.popped = true;
    a.chat.pop = Some(Box::new(|_| {}));
}

fn queued(a: &mut Alone) {
    working(a);
    a.chat.choose(Some(About {
        machine: "vm-mk".into(),
        task: "t2".into(),
        run: "run-b2".into(),
        name: "Nightly evidence sweep".into(),
    }));
    a.chat.queue.push(collie_desktop_chat::choices::Queued {
        id: 1,
        text: "And then summarise the sweep.".into(),
        files: Vec::new(),
        about: None,
    });
}

fn long(a: &mut Alone) {
    a.chat.loaded = true;
    for n in 0..40 {
        a.chat
            .transcript
            .messages
            .push(said(&format!("u{n}"), &format!("Question {n}?")));
        a.chat.transcript.messages.push(reply(
            &format!("a{n}"),
            vec![Part::Text(format!(
                "Answer {n}. The sweep is waiting on you, and the bump is working."
            ))],
        ));
    }
}

/// A scene's name and what it puts in the chat.
type Scene = (&'static str, fn(&mut Alone));

const SCENES: &[Scene] = &[
    ("empty", empty),
    ("loading", loading),
    ("conversation", conversation),
    ("tools", tools),
    ("working", working),
    ("question", question),
    ("error", error),
    ("reconnecting", reconnecting),
    ("popped", popped),
    ("queued", queued),
    ("long", long),
];

fn main() {
    rune::App::new(AppSpec {
        fonts: rune_theme_opencode::FONTS,
        families: rune_theme_opencode::FAMILIES,
        scenes: SCENES,
        ..AppSpec::new("Flock chat", (440.0, 860.0), Alone::default, view)
    })
    .run();
}
