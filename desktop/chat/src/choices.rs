//! The chat's harness, model and effort selects, the notices a choice gives before the next
//! message, and what Stop gives back to the composer: `chat-choices.ts`.

use crate::attachments::Attached;
use crate::words::harness_name;
use collie_desktop_protocol::generated::{
    About, ChatChoicesSuccess, From as Resolved, Harnesse, Model, Offered, Offered1, Offered1From,
    SetSettingsPayload, SettingsSuccess,
};

pub const DEFAULT_CHAT_HARNESS: &str = "claude";
/// The model id that leaves the choice to the harness.
pub const DEFAULT_MODEL: &str = "default";

/// The efforts Collie's table lists for a harness, where its own list says nothing.
fn table_efforts(harness: &str) -> &'static [&'static str] {
    match harness {
        "claude" => &["low", "medium", "high", "xhigh", "max"],
        "pi" => &["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        _ => &[],
    }
}

/// The chat's choice as set, each part unset where it is `None`.
#[derive(Debug, Clone, PartialEq)]
pub struct SetChoice {
    pub harness: String,
    pub model: Option<String>,
    pub effort: Option<String>,
}

fn set_choice(settings: &SettingsSuccess) -> SetChoice {
    SetChoice {
        harness: settings
            .chat_harness
            .clone()
            .unwrap_or_else(|| DEFAULT_CHAT_HARNESS.into()),
        model: settings.chat_model.clone(),
        effort: settings.chat_effort.clone(),
    }
}

/// The efforts `model` lists: its offered entry's, else the table's for its harness.
pub fn efforts_of(harness: &str, model: &str, offered: &[Model]) -> Vec<String> {
    match offered.iter().find(|m| m.id == model) {
        Some(found) => found.efforts.clone(),
        None => table_efforts(harness)
            .iter()
            .map(|e| e.to_string())
            .collect(),
    }
}

/// What a set choice runs as, by the resolver's answers in what its harness offers.
pub fn runs_as_offered(set: &SetChoice, offer: &Offered1) -> Resolved {
    let model = match set.model.as_deref() {
        None | Some(DEFAULT_MODEL) => offer.unset.model.clone(),
        Some(model) => model.into(),
    };
    let effort = if efforts_of(&set.harness, &model, &offer.models).is_empty() {
        None
    } else {
        set.effort.clone().or_else(|| {
            offer
                .models
                .iter()
                .find(|m| m.id == model)
                .and_then(|m| m.unset_effort.clone())
                .or_else(|| {
                    offer
                        .typed
                        .as_ref()
                        .filter(|t| t.model == model)
                        .and_then(|t| t.effort.clone())
                })
                .or_else(|| offer.unset.effort.clone())
                .or_else(|| Some("medium".into()))
        })
    };
    Resolved {
        harness: set.harness.clone(),
        model,
        effort,
    }
}

/// One entry of a select; a disabled one says why in its description.
#[derive(Debug, Clone, PartialEq)]
pub struct ChoiceOption {
    /// Empty is the select's default, which unsets it.
    pub value: String,
    pub label: String,
    pub description: Option<String>,
    pub disabled: bool,
}

impl ChoiceOption {
    pub fn new(value: impl Into<String>, label: impl Into<String>) -> ChoiceOption {
        ChoiceOption {
            value: value.into(),
            label: label.into(),
            description: None,
            disabled: false,
        }
    }

    fn described(mut self, description: impl Into<String>) -> ChoiceOption {
        self.description = Some(description.into());
        self
    }
}

/// A select beside the message box, as its trigger and menu show it.
#[derive(Debug, Clone, PartialEq)]
pub struct ChoiceSelect {
    pub value: String,
    /// The trigger's text.
    pub label: String,
    /// The trigger's accessible name, carrying its value.
    pub name: String,
    pub options: Vec<ChoiceOption>,
    /// The menu's last line.
    pub note: Option<String>,
    /// The harness's models are still being read.
    pub reading: bool,
    pub warning: Option<String>,
    pub disabled: bool,
}

pub fn effort_label(effort: &str) -> String {
    if effort == "xhigh" {
        return "Extra high".into();
    }
    let mut chars = effort.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn select(
    name: &str,
    value: &str,
    label: &str,
    options: Vec<ChoiceOption>,
    note: Option<String>,
) -> ChoiceSelect {
    ChoiceSelect {
        value: value.into(),
        label: label.into(),
        name: format!("{name}: {label}"),
        options,
        note,
        reading: false,
        warning: None,
        disabled: false,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Selects {
    pub harness: ChoiceSelect,
    pub model: ChoiceSelect,
    pub effort: ChoiceSelect,
}

fn offer_of(entry: &Harnesse) -> Option<&Offered1> {
    match &entry.offered {
        Offered::Offered1(offer) => Some(offer),
        Offered::Reading(_) => None,
    }
}

/// The harness, model and effort selects, as the settings and the chat's account have them.
pub fn chat_selects(settings: &SettingsSuccess, choices: Option<&ChatChoicesSuccess>) -> Selects {
    let harness = settings
        .chat_harness
        .clone()
        .unwrap_or_else(|| DEFAULT_CHAT_HARNESS.into());
    let entry = choices.and_then(|c| c.harnesses.iter().find(|one| one.harness == harness));
    let harness_select = select(
        "Harness",
        &harness,
        &entry.map_or_else(|| harness_name(&harness), |e| e.label.clone()),
        choices
            .map(|c| {
                c.harnesses
                    .iter()
                    .map(|one| match one.installed {
                        true => ChoiceOption::new(&one.harness, &one.label),
                        false => ChoiceOption {
                            disabled: true,
                            ..ChoiceOption::new(&one.harness, &one.label)
                                .described("Not installed on this computer")
                        },
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Some("Another harness starts a new conversation with your next message.".into()),
    );
    let set = settings.chat_model.clone();
    let effort_set = settings.chat_effort.clone();
    let Some((entry, offer)) = entry.and_then(|e| offer_of(e).map(|o| (e, o))) else {
        let mut options = vec![ChoiceOption::new("", "Default")];
        options.extend(set.iter().map(|s| ChoiceOption::new(s, s)));
        let mut model = select(
            "Model",
            set.as_deref().unwrap_or(""),
            set.as_deref().unwrap_or("Default"),
            options,
            entry.map(|e| {
                format!(
                    "Reading {}'s models… You can still type a model id.",
                    e.label
                )
            }),
        );
        model.reading = entry.is_some();
        return Selects {
            harness: harness_select,
            model,
            effort: select(
                "Effort",
                effort_set.as_deref().unwrap_or(""),
                &effort_set
                    .as_deref()
                    .map_or_else(|| "Default".into(), effort_label),
                Vec::new(),
                None,
            ),
        };
    };
    let model_label = |id: &str| -> String {
        match offer.models.iter().find(|m| m.id == id) {
            Some(found) => found.label.clone(),
            None if id == DEFAULT_MODEL => format!("{}'s own", entry.label),
            None => id.into(),
        }
    };
    let unset_model = format!("Default · {}", model_label(&offer.unset.model));
    let mut options =
        vec![ChoiceOption::new("", &unset_model).described("What the chat runs with no model set")];
    options.extend(offer.models.iter().map(|m| ChoiceOption {
        description: m.description.clone(),
        ..ChoiceOption::new(&m.id, &m.label)
    }));
    if let Some(set) = set
        .as_deref()
        .filter(|s| !offer.models.iter().any(|m| m.id == *s))
    {
        options.push(ChoiceOption::new(set, set));
    }
    let mut model = select(
        "Model",
        set.as_deref().unwrap_or(""),
        &set.as_deref()
            .map_or_else(|| unset_model.clone(), model_label),
        options,
        Some(match offer.from {
            Offered1From::Table => "Collie's table, so models are named by id".into(),
            Offered1From::Harness => format!("Listed by {} on this computer", entry.label),
        }),
    );
    if let (Offered1From::Table, Some(why)) = (&offer.from, &offer.why) {
        model.warning = Some(format!(
            "{}'s list could not be read: {}. Showing Collie's table, so models are named by id.",
            entry.label,
            why.strip_suffix('.').unwrap_or(why)
        ));
    }
    let runs = runs_as_offered(
        &SetChoice {
            harness: harness.clone(),
            model: set.clone(),
            effort: None,
        },
        offer,
    );
    let Some(runs_effort) = runs.effort.as_deref() else {
        let none = format!("{} takes no effort", model_label(&runs.model));
        return Selects {
            harness: harness_select,
            model,
            effort: ChoiceSelect {
                value: String::new(),
                name: format!("Effort: none. {none}"),
                label: none,
                options: Vec::new(),
                note: None,
                reading: false,
                warning: None,
                disabled: true,
            },
        };
    };
    let unset_effort = format!("Default · {}", effort_label(runs_effort));
    let mut options = vec![
        ChoiceOption::new("", &unset_effort).described("What the chat runs with no effort set"),
    ];
    options.extend(
        efforts_of(&harness, &runs.model, &offer.models)
            .iter()
            .map(|e| ChoiceOption::new(e, effort_label(e))),
    );
    Selects {
        harness: harness_select,
        model,
        effort: select(
            "Effort",
            effort_set.as_deref().unwrap_or(""),
            &effort_set
                .as_deref()
                .map_or_else(|| unset_effort.clone(), effort_label),
            options,
            Some(format!("The levels {} takes", model_label(&runs.model))),
        ),
    }
}

/// A typed id offered to save, where it is not already an option.
pub fn typed_entry(search: &str, model: &ChoiceSelect) -> Option<ChoiceOption> {
    let id = search.trim();
    (!id.is_empty() && !model.options.iter().any(|o| o.value == id))
        .then(|| ChoiceOption::new(id, format!("Use {id}")))
}

/// A refused choice, as the alert above the message box says it.
pub fn refusal_said(reason: &str) -> String {
    format!(
        "{}. Nothing was saved.",
        reason.strip_suffix('.').unwrap_or(reason)
    )
}

/// The last choice this window saw set on the conversation's harness.
pub fn remember_choice(
    remembered: Option<SetChoice>,
    settings: &SettingsSuccess,
    choices: Option<&ChatChoicesSuccess>,
) -> Option<SetChoice> {
    let Some(choices) = choices else {
        return remembered;
    };
    let set = set_choice(settings);
    if set.harness == choices.held_on {
        Some(set)
    } else {
        remembered.filter(|r| r.harness == choices.held_on)
    }
}

/// The ordinary settings change Stay sends through the choice check.
pub fn stay_on(choices: &ChatChoicesSuccess, remembered: Option<&SetChoice>) -> SetSettingsPayload {
    let same = remembered.filter(|r| r.harness == choices.held_on);
    SetSettingsPayload {
        chat_harness: Some(choices.held_on.clone()),
        chat_model: same.map(|r| r.model.clone().unwrap_or_default()),
        chat_effort: same.map(|r| r.effort.clone().unwrap_or_default()),
        ..empty_change()
    }
}

pub fn empty_change() -> SetSettingsPayload {
    SetSettingsPayload {
        gitlab_host: None,
        zoom: None,
        chat_harness: None,
        chat_model: None,
        chat_effort: None,
        chat_width: None,
        record_timing: None,
        setup_not_now: None,
        setup_never: None,
    }
}

fn resolved_label(runs: &Resolved, choices: &ChatChoicesSuccess) -> String {
    let entry = choices.harnesses.iter().find(|h| h.harness == runs.harness);
    let fallback = if runs.model == DEFAULT_MODEL {
        format!(
            "{}'s own",
            entry.map_or_else(|| harness_name(&runs.harness), |e| e.label.clone())
        )
    } else {
        runs.model.clone()
    };
    let model = entry
        .and_then(offer_of)
        .and_then(|offer| offer.models.iter().find(|m| m.id == runs.model))
        .map_or(fallback, |m| m.label.clone());
    match &runs.effort {
        None => model,
        Some(effort) => format!("{model} · {}", effort_label(effort)),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Waiting {
    pub text: String,
    pub stay_label: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReplyChoice {
    pub current: String,
    pub next: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Notices {
    pub waiting: Option<Waiting>,
    pub reply: Option<ReplyChoice>,
}

/// What a choice will do before the next message.
pub fn choice_notices(settings: &SettingsSuccess, choices: Option<&ChatChoicesSuccess>) -> Notices {
    let set = set_choice(settings);
    let waiting = choices
        .filter(|c| set.harness != c.held_on)
        .map(|c| Waiting {
            text: format!(
                "Your next message starts a new conversation on {}.",
                harness_name(&set.harness)
            ),
            stay_label: format!("Stay on {}", harness_name(&c.held_on)),
        });
    let Some(choices) = choices.filter(|c| c.turning) else {
        return Notices {
            waiting,
            reply: None,
        };
    };
    let offer = choices
        .harnesses
        .iter()
        .find(|h| h.harness == set.harness)
        .and_then(offer_of);
    let (Some(runs), Some(offer)) = (choices.runs_on.as_ref(), offer) else {
        return Notices {
            waiting,
            reply: None,
        };
    };
    let next = runs_as_offered(&set, offer);
    if *runs == next {
        return Notices {
            waiting,
            reply: None,
        };
    }
    let current = resolved_label(runs, choices);
    let next = resolved_label(&next, choices);
    Notices {
        waiting,
        reply: Some(ReplyChoice {
            text: format!("This reply finishes on {current}. Your next message runs on {next}."),
            current,
            next,
        }),
    }
}

/// The message box's last button: Stop while the human's reply streams, else Send.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReplyButton {
    pub stops: bool,
    pub name: &'static str,
}

/// Desktop's own turn about News is no reply of the human's to stop (`replyButton`).
pub fn reply_button(replying: bool, desktop_speaking: bool) -> ReplyButton {
    if replying && !desktop_speaking {
        ReplyButton {
            stops: true,
            name: "Stop the reply",
        }
    } else {
        ReplyButton {
            stops: false,
            name: "Send",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ChatStatus {
    pub replying: bool,
    pub notices: Vec<String>,
}

/// A status change spoken once, without a completion message over the finished reply.
pub fn chat_announcement(before: Option<&ChatStatus>, after: &ChatStatus, stopped: bool) -> String {
    let mut said = Vec::new();
    if stopped {
        said.push("Reply stopped".to_string());
    } else if after.replying && !before.is_some_and(|b| b.replying) {
        said.push("Replying…".into());
    }
    said.extend(
        after
            .notices
            .iter()
            .filter(|n| !before.is_some_and(|b| b.notices.contains(n)))
            .cloned(),
    );
    said.join(" ")
}

/// A message held until the turn under way ends.
#[derive(Debug, Clone, PartialEq)]
pub struct Queued {
    pub id: u64,
    pub text: String,
    pub files: Vec<Attached>,
    pub about: Option<About>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Draft {
    pub text: String,
    pub files: Vec<Attached>,
    pub about: Option<About>,
}

/// What Stop recovers before the queue is dropped: queued words in order before the draft,
/// each file once, and the earliest card only where the chip is empty.
pub fn stop_draft(queue: &[Queued], draft: Draft) -> Draft {
    let mut words = Vec::new();
    let mut files: Vec<Attached> = Vec::new();
    let mut about = draft.about;
    for queued in queue {
        if !queued.text.is_empty() {
            words.push(queued.text.clone());
        }
        files.extend(queued.files.iter().cloned());
        if about.is_none() {
            about = queued.about.clone();
        }
    }
    if !draft.text.is_empty() {
        words.push(draft.text);
    }
    let mut seen = Vec::new();
    files.extend(draft.files);
    files.retain(|f| {
        let fresh = !seen.contains(&f.id);
        seen.push(f.id.clone());
        fresh
    });
    Draft {
        text: words.join("\n\n"),
        files,
        about,
    }
}
