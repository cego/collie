//! The services the Flock reaches, one card each. Ported from
//! `desktop/src/shared/connections.ts` and `desktop/src/shared/slack.ts`.

use collie_desktop_protocol::generated::{
    ConnectionReading, ConnectionReadingsSuccessItem, ConnectionUse, Id,
    SlackUserChannelsSuccessItem,
};

pub const IDS: [Id; 5] = [Id::Gitlab, Id::Github, Id::Linear, Id::Helle, Id::Slack];

pub fn id_name(id: &Id) -> &'static str {
    match id {
        Id::Gitlab => "gitlab",
        Id::Github => "github",
        Id::Linear => "linear",
        Id::Helle => "helle",
        Id::Slack => "slack",
    }
}

pub fn title(id: &Id) -> &'static str {
    match id {
        Id::Gitlab => "GitLab",
        Id::Github => "GitHub",
        Id::Linear => "Linear",
        Id::Helle => "Helle",
        Id::Slack => "Slack",
    }
}

/// A Machine's reading of its connections, with why it has none where it can't be read.
#[derive(Clone, Debug, PartialEq)]
pub struct MachineReading {
    pub profile: String,
    pub name: String,
    pub reading: Option<ConnectionReading>,
    pub problem: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Primary {
    Reuse {
        label: String,
        from: String,
        to: Vec<String>,
    },
    Login {
        label: String,
        to: String,
    },
    Setup {
        label: String,
        to: String,
    },
    Connect {
        label: String,
    },
}

impl Primary {
    pub fn label(&self) -> &str {
        match self {
            Primary::Reuse { label, .. }
            | Primary::Login { label, .. }
            | Primary::Setup { label, .. }
            | Primary::Connect { label } => label,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Card {
    pub id: Id,
    pub name: &'static str,
    pub primary: Option<Primary>,
    pub needs_you: bool,
    pub state: String,
    pub account: Option<String>,
    pub where_: String,
    pub machines: Vec<MachineReading>,
}

fn ok(reading: &Option<ConnectionReading>) -> bool {
    matches!(reading, Some(ConnectionReading::Ok(_)))
}

/// `a, b and c`.
fn names(values: &[String]) -> String {
    match values {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// Each Machine as Connections reads it: the board's Machines, with their readings.
pub struct Machine<'a> {
    pub profile: &'a str,
    pub name: &'a str,
    pub live: bool,
    /// Why the board lost it, where it did.
    pub reason: Option<&'a str>,
}

pub fn machines_read(
    machines: &[Machine],
    readings: &[ConnectionReadingsSuccessItem],
) -> Vec<(
    String,
    String,
    Vec<collie_desktop_protocol::generated::Connection>,
    Option<String>,
)> {
    machines
        .iter()
        .map(|m| {
            let held = readings.iter().find(|r| r.profile == m.profile);
            let problem = if !m.live {
                Some(m.reason.unwrap_or("Out of reach").to_string())
            } else {
                match held {
                    Some(h) => h.problem.clone(),
                    None => Some("Not read yet".into()),
                }
            };
            (
                m.profile.to_string(),
                m.name.to_string(),
                held.map(|h| h.connections.clone()).unwrap_or_default(),
                problem,
            )
        })
        .collect()
}

pub fn cards(
    machines: &[(
        String,
        String,
        Vec<collie_desktop_protocol::generated::Connection>,
        Option<String>,
    )],
) -> Vec<Card> {
    IDS.iter()
        .map(|id| {
            let readings: Vec<MachineReading> = machines
                .iter()
                .map(|(profile, name, connections, problem)| MachineReading {
                    profile: profile.clone(),
                    name: name.clone(),
                    reading: connections
                        .iter()
                        .find(|c| &c.id == id)
                        .map(|c| c.reading.clone()),
                    problem: problem.clone(),
                })
                .collect();
            let (ready, lacking): (Vec<&MachineReading>, Vec<&MachineReading>) = readings
                .iter()
                .partition(|one| one.problem.is_none() && ok(&one.reading));
            let source = ready.first();
            let primary = if lacking.is_empty() {
                None
            } else if let (Id::Gitlab | Id::Github, Some(source)) = (id, source) {
                Some(Primary::Reuse {
                    label: if *id == Id::Gitlab {
                        "Use glab's login".into()
                    } else {
                        format!(
                            "Give to {}",
                            names(&lacking.iter().map(|m| m.name.clone()).collect::<Vec<_>>())
                        )
                    },
                    from: source.profile.clone(),
                    to: lacking.iter().map(|m| m.profile.clone()).collect(),
                })
            } else if *id == Id::Github {
                Some(Primary::Login {
                    label: format!("Sign in on {}", lacking[0].name),
                    to: lacking[0].profile.clone(),
                })
            } else if *id == Id::Linear {
                Some(Primary::Setup {
                    label: format!("Set up on {}", lacking[0].name),
                    to: lacking[0].profile.clone(),
                })
            } else {
                Some(Primary::Connect {
                    label: "Connect".into(),
                })
            };
            let ready_names: Vec<String> = ready.iter().map(|m| m.name.clone()).collect();
            let lacking_names: Vec<String> = lacking.iter().map(|m| m.name.clone()).collect();
            Card {
                id: id.clone(),
                name: title(id),
                needs_you: !lacking.is_empty(),
                state: if machines.is_empty() {
                    "Not read yet".into()
                } else if lacking.is_empty() {
                    "Connected".into()
                } else if !ready.is_empty() {
                    format!("On {} of {} Machines", ready.len(), machines.len())
                } else {
                    "Not set up".into()
                },
                account: source.and_then(|s| match &s.reading {
                    Some(ConnectionReading::Ok(ok)) => Some(if *id == Id::Slack {
                        ok.detail.clone()
                    } else {
                        ok.account.clone()
                    }),
                    _ => None,
                }),
                where_: if ready.len() == machines.len() {
                    format!("On all {} Machines", machines.len())
                } else {
                    format!(
                        "{} · missing on {}",
                        if ready.is_empty() {
                            "No login found".to_string()
                        } else {
                            format!("On {}", names(&ready_names))
                        },
                        names(&lacking_names)
                    )
                },
                primary,
                machines: readings,
            }
        })
        .collect()
}

/// One workflow's declaration of a connection: what it does with it and without it.
#[derive(Clone, Debug, PartialEq)]
pub struct Use {
    pub id: String,
    pub declares: &'static str,
    pub with: String,
    pub without: String,
}

pub fn uses(id: &Id, workflows: &[ConnectionUse]) -> Vec<Use> {
    let key = id_name(id);
    workflows
        .iter()
        .filter_map(|w| {
            if let Some(need) = w.connections.needs.as_ref().and_then(|n| n.get(key)) {
                return Some(Use {
                    id: w.id.clone(),
                    declares: "needs",
                    with: need.with.clone(),
                    without: "Does not start".into(),
                });
            }
            w.connections
                .uses
                .as_ref()
                .and_then(|u| u.get(key))
                .map(|u| Use {
                    id: w.id.clone(),
                    declares: "uses",
                    with: u.with.clone(),
                    without: u.without.clone(),
                })
        })
        .collect()
}

/// Every Machine's workflows that declare connections, each workflow once.
pub fn workflows(readings: &[ConnectionReadingsSuccessItem]) -> Vec<ConnectionUse> {
    let mut all: Vec<ConnectionUse> = Vec::new();
    for w in readings.iter().flat_map(|r| &r.workflows) {
        match all.iter_mut().find(|held| held.id == w.id) {
            Some(held) => *held = w.clone(),
            None => all.push(w.clone()),
        }
    }
    all
}

pub const SIGN_IN_TO_PICK: &str = "Sign in to Slack under Connections to pick a channel you're in";

/// A Slack destination's choices: nowhere, then the channels the human is in.
#[derive(Clone, Debug, PartialEq)]
pub struct Destination {
    pub disabled: bool,
    pub hint: Option<&'static str>,
    pub options: Vec<(String, String)>,
}

fn is_direct_message(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some('D' | 'U' | 'W'))
        && id.len() > 1
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

pub fn destination(
    key: &str,
    value: &str,
    yours: Option<&[SlackUserChannelsSuccessItem]>,
) -> Destination {
    let mut options = vec![(
        String::new(),
        if key == "slack.notification_channel" {
            "Nowhere: toasts only".to_string()
        } else {
            "Nowhere: shares nothing".to_string()
        },
    )];
    options.extend(
        yours
            .unwrap_or_default()
            .iter()
            .map(|c| (c.id.clone(), format!("#{}", c.name))),
    );
    if !value.is_empty() && !options.iter().any(|(v, _)| v == value) {
        options.push((
            value.into(),
            if is_direct_message(value) {
                format!("{value} (direct messages are no longer sent)")
            } else {
                format!("{value} (not checked)")
            },
        ));
    }
    Destination {
        disabled: yours.is_none(),
        hint: yours.is_none().then_some(SIGN_IN_TO_PICK),
        options,
    }
}

pub fn pick_destination(
    value: &str,
    yours: Option<&[SlackUserChannelsSuccessItem]>,
) -> Result<String, String> {
    let Some(yours) = yours else {
        return Err(SIGN_IN_TO_PICK.into());
    };
    if value.is_empty() || yours.iter().any(|c| c.id == value) {
        Ok(value.into())
    } else {
        Err("Pick a channel you're in, or refresh Slack".into())
    }
}
