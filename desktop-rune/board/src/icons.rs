//! The app's own glyphs, 16-point line icons drawn in the text's colour.

use rune::Icon;

macro_rules! icon {
    ($name:ident, $id:literal, $body:literal) => {
        pub static $name: Icon = Icon {
            name: $id,
            view: 16.0,
            body: $body,
        };
    };
}

icon!(
    BOARD,
    "collie-board",
    r#"<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="9" y="9" width="4.5" height="4.5" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/>"#
);
icon!(
    WORKFLOWS,
    "collie-workflows",
    r#"<rect x="2.5" y="2.5" width="4" height="4" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="9.5" y="9.5" width="4" height="4" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M4.5 6.5V9.5C4.5 10.6 5.4 11.5 6.5 11.5H9.5" stroke="currentColor" stroke-width="1.2" fill="none"/>"#
);
icon!(
    MACHINES,
    "collie-machines",
    r#"<rect x="2.5" y="2.5" width="11" height="4.5" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="2.5" y="9" width="11" height="4.5" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="5" cy="4.75" r=".8" fill="currentColor"/><circle cx="5" cy="11.25" r=".8" fill="currentColor"/>"#
);
icon!(
    SCHEDULES,
    "collie-schedules",
    r#"<rect x="2.5" y="3.5" width="11" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M2.5 6.5H13.5M5.5 2V4.5M10.5 2V4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>"#
);
icon!(
    USAGE,
    "collie-usage",
    r#"<path d="M2.5 13.5H13.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M4.5 11V8M8 11V4.5M11.5 11V6.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>"#
);
icon!(
    SETTINGS,
    "collie-settings",
    r#"<circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M8 1.75V3.5M8 12.5V14.25M1.75 8H3.5M12.5 8H14.25M3.6 3.6L4.8 4.8M11.2 11.2L12.4 12.4M3.6 12.4L4.8 11.2M11.2 4.8L12.4 3.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>"#
);
icon!(
    CHAT,
    "collie-chat",
    r#"<path d="M3 3.5H13C13.3 3.5 13.5 3.7 13.5 4V10.5C13.5 10.8 13.3 11 13 11H7L4 13.5V11H3C2.7 11 2.5 10.8 2.5 10.5V4C2.5 3.7 2.7 3.5 3 3.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/>"#
);
icon!(
    BACK,
    "collie-back",
    r#"<path d="M9.5 3.5L5 8L9.5 12.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#
);
icon!(
    OPEN_ASIDE,
    "collie-open-aside",
    r#"<path d="M9 2.5H13.5V7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M13.5 2.5L7.5 8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/><path d="M11.5 9.5V12.5C11.5 13.1 11.1 13.5 10.5 13.5H3.5C2.9 13.5 2.5 13.1 2.5 12.5V5.5C2.5 4.9 2.9 4.5 3.5 4.5H6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/>"#
);
icon!(
    CLOSE,
    "collie-close",
    r#"<path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/>"#
);
