//! `say` streams recorded from today's chat (`record-say`), folded into the transcript.

use collie_desktop_chat::agui::{Message, Part, Role, Transcript};
use serde_json::Value;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/chat");

fn played(name: &str) -> Transcript {
    let mut transcript = Transcript::default();
    let recorded = std::fs::read_to_string(format!("{FIXTURES}/{name}.ndjson")).unwrap();
    for line in recorded.lines() {
        let line: Value = serde_json::from_str(line).unwrap();
        if let Some(said) = line.get("said") {
            transcript.say(said["text"].as_str().unwrap());
        } else if let Some(event) = line.get("event") {
            transcript.apply(serde_json::from_value(event.clone()).unwrap());
        } else {
            transcript.stop();
        }
    }
    transcript
}

fn said(text: &str) -> Message {
    Message::user("said-1", vec![Part::Text(text.into())], None)
}

fn text_of(message: &Message) -> &str {
    match message.parts.as_slice() {
        [Part::Text(text)] => text,
        parts => panic!("not one text part: {parts:?}"),
    }
}

#[test]
fn a_replys_text_deltas_are_joined_into_one_text_part() {
    let transcript = played("say-text");
    assert_eq!(transcript.messages.len(), 2);
    assert_eq!(transcript.messages[0].role, Role::User);
    assert_eq!(transcript.messages[1].role, Role::Assistant);
    let reply = text_of(&transcript.messages[1]);
    assert!(reply.starts_with("A sheepdog gathers, moves and guards livestock for a shepherd."));
    assert!(
        reply.contains("\n| Border Collie | Scotland/England | Strong \"eye,\" fast gathering |\n")
    );
    assert!(reply.ends_with("console.log(herd(\"Collie\", \"come-bye\"));\n```"));
    assert!(!transcript.running);
    assert_eq!(transcript.error, None);
}

#[test]
fn a_tool_call_is_started_given_its_arguments_and_finished_with_its_output() {
    let transcript = played("say-tool");
    assert_eq!(
        transcript.messages[1].parts,
        [
            Part::ToolCall {
                id: "toolu_01XS1ZjFcJi8H9zLxc25vfJV".into(),
                name: "Read".into(),
                arguments: r#"{"file_path": "/etc/hostname"}"#.into(),
                output: Some("1\tvm-mk.cegohost.dk\n2\t".into()),
            },
            Part::Text("The hostname is `vm-mk.cegohost.dk`.".into()),
        ]
    );
    assert!(!transcript.running);
}

#[test]
fn a_run_error_is_said_under_the_humans_message_and_ends_the_turn() {
    let transcript = played("say-error");
    assert_eq!(
        transcript.messages,
        [said("What is in the file I attached?")]
    );
    assert_eq!(
        transcript.error.as_deref(),
        Some("Desktop no longer has missing-attachment; attach it again.")
    );
    assert!(!transcript.running);
}

#[test]
fn a_turn_cancelled_mid_stream_keeps_what_came_and_runs_no_more() {
    let transcript = played("say-cancel");
    assert_eq!(
        transcript.messages[1].parts,
        [
            Part::Thinking(
                "Now I'm drafting a roughly 400-word prose piece with a heading or two, and I need to keep the facts accurate.\n\n"
                    .into()
            ),
            Part::Text("Herding dogs are among the oldest working partn".into()),
        ]
    );
    assert!(!transcript.running);
    assert_eq!(transcript.error, None);
}

#[test]
fn a_second_turn_follows_the_first_with_its_own_reply() {
    let transcript = played("say-two-turns");
    let texts: Vec<(&Role, &str)> = transcript
        .messages
        .iter()
        .map(|message| (&message.role, text_of(message)))
        .collect();
    assert_eq!(
        texts,
        [
            (
                &Role::User,
                "Use no tools. Remember the number 7 and reply only: noted."
            ),
            (&Role::Assistant, "noted"),
            (
                &Role::User,
                "Use no tools. Which number did I ask you to remember? Reply with the digit only."
            ),
            (&Role::Assistant, "7"),
        ]
    );
}

#[test]
fn saying_again_after_an_error_clears_it_and_runs() {
    let mut transcript = played("say-error");
    transcript.say("Never mind.");
    assert_eq!(transcript.error, None);
    assert!(transcript.running);
}
