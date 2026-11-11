//! The toolbar's Usage: one entry per Subscription account across the live Machines, as the
//! header of today's Desktop shows it. A port of `usageEntries` and `usageDue` in
//! `desktop/src/shared/usage.ts`, which stays their owner.

use crate::App;
use crate::pages::clock::{Zone, ago, epoch_ms, reset_phrase};
use crate::pages::usage::{Level, usage_accounts};
use collie_desktop_protocol::generated::{Subscription, UsageSuccessItem, Window};

const USAGE_EVERY_MS: f64 = 60_000.0;
const WARN_PERCENT: f64 = 90.0;

/// One account's busiest window, in a few characters.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageEntry {
    pub key: String,
    /// For example `Claude 72%`, or `Claude out`.
    pub text: String,
    pub level: Level,
    /// Whose it is, its busiest window's reset, and which Machine read it when.
    pub title: String,
}

fn name_of(subscription: &Subscription) -> &'static str {
    match subscription {
        Subscription::Claude => "Claude",
        Subscription::Chatgpt => "ChatGPT",
    }
}

fn is_full(window: &Window) -> bool {
    window.reached || window.used_percent >= 100.0
}

/// The busiest window at `now`, a full one busier than any other; a passed reset is unused.
fn busiest(windows: &[Window], now: f64) -> Option<Window> {
    let weight = |w: &Window| if is_full(w) { 101.0 } else { w.used_percent };
    windows
        .iter()
        .map(
            |window| match window.resets_at.as_deref().and_then(epoch_ms) {
                Some(at) if at <= now => Window {
                    used_percent: 0.0,
                    reached: false,
                    ..window.clone()
                },
                _ => window.clone(),
            },
        )
        .fold(None, |found: Option<Window>, w| match found {
            Some(f) if weight(&w) <= weight(&f) => Some(f),
            _ => Some(w),
        })
}

/// One entry per Subscription account read with windows, the newest reading of each.
pub fn usage_entries(
    machines: &[UsageSuccessItem],
    live: &[String],
    now: f64,
    zone: &Zone,
) -> Vec<UsageEntry> {
    let shown: Vec<_> = usage_accounts(machines, live)
        .into_iter()
        .filter_map(|account| account.newest.map(|newest| (account.key, newest)))
        .collect();
    let accounts_of = |subscription: &Subscription| {
        shown
            .iter()
            .filter(|(_, (reading, _))| reading.subscription == *subscription)
            .count()
    };
    shown
        .iter()
        .filter_map(|(key, (reading, machine))| {
            let used = busiest(&reading.windows, now)?;
            let full = is_full(&used);
            let percent = if full { 100.0 } else { used.used_percent };
            let amount = if full {
                "out".to_string()
            } else {
                format!("{}%", percent.round())
            };
            let amount = match &used.model {
                Some(model) => format!("{model} {amount}"),
                None => amount,
            };
            let label = match &reading.account_label {
                Some(label) if accounts_of(&reading.subscription) > 1 => format!(" {label}"),
                _ => String::new(),
            };
            let reset = match &used.resets_at {
                Some(at) => format!("{} {}", used.label, reset_phrase(at, now, zone)),
                None => used.label.clone(),
            };
            let title = [
                reading.account_label.clone(),
                Some(reset),
                Some(format!("read on {machine} {}", ago(&reading.at, now))),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" · ");
            Some(UsageEntry {
                key: key.clone(),
                text: format!("{}{label} {amount}", name_of(&reading.subscription)),
                level: if full {
                    Level::Out
                } else if percent >= WARN_PERCENT {
                    Level::Warn
                } else {
                    Level::Ok
                },
                title,
            })
        })
        .collect()
}

/// Whether to ask each Machine again: at once, then each minute, and as soon as a Machine
/// that was not live when it was last asked is.
pub fn usage_due(asked_at: Option<f64>, asked_of: &[String], live: &[String], now: f64) -> bool {
    asked_at.is_none_or(|at| now - at >= USAGE_EVERY_MS)
        || live.iter().any(|machine| !asked_of.contains(machine))
}

/// This computer's zone, read once.
fn zone() -> &'static Zone {
    static ZONE: std::sync::OnceLock<Zone> = std::sync::OnceLock::new();
    ZONE.get_or_init(Zone::local)
}

impl App {
    /// Asks each Machine for its Usage when it is due: when Desktop opens, when a Machine
    /// comes live, then each minute.
    pub fn ask_usage_when_due(&mut self, now: f64) {
        if self.core.is_none() {
            return;
        }
        let live = self.live_profiles();
        if !usage_due(self.nav.usage_asked, &self.nav.usage_asked_of, &live, now) {
            return;
        }
        self.nav.usage_asked = Some(now);
        self.nav.usage_asked_of = live;
        self.read_usage();
    }

    /// The toolbar's entries, of the Machines live now.
    pub fn usage_entries(&self) -> Vec<UsageEntry> {
        let live = self.live_profiles();
        usage_entries(&self.pages.usage.machines, &live, self.board.now(), zone())
    }

    fn live_profiles(&self) -> Vec<String> {
        crate::pages::machines::rows(self)
            .into_iter()
            .filter(|row| row.state.is_live())
            .map(|row| row.profile)
            .collect()
    }
}
