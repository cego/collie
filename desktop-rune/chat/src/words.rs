//! What the Flock chat says of a tool call, a question, a harness and the card a message is
//! about: `chat-view.ts`.

use collie_desktop_protocol::generated::{About, EarlierItem};
use serde::Deserialize;

/// How a turn Desktop starts about News begins, which is how the chat tells it from the human's.
pub const DESKTOP_SAID: &str = "Desktop noticed, while you were not asked:";

/// Each harness the chat runs on, by the name its maker gives it.
pub fn harness_name(harness: &str) -> String {
    match harness {
        "codex" => "Codex",
        "opencode" => "OpenCode",
        "claude" => "Claude Code",
        "pi" => "Pi",
        other => other,
    }
    .into()
}

pub fn about_line(about: &About) -> String {
    format!("{} › {}", about.machine, about.name)
}

/// What Desktop said of its own about News, after its first line; none for anyone else's text.
pub fn desktop_said(text: &str) -> Option<&str> {
    text.strip_prefix(DESKTOP_SAID).map(str::trim)
}

/// What opening a conversation held on another harness than `set` does, where one is listed.
pub fn earlier_note(earlier: &[EarlierItem], set: &str) -> Option<String> {
    let mut others: Vec<String> = Vec::new();
    for one in earlier.iter().filter(|one| one.harness != set) {
        let name = harness_name(&one.harness);
        if !others.contains(&name) {
            others.push(name);
        }
    }
    match others.as_slice() {
        [] => None,
        [one] => Some(format!(
            "Opening a {one} conversation moves the chat to {one}."
        )),
        many => Some(format!(
            "Opening a {} conversation moves the chat to its harness.",
            many.join(" or ")
        )),
    }
}

#[derive(Deserialize, Default)]
struct Named {
    run: Option<String>,
    workspace: Option<String>,
}

#[derive(Deserialize)]
struct Action {
    kind: String,
    #[serde(flatten)]
    named: Named,
}

#[derive(Deserialize, Default)]
struct Asked {
    #[serde(flatten)]
    named: Named,
    reason: Option<String>,
    actions: Option<Vec<Action>>,
}

/// An id as the chat's tools name it: `machine:id`, or an id alone.
fn split(id: &str) -> (Option<&str>, &str) {
    match id.split_once(':') {
        Some((machine, id)) => (Some(machine), id),
        None => (None, id),
    }
}

fn ids(named: &Named) -> impl Iterator<Item = &str> {
    named
        .run
        .iter()
        .chain(named.workspace.iter())
        .map(String::as_str)
}

/// A tool call as one row: the tool, the Machines its ids name, and a short summary of the rest.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolRow {
    pub tool: String,
    pub machine: Option<String>,
    pub summary: String,
}

pub fn tool_row(name: &str, args: &str) -> ToolRow {
    let tool = name
        .strip_prefix("mcp__collie__")
        .map(|rest| rest.strip_prefix("collie_").unwrap_or(rest))
        .unwrap_or(name)
        .to_string();
    let asked: Asked = serde_json::from_str(args).unwrap_or_default();
    let actions = asked.actions.as_deref().unwrap_or_default();
    let mut machines: Vec<&str> = Vec::new();
    for id in ids(&asked.named).chain(actions.iter().flat_map(|a| ids(&a.named))) {
        if let (Some(machine), _) = split(id)
            && !machines.contains(&machine)
        {
            machines.push(machine);
        }
    }
    let named = |named: &Named| {
        ids(named)
            .map(|id| split(id).1.to_string())
            .collect::<Vec<_>>()
    };
    let summary = match &asked.actions {
        None => [named(&asked.named), asked.reason.iter().cloned().collect()]
            .concat()
            .join(" · "),
        Some(actions) => actions
            .iter()
            .map(|action| {
                [vec![action.kind.clone()], named(&action.named)]
                    .concat()
                    .join(" ")
            })
            .collect::<Vec<_>>()
            .join(", "),
    };
    ToolRow {
        tool,
        machine: (!machines.is_empty()).then(|| machines.join(", ")),
        summary,
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Question {
    pub question: String,
    pub header: String,
    pub options: Vec<QuestionOption>,
    #[serde(rename = "multiSelect", default)]
    pub multi_select: bool,
}

#[derive(Deserialize)]
struct Questions {
    questions: Vec<Question>,
}

/// What an AskUserQuestion call asks, once its arguments have all arrived.
pub fn questions_of(args: &str) -> Vec<Question> {
    serde_json::from_str::<Questions>(args)
        .map(|q| q.questions)
        .unwrap_or_default()
}

/// A tool call's output as the row shows it: text as it is, anything else as pretty JSON.
pub fn output_of(output: &serde_json::Value) -> String {
    match output {
        serde_json::Value::String(text) => text.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}
