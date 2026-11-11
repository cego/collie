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
    MORE,
    "collie-more",
    r#"<circle cx="3.5" cy="8" r="1.1" fill="currentColor"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/><circle cx="12.5" cy="8" r="1.1" fill="currentColor"/>"#
);
icon!(
    REFRESH,
    "collie-refresh",
    r#"<path d="M13 8A5 5 0 1 1 11.5 4.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/><path d="M11.8 1.9V4.7H9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#
);
icon!(
    KEY,
    "collie-key",
    r#"<circle cx="5.5" cy="10.5" r="3" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M7.6 8.4L13.5 2.5M11.5 4.5L13 6M10 6L11.2 7.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/>"#
);
icon!(
    UNPLUG,
    "collie-unplug",
    r#"<path d="M2.5 13.5L5 11M13.5 2.5L11 5M6.5 9.5L5.5 10.5M9.5 6.5L10.5 5.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/><path d="M4 9L7 12L8 11C8.8 10.2 8.8 8.9 8 8.1L7.9 8C7.1 7.2 5.8 7.2 5 8L4 9ZM12 7L9 4L8 5C7.2 5.8 7.2 7.1 8 7.9L8.1 8C8.9 8.8 10.2 8.8 11 8L12 7Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/>"#
);
icon!(
    WARNING,
    "collie-warning",
    r#"<path d="M8 2.5L14 13H2L8 2.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/><path d="M8 6.5V9.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="11" r=".7" fill="currentColor"/>"#
);
icon!(
    PANE,
    "collie-pane",
    r#"<rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M4.5 6.5L6.5 8L4.5 9.5M8 10H11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#
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
icon!(
    CHEVRON_RIGHT,
    "collie-chevron-right",
    r#"<path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#
);
icon!(
    CHEVRON_DOWN,
    "collie-chevron-down",
    r#"<path d="M3.5 6L8 10.5L12.5 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#
);
icon!(
    STEP_DONE,
    "collie-step-done",
    r#"<circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M5.3 8.2L7.2 10L10.8 6.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#
);
icon!(
    STEP_RUNNING,
    "collie-step-running",
    r#"<circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="8" cy="8" r="2.75" fill="currentColor"/>"#
);
icon!(
    STEP_NEEDS_YOU,
    "collie-step-needs-you",
    r#"<circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M8 4.8V8.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11" r=".9" fill="currentColor"/>"#
);
icon!(
    STEP_FAILED,
    "collie-step-failed",
    r#"<circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M5.8 5.8L10.2 10.2M10.2 5.8L5.8 10.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>"#
);
icon!(
    STEP_WAITING,
    "collie-step-waiting",
    r#"<circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M8 5V8L10 9.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#
);
icon!(
    STEP_STOPPED,
    "collie-step-stopped",
    r#"<circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="5.8" y="5.8" width="4.4" height="4.4" rx=".8" fill="currentColor"/>"#
);
icon!(
    STEP_NOT_RUN,
    "collie-step-not-run",
    r#"<circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M3.8 3.8L12.2 12.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>"#
);
icon!(
    STEP_EXPECTED,
    "collie-step-expected",
    r#"<circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.4 2.2" fill="none"/>"#
);
icon!(
    SPARKLES,
    "collie-sparkles",
    r#"<path d="M6.5 2.5L7.6 5.4L10.5 6.5L7.6 7.6L6.5 10.5L5.4 7.6L2.5 6.5L5.4 5.4Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/><path d="M11.5 9.5L12.1 10.9L13.5 11.5L12.1 12.1L11.5 13.5L10.9 12.1L9.5 11.5L10.9 10.9Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" fill="none"/>"#
);
