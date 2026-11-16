//! Instants and spans as a record says them: `11:22` today, `24 Oct, 11:22` another day, and
//! `12 min` of work. A copy of `whenOf` in `desktop/src/shared/flow.ts` and `minutes` in
//! `src/time.ts`, with this computer's offset read from its C library.

/// Milliseconds since the epoch of an ISO 8601 instant: `2026-11-10T09:21:33.120Z` or with an
/// offset; none for anything else.
pub fn epoch_ms(iso: &str) -> Option<f64> {
    let b = iso.trim().as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = b.get(from..from + len)?;
        part.iter()
            .all(u8::is_ascii_digit)
            .then(|| std::str::from_utf8(part).ok()?.parse().ok())?
    };
    let (year, month, day) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') || !matches!(b.get(10), Some(b'T' | b' '))
    {
        return None;
    }
    let (hour, minute, second) = (num(11, 2)?, num(14, 2)?, num(17, 2).unwrap_or(0));
    let mut at = if b.get(16) == Some(&b':') { 19 } else { 16 };
    let mut ms = 0.0;
    if b.get(at) == Some(&b'.') {
        let start = at + 1;
        at = start;
        while b.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        let digits = std::str::from_utf8(&b[start..at]).ok()?;
        ms = format!("0.{digits}").parse::<f64>().ok()? * 1000.0;
    }
    let offset = match b.get(at) {
        Some(b'Z' | b'z') | None => 0,
        Some(sign @ (b'+' | b'-')) => {
            let hours = num(at + 1, 2)?;
            let minutes = if b.get(at + 3) == Some(&b':') {
                num(at + 4, 2)?
            } else {
                num(at + 3, 2).unwrap_or(0)
            };
            let total = hours * 60 + minutes;
            if *sign == b'-' { -total } else { total }
        }
        _ => return None,
    };
    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset * 60;
    Some(seconds as f64 * 1000.0 + ms)
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The year, month and day of a day since 1970-01-01.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (
        if month <= 2 {
            yoe + era * 400 + 1
        } else {
            yoe + era * 400
        },
        month,
        day,
    )
}

#[repr(C)]
struct Tm {
    sec: i32,
    min: i32,
    hour: i32,
    mday: i32,
    mon: i32,
    year: i32,
    wday: i32,
    yday: i32,
    isdst: i32,
    gmtoff: std::ffi::c_long,
    zone: *const std::ffi::c_char,
}

unsafe extern "C" {
    fn localtime_r(time: *const i64, out: *mut Tm) -> *mut Tm;
}

/// This computer's offset from UTC at `ms`, in minutes.
pub fn local_offset(ms: f64) -> i64 {
    let seconds = (ms / 1000.0).floor() as i64;
    let mut tm = std::mem::MaybeUninit::<Tm>::zeroed();
    // SAFETY: localtime_r writes only into the struct it is given, laid out as both glibc's
    // and Darwin's `struct tm`.
    let read = unsafe { localtime_r(&seconds, tm.as_mut_ptr()) };
    if read.is_null() {
        return 0;
    }
    unsafe { tm.assume_init() }.gmtoff / 60
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

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

/// An instant on a clock `offset` minutes from UTC: `11:22` today, `24 Oct, 11:22` another
/// day, `24 Oct 2025, 11:22` another year. Text that is no instant is said as it is.
pub fn when_at(iso: &str, now: f64, offset: impl Fn(f64) -> i64) -> String {
    let Some(ms) = epoch_ms(iso) else {
        return iso.into();
    };
    let at = parts(ms, offset(ms));
    let today = parts(now, offset(now));
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

/// [`when_at`] on this computer's clock.
pub fn when_of(iso: &str, now: f64) -> String {
    when_at(iso, now, local_offset)
}

/// A span of work: `under a minute`, `12 min`, `2 h`, `2 h 5 min`.
pub fn minutes(ms: f64) -> String {
    let whole = (ms.max(0.0) / 60_000.0).floor() as i64;
    match whole {
        0 => "under a minute".into(),
        1..=59 => format!("{whole} min"),
        _ if whole % 60 == 0 => format!("{} h", whole / 60),
        _ => format!("{} h {} min", whole / 60, whole % 60),
    }
}

/// The time now, in milliseconds since the epoch.
pub fn now() -> f64 {
    collie_desktop_protocol::epoch_ms()
}
