//! Times and sizes as the pages say them: `3 minutes ago`, `resets 14:00 (in 2h 3m)`,
//! `1.2 GiB`. Ports of `src/time.ts`, `src/bytes.ts` and the reset phrases of
//! `src/usage-model.ts`; local times are read from the system's zone file.

/// An ISO 8601 timestamp in epoch milliseconds; `None` for one that is not a time.
pub fn epoch_ms(iso: &str) -> Option<f64> {
    let b = iso.trim().as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = b.get(from..from + len)?;
        part.iter()
            .all(u8::is_ascii_digit)
            .then(|| part.iter().fold(0i64, |n, d| n * 10 + i64::from(d - b'0')))
    };
    let (year, month, day) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return None;
    }
    let (mut hour, mut minute, mut second, mut millis) = (0, 0, 0, 0.0);
    let mut at = 10;
    if matches!(b.get(10), Some(b'T' | b't' | b' ')) {
        hour = num(11, 2)?;
        minute = num(14, 2)?;
        at = 16;
        if b.get(16) == Some(&b':') {
            second = num(17, 2)?;
            at = 19;
            if b.get(19) == Some(&b'.') {
                let digits = b[20..].iter().take_while(|d| d.is_ascii_digit()).count();
                let fraction: f64 = format!("0.{}", std::str::from_utf8(&b[20..20 + digits]).ok()?)
                    .parse()
                    .ok()?;
                millis = (fraction * 1000.0).round();
                at = 20 + digits;
            }
        }
    }
    let offset = match b.get(at) {
        None => 0,
        Some(b'Z' | b'z') => 0,
        Some(sign @ (b'+' | b'-')) => {
            let hours = num(at + 1, 2)?;
            let minutes = if b.get(at + 3) == Some(&b':') {
                num(at + 4, 2)?
            } else {
                num(at + 3, 2).unwrap_or(0)
            };
            let span = (hours * 60 + minutes) * 60;
            if *sign == b'+' { span } else { -span }
        }
        Some(_) => return None,
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }
    let seconds =
        days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset;
    Some(seconds as f64 * 1000.0 + millis)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// A date and time on a clock: year, month (1–12), day, hour, minute and weekday (0 Sunday).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Civil {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub weekday: u32,
}

fn civil(seconds: i64) -> Civil {
    let days = seconds.div_euclid(86_400);
    let rest = seconds.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    Civil {
        year,
        month,
        day,
        hour: (rest / 3600) as u32,
        minute: (rest % 3600 / 60) as u32,
        weekday: (days + 4).rem_euclid(7) as u32,
    }
}

/// A time zone: UTC offsets in seconds, from each transition on.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Zone {
    /// Transition times in epoch seconds, and the offset from each.
    changes: Vec<(i64, i64)>,
    /// The offset before the first transition, or always where there is none.
    base: i64,
}

impl Zone {
    pub fn utc() -> Zone {
        Zone::default()
    }

    /// A zone `offset` seconds east of UTC all year.
    pub fn fixed(offset: i64) -> Zone {
        Zone {
            changes: Vec::new(),
            base: offset,
        }
    }

    /// This computer's zone, read once.
    pub fn here() -> Zone {
        static HERE: std::sync::OnceLock<Zone> = std::sync::OnceLock::new();
        HERE.get_or_init(Zone::local).clone()
    }

    /// This computer's zone, from `TZ` naming a zone file or from `/etc/localtime`; UTC where
    /// neither reads.
    pub fn local() -> Zone {
        let named = std::env::var("TZ").ok().filter(|tz| !tz.is_empty());
        let path = match named.as_deref().map(|tz| tz.trim_start_matches(':')) {
            Some("UTC" | "UTC0" | "GMT") => return Zone::utc(),
            Some(tz) if tz.starts_with('/') => tz.to_string(),
            Some(tz) => format!("/usr/share/zoneinfo/{tz}"),
            None => "/etc/localtime".to_string(),
        };
        std::fs::read(path)
            .ok()
            .and_then(|bytes| Zone::from_tzif(&bytes))
            .unwrap_or_default()
    }

    /// Reads a TZif file's first (32-bit) data block.
    pub fn from_tzif(b: &[u8]) -> Option<Zone> {
        if b.get(0..4)? != b"TZif" {
            return None;
        }
        let count = |at: usize| -> Option<usize> {
            Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?) as usize)
        };
        let (isutc, isstd, leap, times, types, chars) = (
            count(20)?,
            count(24)?,
            count(28)?,
            count(32)?,
            count(36)?,
            count(40)?,
        );
        let mut at = 44;
        let when: Vec<i64> = (0..times)
            .map(|i| {
                let s = at + i * 4;
                Some(i64::from(i32::from_be_bytes(
                    b.get(s..s + 4)?.try_into().ok()?,
                )))
            })
            .collect::<Option<_>>()?;
        at += times * 4;
        let index: Vec<usize> = b.get(at..at + times)?.iter().map(|i| *i as usize).collect();
        at += times;
        let offsets: Vec<i64> = (0..types)
            .map(|i| {
                let s = at + i * 6;
                Some(i64::from(i32::from_be_bytes(
                    b.get(s..s + 4)?.try_into().ok()?,
                )))
            })
            .collect::<Option<_>>()?;
        let _ = (isutc, isstd, leap, chars);
        let changes = when
            .iter()
            .zip(&index)
            .filter_map(|(t, i)| Some((*t, *offsets.get(*i)?)))
            .collect();
        Some(Zone {
            changes,
            base: offsets.first().copied().unwrap_or(0),
        })
    }

    /// Its offset at epoch second `at`.
    pub fn offset_at(&self, at: i64) -> i64 {
        match self.changes.iter().rposition(|(t, _)| *t <= at) {
            Some(i) => self.changes[i].1,
            None => self.base,
        }
    }

    /// Epoch milliseconds on this zone's clock.
    pub fn civil(&self, ms: f64) -> Civil {
        let seconds = (ms / 1000.0).floor() as i64;
        civil(seconds + self.offset_at(seconds))
    }
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// How long something has lasted, spelled out: `49 hours`, `3 minutes`; empty under a minute.
pub fn spanned(ms: f64) -> String {
    let seconds = (ms / 1000.0).round().max(0.0) as i64;
    for (unit, size) in [("day", 86_400), ("hour", 3_600), ("minute", 60)] {
        let n = seconds / size;
        if n >= 1 {
            return format!("{n} {unit}{}", if n == 1 { "" } else { "s" });
        }
    }
    String::new()
}

/// How long ago, in the coarsest unit that still says something: `2 days ago`, `just now`.
pub fn ago(iso: &str, now: f64) -> String {
    match epoch_ms(iso) {
        None => iso.to_string(),
        Some(then) => match spanned(now - then) {
            span if span.is_empty() => "just now".into(),
            span => format!("{span} ago"),
        },
    }
}

/// `1.2 GiB`, as `collie cleanup` says a size.
pub fn human_bytes(bytes: f64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let (mut value, mut unit) = (bytes, 0);
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{value} {}", UNITS[0])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// How long until a reset: `in 2d 3h`, `in 2h 3m`, `in 4m`.
pub fn reset_in(resets_at: &str, now: f64) -> String {
    let at = epoch_ms(resets_at).unwrap_or(now);
    let minutes = ((at - now) / 60_000.0).ceil().max(0.0) as i64;
    let (days, hours) = (minutes / 1440, minutes % 1440 / 60);
    if days > 0 {
        format!("in {days}d {hours}h")
    } else if hours > 0 {
        format!("in {hours}h {}m", minutes % 60)
    } else {
        format!("in {minutes}m")
    }
}

fn hh_mm(at: &Civil) -> String {
    format!("{:02}:{:02}", at.hour, at.minute)
}

/// A reset as a clock time and how long until it: `resets 14:00 (in 2h 3m)`, with its
/// weekday where it is on another day.
pub fn reset_phrase(resets_at: &str, now: f64, zone: &Zone) -> String {
    let Some(ms) = epoch_ms(resets_at) else {
        return format!("resets {resets_at}");
    };
    let (at, today) = (zone.civil(ms), zone.civil(now));
    let clock = if (at.year, at.month, at.day) == (today.year, today.month, today.day) {
        hh_mm(&at)
    } else {
        format!("{} {}", WEEKDAYS[at.weekday as usize], hh_mm(&at))
    };
    format!("resets {clock} ({})", reset_in(resets_at, now))
}

/// An instant on a clock: `11:22` today, `24 Oct, 11:22` on another day, with its year
/// where that is another.
pub fn when_of(ms: f64, now: f64, zone: &Zone) -> String {
    let (at, today) = (zone.civil(ms), zone.civil(now));
    let month = MONTHS[at.month as usize - 1];
    if at.year != today.year {
        format!("{} {month} {}, {}", at.day, at.year, hh_mm(&at))
    } else if (at.month, at.day) == (today.month, today.day) {
        hh_mm(&at)
    } else {
        format!("{} {month}, {}", at.day, hh_mm(&at))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_timestamps_hosts_write() {
        assert_eq!(epoch_ms("1970-01-01T00:00:00Z"), Some(0.0));
        assert_eq!(
            epoch_ms("2026-10-29T11:30:00.250Z"),
            Some(1_793_273_400_250.0)
        );
        assert_eq!(
            epoch_ms("2026-10-29T12:30:00+01:00"),
            epoch_ms("2026-10-29T11:30:00Z")
        );
        assert_eq!(epoch_ms("soon"), None);
    }

    #[test]
    fn a_civil_time_round_trips_and_knows_its_weekday() {
        let at = Zone::utc().civil(epoch_ms("2026-11-11T09:05:00Z").unwrap());
        assert_eq!(
            at,
            Civil {
                year: 2026,
                month: 11,
                day: 11,
                hour: 9,
                minute: 5,
                weekday: 3
            }
        );
    }
}
