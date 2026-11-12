//! An offer's form: the control each field of its arguments takes, read from the JSON Schema
//! they are drawn as, and what a human's entries send. A copy of `offerFields`,
//! `offerChoices` and `offerInput` in `src/board-model.ts`, which stay its owner.

use crate::App;
use collie_desktop_protocol::generated::OffersSuccessItem;
use rune::{El, TextEdit, col, text};
use rune_kit::{Checkbox, Kit, SegmentedControl, TextArea, TextInput};
use serde_json::{Map, Value};

/// How one field is asked for.
#[derive(Debug, Clone, PartialEq)]
pub enum Control {
    Text,
    Boolean,
    Number,
    Integer,
    /// Strings, one per line.
    List,
    Enum(Vec<Value>),
    Json(Holds),
}

/// What a JSON field's value must be.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Holds {
    Anything,
    Object,
    List,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OfferField {
    pub name: String,
    pub label: String,
    /// The schema's own description.
    pub help: Option<String>,
    pub required: bool,
    pub control: Control,
    /// What the form starts with, as an entry; none starts it unset.
    pub initial: Option<String>,
}

const EMPTY_OPTION: &str = "(empty)";

/// The fields an offer's arguments name, each with the control its schema draws.
pub fn offer_fields(arguments: Option<&Value>) -> Vec<OfferField> {
    let Some(arguments) = arguments else {
        return Vec::new();
    };
    let required: Vec<&str> = arguments["required"]
        .as_array()
        .map(|r| r.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let Some(properties) = arguments["properties"].as_object() else {
        return Vec::new();
    };
    properties
        .iter()
        .map(|(name, schema)| {
            let control = control_of(schema);
            let needed = required.contains(&name.as_str());
            let initial = match schema.get("default") {
                Some(value) => Some(entry_of(&control, value)),
                None if needed && control == Control::Boolean => Some("false".into()),
                None => None,
            };
            OfferField {
                name: name.clone(),
                label: label_of(name),
                help: schema["description"].as_str().map(String::from),
                required: needed,
                control,
                initial,
            }
        })
        .collect()
}

fn control_of(schema: &Value) -> Control {
    if let Some(options) = schema["enum"].as_array() {
        return Control::Enum(options.clone());
    }
    let any_of = schema["anyOf"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    if !any_of.is_empty() && any_of.iter().all(|one| one["enum"].is_array()) {
        return Control::Enum(
            any_of
                .iter()
                .flat_map(|one| one["enum"].as_array().into_iter().flatten().cloned())
                .collect(),
        );
    }
    let number = any_of.iter().any(|one| one["type"] == "number");
    match if number {
        "number"
    } else {
        schema["type"].as_str().unwrap_or("")
    } {
        "string" => Control::Text,
        "boolean" => Control::Boolean,
        "integer" => Control::Integer,
        "number" => Control::Number,
        "array" if schema["items"]["type"] == "string" => Control::List,
        "array" => Control::Json(Holds::List),
        "object" => Control::Json(Holds::Object),
        _ => Control::Json(Holds::Anything),
    }
}

fn label_of(name: &str) -> String {
    let words = name.replace(['_', '-'], " ");
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => words,
    }
}

/// A string option's entry is itself; any other is its JSON.
fn option_entry(option: &Value) -> String {
    option
        .as_str()
        .map_or_else(|| option.to_string(), String::from)
}

fn option_label(option: &Value) -> String {
    if option == "" {
        EMPTY_OPTION.into()
    } else {
        option_entry(option)
    }
}

fn entry_of(control: &Control, value: &Value) -> String {
    match (control, value) {
        (Control::List, Value::Array(items)) if items.iter().all(Value::is_string) => items
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n"),
        (Control::Text | Control::Enum(_), Value::String(text)) => text.clone(),
        _ => value.to_string(),
    }
}

/// The choices a boolean or an enum field is picked from, unset first where it is optional:
/// each label, and the entry it makes.
pub fn offer_choices(field: &OfferField) -> Vec<(String, Option<String>)> {
    let mut choices = Vec::new();
    if !field.required {
        choices.push(("Not set".to_string(), None));
    }
    match &field.control {
        Control::Boolean => {
            choices.push(("Yes".into(), Some("true".into())));
            choices.push(("No".into(), Some("false".into())));
        }
        Control::Enum(options) => {
            for option in options {
                choices.push((option_label(option), Some(option_entry(option))));
            }
        }
        _ => return Vec::new(),
    }
    choices
}

enum Read {
    Unset,
    Value(Value),
    Refused(String),
}

fn read_entry(field: &OfferField, entry: Option<&str>) -> Read {
    let Some(entry) = entry else {
        return Read::Unset;
    };
    if let Control::Enum(options) = &field.control {
        return match options.iter().find(|o| option_entry(o) == entry) {
            Some(option) => Read::Value(option.clone()),
            None => {
                let named: Vec<String> = options.iter().map(option_label).collect();
                Read::Refused(format!("must be one of: {}", named.join(", ")))
            }
        };
    }
    let text = entry.trim();
    if text.is_empty() {
        return Read::Unset;
    }
    match &field.control {
        Control::Text => Read::Value(Value::String(entry.into())),
        Control::Boolean => match text {
            "true" => Read::Value(Value::Bool(true)),
            "false" => Read::Value(Value::Bool(false)),
            _ => Read::Refused("must be yes or no".into()),
        },
        Control::Number | Control::Integer => match text.parse::<f64>() {
            Ok(n) if n.is_finite() => {
                let whole = n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0;
                if field.control == Control::Integer && !whole {
                    Read::Refused("must be a whole number".into())
                } else if whole {
                    Read::Value(Value::from(n as i64))
                } else {
                    Read::Value(Value::from(n))
                }
            }
            _ => Read::Refused("must be a number".into()),
        },
        Control::List => Read::Value(Value::Array(
            entry
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(|line| Value::String(line.into()))
                .collect(),
        )),
        Control::Json(holds) => match serde_json::from_str::<Value>(text) {
            Err(_) => Read::Refused("is not valid JSON".into()),
            Ok(value) => match holds {
                Holds::Object if !value.is_object() => {
                    Read::Refused("must be a JSON object".into())
                }
                Holds::List if !value.is_array() => Read::Refused("must be a JSON list".into()),
                _ => Read::Value(value),
            },
        },
        Control::Enum(_) => unreachable!("an enum is read above"),
    }
}

/// What the entries send, every field read as its control takes it; otherwise why each it
/// refuses cannot be sent, in field order. A missing entry is unset, as is a blank one other
/// than an enum's empty option.
pub fn offer_input(
    arguments: Option<&Value>,
    entries: &[(String, Option<String>)],
) -> Result<Value, Vec<(String, String)>> {
    let mut input = Map::new();
    let mut errors = Vec::new();
    for field in offer_fields(arguments) {
        let entry = entries
            .iter()
            .find(|(name, _)| *name == field.name)
            .and_then(|(_, entry)| entry.as_deref());
        match read_entry(&field, entry) {
            Read::Unset if field.required => {
                errors.push((field.name, format!("{} needs a value", field.label)))
            }
            Read::Unset => {}
            Read::Refused(why) => errors.push((field.name, format!("{} {why}", field.label))),
            Read::Value(value) => {
                input.insert(field.name, value);
            }
        }
    }
    if errors.is_empty() {
        Ok(Value::Object(input))
    } else {
        Err(errors)
    }
}

/// Whether a front door asks before it takes this offer: it has fields, or a confirmation.
pub fn asks_before_taking(offer: &OffersSuccessItem) -> bool {
    offer.confirm.is_some() || !offer_fields(offer.arguments.as_ref()).is_empty()
}

/// One field of an open form: what is typed or chosen, and why it was last refused.
#[derive(Debug, Clone)]
pub struct OfferEntry {
    pub field: OfferField,
    pub edit: TextEdit,
    pub choice: Option<String>,
    pub error: Option<String>,
}

impl OfferEntry {
    pub fn new(field: OfferField) -> OfferEntry {
        let chosen = matches!(field.control, Control::Boolean | Control::Enum(_));
        OfferEntry {
            edit: TextEdit::new(if chosen {
                ""
            } else {
                field.initial.as_deref().unwrap_or("")
            }),
            choice: if chosen { field.initial.clone() } else { None },
            error: None,
            field,
        }
    }

    fn entry(&self) -> Option<String> {
        match self.field.control {
            Control::Boolean | Control::Enum(_) => self.choice.clone(),
            _ => Some(self.edit.text.clone()),
        }
    }
}

/// A form's entries for an offer's arguments, the first that is typed in focused.
pub fn entries_for(arguments: Option<&Value>) -> Vec<OfferEntry> {
    let mut entries: Vec<OfferEntry> = offer_fields(arguments)
        .into_iter()
        .map(OfferEntry::new)
        .collect();
    if let Some(first) = entries.first_mut() {
        first.edit.focused = true;
    }
    entries
}

/// The input the form sends, or none, with each field it refuses marked with why.
pub fn read_form(arguments: Option<&Value>, fields: &mut [OfferEntry]) -> Option<Value> {
    let entries: Vec<(String, Option<String>)> = fields
        .iter()
        .map(|f| (f.field.name.clone(), f.entry()))
        .collect();
    let read = offer_input(arguments, &entries);
    for field in fields.iter_mut() {
        field.error = read.as_ref().err().and_then(|errors| {
            errors
                .iter()
                .find(|(name, _)| *name == field.field.name)
                .map(|(_, why)| why.clone())
        });
    }
    read.ok()
}

/// Where an open form keeps its entries, for its controls to write to.
pub type EntriesOf = fn(&mut App) -> &mut Vec<OfferEntry>;

/// Each field's label, control, help and refusal, keyed under `prefix`.
pub fn controls(
    fields: &[OfferEntry],
    of: EntriesOf,
    submit: fn(&mut App),
    prefix: &str,
    k: &Kit,
) -> Vec<El> {
    fields
        .iter()
        .enumerate()
        .map(|(at, entry)| {
            let field = &entry.field;
            let key = format!("{prefix}{}", field.name);
            let title = if field.required {
                format!("{} *", field.label)
            } else {
                field.label.clone()
            };
            let control = match &field.control {
                Control::Boolean if field.required => {
                    Checkbox::new(entry.choice.as_deref() == Some("true"))
                        .label(field.label.clone())
                        .hide_label()
                        .on_toggle(move |app: &mut App| {
                            let entry = &mut of(app)[at];
                            let on = entry.choice.as_deref() == Some("true");
                            entry.choice = Some((!on).to_string());
                        })
                        .build(k)
                }
                Control::Boolean | Control::Enum(_) => {
                    let choices = offer_choices(field);
                    let labels: Vec<&str> = choices.iter().map(|(l, _)| l.as_str()).collect();
                    let current = choices.iter().position(|(_, e)| *e == entry.choice);
                    SegmentedControl::new(&labels, current)
                        .label(field.label.clone())
                        .fit()
                        .on_pick(move |app: &mut App, picked, _| {
                            let entry = &mut of(app)[at];
                            entry.choice = offer_choices(&entry.field)
                                .into_iter()
                                .nth(picked)
                                .and_then(|(_, e)| e);
                        })
                        .build(k)
                }
                Control::List | Control::Json(_) => TextArea::new(&entry.edit)
                    .rows(3)
                    .label(field.label.clone())
                    .placeholder(if field.control == Control::List {
                        "One per line"
                    } else {
                        "JSON"
                    })
                    .on_edit(move |app: &mut App| &mut of(app)[at].edit)
                    .build(k),
                Control::Text | Control::Number | Control::Integer => TextInput::new(&entry.edit)
                    .width(None)
                    .label(field.label.clone())
                    .invalid(entry.error.is_some())
                    .on_edit(move |app: &mut App| &mut of(app)[at].edit)
                    .on_submit(move |app: &mut App, _: &mut rune::Tx| submit(app))
                    .build(k),
            };
            col()
                .gap(4.0)
                .w_full()
                .child(
                    text(title)
                        .font(k.ty.small_medium)
                        .color(k.c.text_muted)
                        .a11y_hidden(),
                )
                .child(control.key(key.clone()))
                .children(field.help.clone().map(|help| {
                    text(help)
                        .key(format!("{key}-help"))
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_muted)
                        .wrap()
                        .w_full()
                }))
                .children(entry.error.clone().map(|why| {
                    text(why)
                        .key(format!("{key}-error"))
                        .role("alert")
                        .font(k.ty.text_xsmall)
                        .color(k.c.danger.fg)
                        .wrap()
                        .w_full()
                }))
        })
        .collect()
}
