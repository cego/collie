//! The Flock chat's transcript, folded from the AG-UI events `say` streams, where Desktop's
//! view has TanStack AI's client: one assistant message a turn, its parts in the order said.

use collie_desktop_protocol::generated::AguiEvent;

#[derive(Debug, Clone, PartialEq)]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Part {
    Text(String),
    Thinking(String),
    ToolCall {
        id: String,
        name: String,
        arguments: String,
        output: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub role: Role,
    pub parts: Vec<Part>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Transcript {
    pub messages: Vec<Message>,
    /// Why the last turn failed, until the next is said.
    pub error: Option<String>,
    pub running: bool,
}

impl Transcript {
    pub fn say(&mut self, text: &str) {
        self.messages.push(Message {
            role: Role::User,
            parts: vec![Part::Text(text.into())],
        });
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
            self.messages.push(Message {
                role: Role::Assistant,
                parts: Vec::new(),
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
}
