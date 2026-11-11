//! Who does the work: the Flock's harness, model, effort and fallbacks, offered from what
//! each Machine's harnesses report. Ported from `desktop/src/shared/settings-agents.ts`.

use super::registry::HARNESS_NAMES;
use super::time::when_of;
use collie_desktop_protocol::generated::{CataloguesSuccessItem, Entrie, EntrieFrom};
use std::collections::BTreeSet;

pub const DEFAULT_MODEL: &str = "default";

/// The model a harness pins for `default`, where it pins one.
pub fn pinned_default(harness: &str) -> Option<&'static str> {
    (harness == "claude").then_some("opus")
}

pub fn harness_name(harness: &str) -> String {
    match harness {
        "codex" => "Codex",
        "opencode" => "OpenCode",
        "claude" => "Claude Code",
        "pi" => "Pi",
        other => other,
    }
    .to_string()
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct ChoiceOption {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
    pub disabled: bool,
}

fn option(value: impl Into<String>, label: impl Into<String>) -> ChoiceOption {
    ChoiceOption {
        value: value.into(),
        label: label.into(),
        ..Default::default()
    }
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct ChoiceSelect {
    pub value: String,
    pub label: String,
    pub name: String,
    pub options: Vec<ChoiceOption>,
    pub note: String,
    pub disabled: bool,
    pub warning: Option<String>,
}

/// The agent choice as set, each part empty where it is unset.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct AgentSettings {
    pub harness: String,
    pub model: String,
    pub effort: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AgentSelects {
    pub harness: ChoiceSelect,
    pub model: ChoiceSelect,
    pub effort: ChoiceSelect,
    pub lead: String,
}

struct Source<'a> {
    profile: &'a str,
    entries: &'a [Entrie],
}

struct Held<'a> {
    id: String,
    entry: &'a Entrie,
    machines: BTreeSet<String>,
    efforts: Vec<(String, BTreeSet<String>)>,
    origins: Vec<String>,
}

fn add_effort(efforts: &mut Vec<(String, BTreeSet<String>)>, effort: &str, profile: &str) {
    match efforts.iter_mut().find(|(e, _)| e == effort) {
        Some((_, on)) => {
            on.insert(profile.into());
        }
        None => efforts.push((effort.into(), BTreeSet::from([profile.to_string()]))),
    }
}

struct Merged<'a> {
    harness: &'static str,
    sources: Vec<Source<'a>>,
    models: Vec<Held<'a>>,
}

fn count(n: usize, total: usize) -> String {
    format!("{n} of {total} Machines")
}

fn merge<'a>(live: &[&'a CataloguesSuccessItem], set_model: &str) -> Vec<Merged<'a>> {
    HARNESS_NAMES
        .iter()
        .map(|&harness| {
            let mut sources = Vec::new();
            let mut models: Vec<Held> = Vec::new();
            for reading in live {
                for catalogue in reading.catalogues.iter().filter(|c| c.harness == harness) {
                    sources.push(Source {
                        profile: &reading.profile,
                        entries: &catalogue.entries,
                    });
                    for entry in &catalogue.entries {
                        if entry.hidden && entry.model != set_model {
                            continue;
                        }
                        let at = match models.iter().position(|m| m.id == entry.model) {
                            Some(at) => at,
                            None => {
                                models.push(Held {
                                    id: entry.model.clone(),
                                    entry,
                                    machines: BTreeSet::new(),
                                    efforts: Vec::new(),
                                    origins: Vec::new(),
                                });
                                models.len() - 1
                            }
                        };
                        let held = &mut models[at];
                        held.machines.insert(reading.profile.clone());
                        let origin = match entry.from {
                            EntrieFrom::Added => format!("Added by models.{harness}"),
                            EntrieFrom::Table => format!(
                                "From Collie's table: {}",
                                catalogue.table.clone().unwrap_or_default()
                            ),
                            EntrieFrom::Harness => "Reported by harness".into(),
                        };
                        if !held.origins.contains(&origin) {
                            held.origins.push(origin);
                        }
                        for effort in &entry.efforts {
                            add_effort(&mut held.efforts, effort, &reading.profile);
                        }
                    }
                }
            }
            Merged {
                harness,
                sources,
                models,
            }
        })
        .collect()
}

/// The harness, model and effort selects for every step's agent, from the catalogues of
/// the Machines named by `profiles`, said at `now` on a clock `offset` minutes east of UTC.
pub fn agent_selects(
    readings: &[CataloguesSuccessItem],
    profiles: &[String],
    set: &AgentSettings,
    now: f64,
    offset: i64,
) -> AgentSelects {
    let live: Vec<&CataloguesSuccessItem> = readings
        .iter()
        .filter(|r| profiles.contains(&r.profile))
        .collect();
    let merged = merge(&live, &set.model);
    let total = profiles.len();
    let selected = merged.iter().find(|m| m.harness == set.harness);

    let harness = ChoiceSelect {
        value: set.harness.clone(),
        label: harness_name(&set.harness),
        name: format!("Harness: {}", harness_name(&set.harness)),
        options: merged
            .iter()
            .map(|m| {
                let installed = !m.sources.is_empty();
                ChoiceOption {
                    value: m.harness.into(),
                    label: harness_name(m.harness),
                    description: Some(if installed {
                        count(m.sources.len(), total)
                    } else {
                        "Not reported on any Machine".into()
                    }),
                    disabled: !installed,
                }
            })
            .collect(),
        note: "The harness for every step unless it names its own".into(),
        disabled: false,
        warning: None,
    };

    let held = |id: &str| selected.and_then(|s| s.models.iter().find(|m| m.id == id));
    let model_label = |id: &str| match held(id) {
        Some(m) => m.entry.label.clone(),
        None if id == DEFAULT_MODEL => format!("{}'s own", harness_name(&set.harness)),
        None => id.to_string(),
    };
    let unset_model = format!(
        "Default · {}",
        model_label(pinned_default(&set.harness).unwrap_or(DEFAULT_MODEL))
    );
    let model_set = (!set.model.is_empty()).then_some(set.model.as_str());
    let mut model_options = vec![ChoiceOption {
        description: Some("The harness's default model for workflow steps".into()),
        ..option("", unset_model.clone())
    }];
    for m in selected.map_or(&[][..], |s| &s.models[..]) {
        let mut parts = vec![count(m.machines.len(), total)];
        parts.extend(m.origins.iter().cloned());
        parts.extend(m.entry.description.clone());
        model_options.push(ChoiceOption {
            description: Some(parts.join(" · ")),
            ..option(m.id.clone(), m.entry.label.clone())
        });
    }
    if let Some(set) = model_set
        && !model_options.iter().any(|o| o.value == set)
    {
        model_options.push(option(set, set));
    }
    let effective = match model_set {
        Some(m) if m != DEFAULT_MODEL => m.to_string(),
        _ => pinned_default(&set.harness)
            .unwrap_or(DEFAULT_MODEL)
            .to_string(),
    };
    let picked = held(&effective);
    let base_label = model_set.map_or(unset_model.clone(), model_label);
    let model = ChoiceSelect {
        value: set.model.clone(),
        name: format!("Model: {base_label}"),
        label: match picked {
            Some(p) => format!("{base_label} · {}", count(p.machines.len(), total)),
            None => base_label,
        },
        options: model_options,
        note: "Models and availability reported across the Flock".into(),
        disabled: false,
        warning: match model_set {
            Some(m) if m != DEFAULT_MODEL && held(m).is_none() => Some(format!(
                "{m} is not reported on any Machine. A step on it would not start unless it is added under Advanced."
            )),
            _ => None,
        },
    };

    let mut efforts = picked.map_or(Vec::new(), |p| p.efforts.clone());
    if model_set.is_none_or(|m| m == DEFAULT_MODEL) && pinned_default(&set.harness).is_none() {
        for source in selected.map_or(&[][..], |s| &s.sources[..]) {
            let listed: Vec<&String> =
                match source.entries.iter().find(|e| e.is_default == Some(true)) {
                    Some(default) => default.efforts.iter().collect(),
                    None => source.entries.iter().flat_map(|e| &e.efforts).collect(),
                };
            for effort in listed {
                add_effort(&mut efforts, effort, source.profile);
            }
        }
    }
    let unset_effort = "Default · the harness decides";
    let mut effort_options = vec![option("", unset_effort)];
    effort_options.extend(efforts.iter().map(|(value, on)| ChoiceOption {
        description: Some(count(on.len(), total)),
        ..option(value.clone(), value.clone())
    }));
    let effort = ChoiceSelect {
        value: set.effort.clone(),
        label: if efforts.is_empty() {
            "No effort listed".into()
        } else if set.effort.is_empty() {
            unset_effort.into()
        } else {
            set.effort.clone()
        },
        name: format!(
            "Effort: {}",
            if set.effort.is_empty() {
                "default"
            } else {
                &set.effort
            }
        ),
        options: effort_options,
        note: "The efforts reported for this model across the Flock".into(),
        disabled: efforts.is_empty(),
        warning: None,
    };

    let mut times: Vec<&str> = live
        .iter()
        .filter(|r| r.problem.is_none())
        .flat_map(|r| r.catalogues.iter().map(|c| c.at.as_str()))
        .collect();
    if times.is_empty() {
        times = live
            .iter()
            .flat_map(|r| r.catalogues.iter().map(|c| c.at.as_str()))
            .collect();
    }
    times.sort();
    let mut lead = vec![match times.first() {
        None => "No harness catalogues available yet.".to_string(),
        Some(first) => format!(
            "Catalogues read {} · {} of {total} Machines read",
            when_of(first, now, offset),
            live.iter().filter(|r| !r.catalogues.is_empty()).count()
        ),
    }];
    for r in &live {
        if r.catalogues.is_empty() {
            lead.push(match &r.problem {
                None => format!("{}: no harnesses reported", r.name),
                Some(p) if p == "not read yet" => format!("{} not read yet", r.name),
                Some(p) => format!("{} not read yet: {p}", r.name),
            });
        } else if let Some(problem) = &r.problem {
            let at = r
                .catalogues
                .iter()
                .map(|c| c.at.as_str())
                .min()
                .unwrap_or("");
            lead.push(format!(
                "{}'s at {}: {problem}",
                r.name,
                when_of(at, now, offset)
            ));
        }
    }
    AgentSelects {
        harness,
        model,
        effort,
        lead: lead.join(" · "),
    }
}

/// What choosing `value` for `key` saves together: a new harness drops the model and
/// effort, and a new model drops an effort it does not list.
pub fn agent_changes(
    catalogues: &[CataloguesSuccessItem],
    profiles: &[String],
    current: &AgentSettings,
    key: &str,
    value: &str,
) -> Vec<(String, String)> {
    let mut next = current.clone();
    if next.model.is_empty() {
        next.model = DEFAULT_MODEL.into();
    }
    match key {
        "harness" => next.harness = value.into(),
        "model" => next.model = value.into(),
        _ => next.effort = value.into(),
    }
    if key == "harness" && value != current.harness {
        next.model = DEFAULT_MODEL.into();
        next.effort = String::new();
    }
    if key == "model" {
        let selects = agent_selects(catalogues, profiles, &next, 0.0, 0);
        if !selects
            .effort
            .options
            .iter()
            .any(|o| o.value == next.effort)
        {
            next.effort = String::new();
        }
    }
    vec![
        ("harness".into(), next.harness),
        ("model".into(), next.model),
        ("effort".into(), next.effort),
    ]
}

/// A change to the fallbacks list.
#[derive(Clone, Debug, PartialEq)]
pub enum Fallback {
    Add(String),
    Up(usize),
    Down(usize),
    Remove(usize),
}

pub fn fallback_values(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(String::from)
        .collect()
}

pub fn change_fallbacks(value: &str, change: &Fallback) -> String {
    let mut values = fallback_values(value);
    let n = values.len();
    match change {
        Fallback::Add(add) => {
            if !add.is_empty() && !values.contains(add) {
                values.push(add.clone());
            }
        }
        Fallback::Remove(at) if *at < n => {
            values.remove(*at);
        }
        Fallback::Up(at) if *at < n && *at > 0 => values.swap(*at, at - 1),
        Fallback::Down(at) if at + 1 < n => values.swap(*at, at + 1),
        _ => {}
    }
    values.join(", ")
}

/// What the Add a fallback list offers: each reported harness, with its default model and
/// each of its models, but those already listed.
pub fn fallback_options(
    value: &str,
    catalogues: &[CataloguesSuccessItem],
    profiles: &[String],
) -> Vec<ChoiceOption> {
    let listed = fallback_values(value);
    HARNESS_NAMES
        .iter()
        .flat_map(|&harness| {
            let selects = agent_selects(
                catalogues,
                profiles,
                &AgentSettings {
                    harness: harness.into(),
                    ..Default::default()
                },
                0.0,
                0,
            );
            if selects
                .harness
                .options
                .iter()
                .any(|o| o.value == harness && o.disabled)
            {
                return Vec::new();
            }
            let name = harness_name(harness);
            let mut options = vec![option(harness, format!("{name} · its default model"))];
            options.extend(
                selects
                    .model
                    .options
                    .into_iter()
                    .filter(|o| !o.value.is_empty())
                    .map(|o| ChoiceOption {
                        value: format!("{harness}/{}", o.value),
                        label: format!("{name} · {}", o.label),
                        ..o
                    }),
            );
            options
        })
        .filter(|o| !listed.contains(&o.value))
        .collect()
}

/// Each Machine's catalogue as last read, kept over a failed read, in the board's order.
pub fn remember_catalogues(
    held: &[CataloguesSuccessItem],
    fresh: &[CataloguesSuccessItem],
    machines: &[(String, String, bool)],
) -> Vec<CataloguesSuccessItem> {
    machines
        .iter()
        .map(|(profile, name, live)| {
            let read = fresh.iter().find(|r| &r.profile == profile);
            let before = held.iter().find(|r| &r.profile == profile);
            let catalogues = match read {
                Some(r) if r.problem.is_none() => r.catalogues.clone(),
                _ => before
                    .map(|b| b.catalogues.clone())
                    .or_else(|| read.map(|r| r.catalogues.clone()))
                    .unwrap_or_default(),
            };
            let problem = if !live {
                Some(
                    read.and_then(|r| r.problem.clone())
                        .unwrap_or_else(|| "out of reach".into()),
                )
            } else {
                match (read, before) {
                    (Some(r), _) => r.problem.clone(),
                    (None, Some(b)) => b.problem.clone(),
                    (None, None) => Some("not read yet".into()),
                }
            };
            CataloguesSuccessItem {
                profile: profile.clone(),
                name: name.clone(),
                catalogues,
                problem,
            }
        })
        .collect()
}
