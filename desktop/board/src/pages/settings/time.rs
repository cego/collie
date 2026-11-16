//! Instants as `whenOf` in `desktop/src/shared/flow.ts` says them, on this computer's clock.

use std::sync::OnceLock;

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec",
];

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (
        if m <= 2 {
            yoe + era * 400 + 1
        } else {
            yoe + era * 400
        },
        m,
        d,
    )
}

fn digits(s: &str) -> Option<i64> {
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .then(|| s.parse().ok())
        .flatten()
}

/// Milliseconds since the epoch of an ISO 8601 instant, such as `2026-11-11T09:30:00.000Z`.
pub fn epoch_ms(iso: &str) -> Option<f64> {
    let (date, rest) = iso.split_once('T')?;
    let mut parts = date.split('-');
    let (y, m, d) = (
        digits(parts.next()?)?,
        digits(parts.next()?)?,
        digits(parts.next()?)?,
    );
    let (clock, zone) = match rest.find(['Z', '+', '-']) {
        Some(at) => rest.split_at(at),
        None => (rest, ""),
    };
    let offset_min = match zone {
        "" | "Z" => 0,
        _ => {
            let sign = if zone.starts_with('-') { -1 } else { 1 };
            let (h, mm) = zone[1..].split_once(':').unwrap_or((&zone[1..], "0"));
            sign * (digits(h)? * 60 + digits(mm)?)
        }
    };
    let mut hms = clock.split(':');
    let h = digits(hms.next()?)?;
    let min = digits(hms.next()?)?;
    let secs: f64 = hms.next().map_or(Ok(0.0), str::parse).ok()?;
    let days = days_from_civil(y, m, d);
    Some(((days * 24 + h) * 60 + min - offset_min) as f64 * 60_000.0 + secs * 1000.0)
}

struct Parts {
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
}

fn parts(ms: f64, offset: i64) -> Parts {
    let minutes = (ms / 60_000.0).floor() as i64 + offset;
    let (year, month, day) = civil_from_days(minutes.div_euclid(1440));
    let of_day = minutes.rem_euclid(1440);
    Parts {
        year,
        month,
        day,
        hour: of_day / 60,
        minute: of_day % 60,
    }
}

/// An instant at `offset` minutes east of UTC: `11:22` today, `24 Oct, 11:22` on another day.
pub fn when_of(iso: &str, now: f64, offset: i64) -> String {
    let Some(ms) = epoch_ms(iso) else {
        return iso.to_string();
    };
    let (at, today) = (parts(ms, offset), parts(now, offset));
    let time = format!("{:02}:{:02}", at.hour, at.minute);
    let month = MONTHS[(at.month - 1) as usize];
    if at.year != today.year {
        format!("{} {month} {}, {time}", at.day, at.year)
    } else if at.month == today.month && at.day == today.day {
        time
    } else {
        format!("{} {month}, {time}", at.day)
    }
}

/// This computer's offset from UTC now, in minutes, as `date` reads the zone; 0 where it can't.
pub fn local_offset() -> i64 {
    static OFFSET: OnceLock<i64> = OnceLock::new();
    *OFFSET.get_or_init(|| {
        let said = std::process::Command::new("date")
            .arg("+%z")
            .output()
            .ok()
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .unwrap_or_default();
        let said = said.trim();
        let sign = if said.starts_with('-') { -1 } else { 1 };
        match (
            said.get(1..3).and_then(digits),
            said.get(3..5).and_then(digits),
        ) {
            (Some(h), Some(m)) => sign * (h * 60 + m),
            _ => 0,
        }
    })
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}
