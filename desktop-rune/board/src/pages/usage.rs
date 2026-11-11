//! The Usage page: one section per Subscription account across the live Machines, each
//! window's use and reset (ADR-0049). A port of the page half of
//! `desktop/src/shared/usage.ts`, `useUsage` and `UsagePage.vue`.

use super::clock::{Zone, ago, epoch_ms, reset_phrase};
use super::common::{heading, muted, page};
use crate::App;
use collie_desktop_protocol::generated::{
    Source, Subscription, UsageSuccessItem, UsageSuccessItemReading as Reading, Window,
};
use rune::{El, col, el, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit, Spinner};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

const WARN_PERCENT: f64 = 90.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Ok,
    Warn,
    Out,
}

fn level_of(used: f64, exhausted: bool) -> Level {
    if exhausted {
        Level::Out
    } else if used >= WARN_PERCENT {
        Level::Warn
    } else {
        Level::Ok
    }
}

fn name_of(subscription: &Subscription) -> &'static str {
    match subscription {
        Subscription::Claude => "Claude",
        Subscription::Chatgpt => "ChatGPT",
    }
}

fn order_of(subscription: &Subscription) -> u8 {
    match subscription {
        Subscription::Claude => 0,
        Subscription::Chatgpt => 1,
    }
}

fn source_of(source: &Source) -> &'static str {
    match source {
        Source::ClaudeUsage => "Claude's usage endpoint",
        Source::ClaudeStatusLine => "a Claude status line",
        Source::CodexAppServer => "Codex's app server",
    }
}

/// A window as it stands at `now`: once its reset has passed it is unused, whatever was read.
fn current(window: &Window, now: f64) -> Window {
    match window.resets_at.as_deref().and_then(epoch_ms) {
        Some(at) if at <= now => Window {
            used_percent: 0.0,
            reached: false,
            ..window.clone()
        },
        _ => window.clone(),
    }
}

fn is_full(window: &Window) -> bool {
    window.reached || window.used_percent >= 100.0
}

#[derive(Debug, Clone, PartialEq)]
pub struct Account {
    pub key: String,
    pub subscription: Subscription,
    pub account: Option<String>,
    pub label: Option<String>,
    /// Its newest reading that has windows, and the Machine that read it.
    pub newest: Option<(Reading, String)>,
    /// Each live Machine logged in to it, with its own reading, in the Flock's order.
    pub machines: Vec<(String, Reading)>,
}

// ChatGPT's account id is its workspace's, shared by every seat, so its email tells seats apart.
fn account_key(reading: &Reading, machine: &str) -> String {
    let sub = match reading.subscription {
        Subscription::Claude => "claude",
        Subscription::Chatgpt => "chatgpt",
    };
    match (&reading.account, &reading.subscription) {
        (None, _) => format!("{sub}:on {machine}"),
        (Some(account), Subscription::Chatgpt) => format!(
            "{sub}:{account}:{}",
            reading.account_label.as_deref().unwrap_or("")
        ),
        (Some(account), _) => format!("{sub}:{account}"),
    }
}

/// The live Machines' readings, one group per Subscription account.
pub fn usage_accounts(machines: &[UsageSuccessItem], live: &[String]) -> Vec<Account> {
    let mut groups: Vec<Account> = Vec::new();
    for profile in live {
        for machine in machines.iter().filter(|m| &m.profile == profile) {
            for reading in &machine.readings {
                let key = account_key(reading, &machine.name);
                let at = match groups.iter().position(|g| g.key == key) {
                    Some(at) => at,
                    None => {
                        groups.push(Account {
                            key,
                            subscription: reading.subscription.clone(),
                            account: reading.account.clone(),
                            label: reading.account_label.clone(),
                            newest: None,
                            machines: vec![],
                        });
                        groups.len() - 1
                    }
                };
                let group = &mut groups[at];
                if group.label.is_none() {
                    group.label = reading.account_label.clone();
                }
                let newer = !reading.windows.is_empty()
                    && group.newest.as_ref().is_none_or(|(newest, _)| {
                        epoch_ms(&reading.at).unwrap_or(f64::NAN)
                            > epoch_ms(&newest.at).unwrap_or(f64::NAN)
                    });
                if newer {
                    group.newest = Some((reading.clone(), machine.name.clone()));
                }
                group.machines.push((machine.name.clone(), reading.clone()));
            }
        }
    }
    groups.sort_by(|a, b| {
        order_of(&a.subscription)
            .cmp(&order_of(&b.subscription))
            .then_with(|| match (&a.label, &b.label) {
                (Some(a), Some(b)) => a.cmp(b),
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, None) => std::cmp::Ordering::Equal,
            })
    });
    groups
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowView {
    pub key: String,
    pub label: String,
    /// 0–100, rounded.
    pub percent: u32,
    pub level: Level,
    /// `resets 14:00 (in 2h 10m)`; `None` where the source gives no reset.
    pub reset: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Section {
    pub key: String,
    /// `Claude · max · me@example.com`.
    pub title: String,
    pub windows: Vec<WindowView>,
    /// `as of 3 minutes ago · read on vm-mk · Claude's usage endpoint`; `None` with no windows.
    pub said: Option<String>,
    /// Each live Machine logged in to it, with its own reading's problem.
    pub machines: Vec<(String, Option<String>)>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct PageView {
    pub sections: Vec<Section>,
    /// A reading that could not be matched to an account, and a Machine that gave no readings.
    pub not_read: Vec<(String, String)>,
}

fn windows_of(reading: &Reading, now: f64, zone: &Zone) -> Vec<WindowView> {
    reading
        .windows
        .iter()
        .enumerate()
        .map(|(i, raw)| {
            let window = current(raw, now);
            let full = is_full(&window);
            WindowView {
                key: format!("{i}:{}", window.label),
                label: window.label.clone(),
                percent: if full {
                    100
                } else {
                    window.used_percent.round() as u32
                },
                level: level_of(window.used_percent, full),
                reset: window
                    .resets_at
                    .as_deref()
                    .map(|at| reset_phrase(at, now, zone)),
            }
        })
        .collect()
}

fn title_of(reading: &Reading) -> String {
    [
        Some(name_of(&reading.subscription).to_string()),
        reading.plan.clone(),
        reading.account_label.clone(),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ")
}

/// The Usage page: one section per Subscription account across the live Machines.
pub fn usage_page(
    machines: &[UsageSuccessItem],
    live: &[String],
    now: f64,
    zone: &Zone,
) -> PageView {
    let sections = usage_accounts(machines, live)
        .into_iter()
        .filter(|a| a.account.is_some() || a.newest.is_some())
        .map(|account| {
            let titled = match &account.newest {
                Some((reading, _)) => reading.clone(),
                None => account
                    .machines
                    .iter()
                    .skip(1)
                    .fold(&account.machines[0], |a, b| {
                        if epoch_ms(&b.1.at) > epoch_ms(&a.1.at) {
                            b
                        } else {
                            a
                        }
                    })
                    .1
                    .clone(),
            };
            Section {
                key: account.key.clone(),
                title: title_of(&titled),
                windows: account
                    .newest
                    .as_ref()
                    .map(|(r, _)| windows_of(r, now, zone))
                    .unwrap_or_default(),
                said: account.newest.as_ref().map(|(reading, machine)| {
                    format!(
                        "as of {} · read on {machine} · {}",
                        ago(&reading.at, now),
                        source_of(&reading.source)
                    )
                }),
                machines: account
                    .machines
                    .iter()
                    .map(|(name, reading)| (name.clone(), reading.problem.clone()))
                    .collect(),
            }
        })
        .collect();
    let mut not_read = Vec::new();
    for profile in live {
        for machine in machines.iter().filter(|m| &m.profile == profile) {
            if let Some(problem) = &machine.problem {
                not_read.push((profile.clone(), format!("{}: {problem}", machine.name)));
            }
            for (i, reading) in machine.readings.iter().enumerate() {
                if reading.account.is_none() && reading.windows.is_empty() {
                    let mut said = format!("{} · {}", machine.name, name_of(&reading.subscription));
                    if let Some(problem) = &reading.problem {
                        said = format!("{said}: {problem}");
                    }
                    not_read.push((format!("{profile}:{i}"), said));
                }
            }
        }
    }
    PageView { sections, not_read }
}

/// How often Usage is read again while Desktop runs, as `useUsage` does.
pub const USAGE_EVERY: Duration = Duration::from_secs(60);

pub struct Usage {
    pub machines: Vec<UsageSuccessItem>,
    pub listed: bool,
    /// When the shown reading was answered, in epoch milliseconds.
    pub read_at: Option<f64>,
    pub reading: bool,
    /// Counts the asks, shared with the thread that asks again, so an older ask never wins.
    asks: Arc<AtomicU64>,
    zone: Option<Zone>,
    pub every: Duration,
    fresh: bool,
}

impl Default for Usage {
    fn default() -> Self {
        Usage {
            machines: Vec::new(),
            listed: false,
            read_at: None,
            reading: false,
            asks: Arc::default(),
            zone: None,
            every: USAGE_EVERY,
            fresh: false,
        }
    }
}

impl Usage {
    /// The sidebar has opened this page: reads Usage now, and from then on every minute.
    pub fn opened(app: &mut App) {
        if app.pages.usage.zone.is_none() {
            app.pages.usage.zone = Some(Zone::here());
        }
        app.read_usage();
        app.keep_usage_fresh();
    }
}

fn ask_usage(core: &crate::calls::Core<App>, asks: &AtomicU64) {
    let ask = asks.fetch_add(1, Ordering::SeqCst) + 1;
    core.request(
        "usage",
        (),
        move |app: &mut App, read: Result<Vec<UsageSuccessItem>, _>| {
            let state = &mut app.pages.usage;
            if state.asks.load(Ordering::SeqCst) != ask {
                return;
            }
            state.reading = false;
            if let Ok(machines) = read {
                state.machines = machines;
                state.read_at = Some(collie_desktop_protocol::epoch_ms());
            }
            state.listed = true;
        },
    );
}

impl App {
    /// Asks each connected Machine's host for its Usage; an older ask never wins.
    pub fn read_usage(&mut self) {
        let Some(core) = &self.core else { return };
        self.pages.usage.reading = true;
        ask_usage(core, &self.pages.usage.asks);
    }

    /// Asks again every `every` for as long as the app holds its Usage, once started.
    fn keep_usage_fresh(&mut self) {
        let Some(core) = self.core.clone() else {
            return;
        };
        let state = &mut self.pages.usage;
        if state.fresh {
            return;
        }
        state.fresh = true;
        let (asks, every) = (Arc::downgrade(&state.asks), state.every);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(every);
                let Some(asks) = asks.upgrade() else { return };
                ask_usage(&core, &asks);
            }
        });
    }
}

const LABEL_W: f32 = 132.0;
const PERCENT_W: f32 = 48.0;

fn meter(k: &Kit, window: &WindowView) -> El {
    let fill = match window.level {
        Level::Ok => k.c.text_muted,
        Level::Warn => k.c.warning.icon,
        Level::Out => k.c.danger.icon,
    };
    let track = el()
        .h(6.0)
        .w_full()
        .radius(3.0)
        .fill(k.c.layer_03)
        .clip_soft(0.0)
        .child(
            el().h_full()
                .w_frac((window.percent as f32 / 100.0).clamp(0.0, 1.0))
                .radius(3.0)
                .fill(fill),
        );
    let bar = col()
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .gap(6.0)
        .pt(6.0)
        .child(track)
        .children(
            window
                .reset
                .clone()
                .map(|reset| text(reset).font(k.ty.text_xsmall).color(k.c.text_faint)),
        );
    row()
        .key(format!("window-{}", window.key))
        .role("progressbar")
        .label(format!("{}: {}%", window.label, window.percent))
        .w_full()
        .gap(16.0)
        .items_start()
        .child(
            text(window.label.clone())
                .font(k.ty.text_small)
                .color(k.c.text_base)
                .w(LABEL_W)
                .truncate()
                .a11y_hidden(),
        )
        .child(bar.a11y_hidden())
        .child(
            row().w(PERCENT_W).justify_end().child(
                text(format!("{}%", window.percent))
                    .font(k.ty.text_small_medium)
                    .color(if window.level == Level::Ok {
                        k.c.text_base
                    } else {
                        fill
                    })
                    .a11y_hidden(),
            ),
        )
}

fn section(k: &Kit, section: &Section) -> El {
    let (subscription, rest) = match section.title.split_once(" · ") {
        Some((name, rest)) => (name.to_string(), Some(rest.to_string())),
        None => (section.title.clone(), None),
    };
    let head = row()
        .w_full()
        .gap(8.0)
        .center_y()
        .child(
            text(subscription)
                .font(k.ty.ui_medium)
                .color(k.c.text_strong)
                .a11y_hidden(),
        )
        .children(rest.map(|rest| {
            text(rest)
                .font(k.ty.text_small)
                .color(k.c.text_muted)
                .truncate()
                .shrink()
                .a11y_hidden()
        }));
    let mut meters = col().w_full().gap(14.0);
    for window in &section.windows {
        meters = meters.child(meter(k, window));
    }
    let mut logged = row().flex_wrap().gap(4.0).child(
        text("Logged in on")
            .font(k.ty.text_xsmall)
            .color(k.c.text_faint),
    );
    for (i, (name, problem)) in section.machines.iter().enumerate() {
        let comma = if i + 1 < section.machines.len() {
            ","
        } else {
            ""
        };
        logged = logged.child(
            text(match problem {
                None => format!("{name}{comma}"),
                Some(_) => name.clone(),
            })
            .font(k.ty.text_xsmall_medium)
            .color(k.c.text_muted),
        );
        if let Some(problem) = problem {
            logged = logged.child(
                text(format!("({problem}){comma}"))
                    .font(k.ty.text_xsmall)
                    .color(k.c.warning.fg),
            );
        }
    }
    let foot = col()
        .w_full()
        .gap(4.0)
        .children(section.said.clone().map(|said| {
            text(said)
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint)
                .wrap()
                .w_full()
        }))
        .child(logged);
    super::common::panel(k, format!("usage-{}", section.key), section.title.clone())
        .padding(18.0)
        .gap(16.0)
        .child(head)
        .children((!section.windows.is_empty()).then_some(meters))
        .child(rune_kit::Divider::horizontal().build(k))
        .child(foot)
}

pub fn view(app: &App, k: &Kit, _layer: &mut Vec<El>) -> El {
    let state = &app.pages.usage;
    let live: Vec<String> = super::machines::rows(app)
        .into_iter()
        .filter(|r| r.state.is_live())
        .map(|r| r.profile)
        .collect();
    let zone = state.zone.clone().unwrap_or_default();
    let now = collie_desktop_protocol::epoch_ms();
    let shown = usage_page(&state.machines, &live, now, &zone);
    let read = match state.read_at {
        _ if state.reading && !state.listed => "Asking each live Machine…".to_string(),
        Some(at) => format!(
            "Read at {} from each live Machine, and again every minute",
            super::clock::when_of(at, now, &zone)
        ),
        None => "Read from each live Machine every minute".to_string(),
    };
    let header = row()
        .w_full()
        .gap(16.0)
        .items_start()
        .child(
            col()
                .grow(1.0)
                .shrink()
                .min_w(0.0)
                .gap(4.0)
                .child(
                    text("Subscriptions")
                        .role("heading")
                        .font(k.ty.body_medium)
                        .color(k.c.text_strong),
                )
                .child(muted(k, read).key("usage-read")),
        )
        .child(
            row()
                .gap(8.0)
                .center_y()
                .children(
                    state
                        .reading
                        .then(|| Spinner::new().size(12.0).build(k).key("usage-reading")),
                )
                .child(
                    Button::new("Refresh")
                        .icon(&crate::icons::REFRESH)
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Small)
                        .disabled(state.reading)
                        .on_press(|app: &mut App| app.read_usage())
                        .build(k)
                        .key("usage-refresh"),
                ),
        );
    let mut children = vec![header];
    if state.listed && shown.sections.is_empty() && shown.not_read.is_empty() {
        children.push(muted(k, "No live Machine has reported usage yet."));
    }
    children.extend(shown.sections.iter().map(|s| section(k, s)));
    if !shown.not_read.is_empty() {
        children.push(
            col()
                .key("not-read")
                .w_full()
                .gap(6.0)
                .child(heading(k, "Not read"))
                .children(
                    shown
                        .not_read
                        .iter()
                        .map(|(key, said)| muted(k, said.clone()).key(format!("not-read-{key}"))),
                ),
        );
    }
    page("usage-page", "Usage", children)
}
