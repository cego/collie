//! The Flock chat's transcript: the conversation `transcript` replays, and the AG-UI events
//! `say` streams folded onto it, where Desktop's view has TanStack AI's client. One assistant
//! message a turn, its parts in the order said.

use crate::attachments::Attached;
use collie_desktop_protocol::generated::{
    About, AguiEvent, TranscriptSuccessItem, TranscriptSuccessItemPart,
    TranscriptSuccessItemPart0Type, TranscriptSuccessItemRole,
};

#[derive(Debug, Clone, PartialEq)]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Part {
    Text(String),
    Thinking(String),
    Attached(Attached),
    ToolCall {
        id: String,
        name: String,
        arguments: String,
        output: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub id: String,
    pub role: Role,
    pub parts: Vec<Part>,
    /// The board's card the human sent it about.
    pub about: Option<About>,
}

impl Message {
    pub fn user(id: impl Into<String>, parts: Vec<Part>, about: Option<About>) -> Message {
        Message {
            id: id.into(),
            role: Role::User,
            parts,
            about,
        }
    }

    /// Its words, as copied: text parts, a blank line apart.
    pub fn text(&self) -> String {
        self.parts
            .iter()
            .filter_map(|p| match p {
                Part::Text(text) => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// What Desktop said of its own, where this is a turn Desktop started about News.
    pub fn desktop_said(&self) -> Option<&str> {
        match (&self.role, self.parts.first()) {
            (Role::User, Some(Part::Text(text))) => crate::words::desktop_said(text),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Transcript {
    pub messages: Vec<Message>,
    /// Why the last turn failed, until the next is said.
    pub error: Option<String>,
    pub running: bool,
    /// Counts the messages said here, for their ids.
    said: u64,
}

fn parts_of(item: TranscriptSuccessItem) -> Message {
    let parts = item
        .parts
        .into_iter()
        .map(|part| match part {
            TranscriptSuccessItemPart::TranscriptSuccessItemPart0(part) => match part.r#type {
                TranscriptSuccessItemPart0Type::Text => Part::Text(part.content),
                TranscriptSuccessItemPart0Type::Thinking => Part::Thinking(part.content),
            },
            TranscriptSuccessItemPart::Document(doc) => Part::Attached(Attached::from(&doc)),
            TranscriptSuccessItemPart::ToolCall(call) => Part::ToolCall {
                id: call.id,
                name: call.name,
                arguments: call.arguments,
                output: call.output,
            },
        })
        .collect();
    Message {
        id: item.id,
        role: match item.role {
            TranscriptSuccessItemRole::User => Role::User,
            TranscriptSuccessItemRole::Assistant => Role::Assistant,
        },
        parts,
        about: item.metadata.and_then(|m| m.about),
    }
}

impl Transcript {
    /// The conversation as the core keeps it, in place of what was shown.
    pub fn replace(&mut self, items: Vec<TranscriptSuccessItem>) {
        self.messages = items.into_iter().map(parts_of).collect();
    }

    /// The human's words alone, as a turn starts.
    pub fn say(&mut self, text: &str) {
        self.said_with(text, Vec::new(), None);
    }

    /// The human's message: words, files and the card it is about.
    pub fn said_with(&mut self, text: &str, files: Vec<Attached>, about: Option<About>) {
        self.said += 1;
        let mut parts: Vec<Part> = Vec::new();
        if !text.is_empty() {
            parts.push(Part::Text(text.into()));
        }
        parts.extend(files.into_iter().map(Part::Attached));
        self.messages
            .push(Message::user(format!("said-{}", self.said), parts, about));
        self.error = None;
        self.running = true;
    }

    /// The turn's reply, begun by the first part it says.
    fn reply(&mut self) -> &mut Vec<Part> {
        if self
            .messages
            .last()
            .is_none_or(|m| m.role != Role::Assistant)
        {
            self.said += 1;
            self.messages.push(Message {
                id: format!("reply-{}", self.said),
                role: Role::Assistant,
                parts: Vec::new(),
                about: None,
            });
        }
        &mut self.messages.last_mut().unwrap().parts
    }

    fn tool_call(&mut self, id: &str) -> Option<(&mut String, &mut Option<String>)> {
        self.reply().iter_mut().rev().find_map(|part| match part {
            Part::ToolCall {
                id: called,
                arguments,
                output,
                ..
            } if called == id => Some((arguments, output)),
            _ => None,
        })
    }

    pub fn apply(&mut self, event: AguiEvent) {
        match event {
            AguiEvent::RunStarted(_) => self.running = true,
            AguiEvent::RunFinished(_) => self.running = false,
            AguiEvent::RunError(error) => {
                self.error = Some(error.message);
                self.running = false;
            }
            AguiEvent::TextMessageStart(_) => self.reply().push(Part::Text(String::new())),
            AguiEvent::ReasoningMessageStart(_) => self.reply().push(Part::Thinking(String::new())),
            AguiEvent::TextMessageContent(content) => {
                if let Some(Part::Text(text)) = self.reply().last_mut() {
                    text.push_str(&content.delta);
                }
            }
            AguiEvent::ReasoningMessageContent(content) => {
                if let Some(Part::Thinking(text)) = self.reply().last_mut() {
                    text.push_str(&content.delta);
                }
            }
            AguiEvent::TextMessageEnd(_) | AguiEvent::ReasoningMessageEnd(_) => {
                let parts = self.reply();
                if matches!(parts.last(), Some(Part::Text(t) | Part::Thinking(t)) if t.is_empty()) {
                    parts.pop();
                }
            }
            AguiEvent::ToolCallStart(call) => self.reply().push(Part::ToolCall {
                id: call.tool_call_id,
                name: call.tool_call_name,
                arguments: String::new(),
                output: None,
            }),
            AguiEvent::ToolCallArgs(args) => {
                if let Some((arguments, _)) = self.tool_call(&args.tool_call_id) {
                    arguments.push_str(&args.delta);
                }
            }
            AguiEvent::ToolCallResult(result) => {
                if let Some((_, output)) = self.tool_call(&result.tool_call_id) {
                    *output = Some(result.content);
                }
            }
            AguiEvent::ReasoningStart(_)
            | AguiEvent::ReasoningEnd(_)
            | AguiEvent::ToolCallEnd(_) => {}
        }
    }

    /// The human stopped the turn: what came stays, and nothing more is awaited.
    pub fn stop(&mut self) {
        self.running = false;
    }

    /// The last message the human said, as a failed turn sends it again.
    pub fn last_said(&self) -> Option<&Message> {
        self.messages
            .iter()
            .rev()
            .find(|m| m.role == Role::User && m.desktop_said().is_none())
    }
}
