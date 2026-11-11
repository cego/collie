//! The chat's glyphs: 16-point line icons drawn in the text's colour.

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
    SEND,
    "chat-send",
    r#"<path d="M8 13V3.5M3.75 7.5L8 3.25L12.25 7.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#
);
icon!(
    STOP,
    "chat-stop",
    r#"<rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor"/>"#
);
icon!(
    CLIP,
    "chat-clip",
    r#"<path d="M12.5 7.5L8 12C6.6 13.4 4.5 13.4 3.4 12.1C2.3 10.9 2.5 9 3.8 7.8L8.6 3C9.5 2.1 10.9 2.1 11.7 3C12.5 3.8 12.5 5.1 11.6 6L7.1 10.5C6.6 11 5.9 11 5.5 10.6C5.1 10.2 5.1 9.5 5.6 9L9.6 5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#
);
icon!(
    NEW,
    "chat-new",
    r#"<path d="M13.5 8.5V12.5C13.5 13.1 13.1 13.5 12.5 13.5H3.5C2.9 13.5 2.5 13.1 2.5 12.5V3.5C2.5 2.9 2.9 2.5 3.5 2.5H7.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/><path d="M11.6 2.4L13.6 4.4L8.2 9.8L5.8 10.2L6.2 7.8Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/>"#
);
icon!(
    HISTORY,
    "chat-history",
    r#"<path d="M2.75 8A5.25 5.25 0 1 0 4.3 4.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/><path d="M2.5 2.5V5H5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M8 5.25V8L10 9.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#
);
icon!(
    BELL,
    "chat-bell",
    r#"<path d="M4 11.5V7.5C4 5.3 5.8 3.5 8 3.5C10.2 3.5 12 5.3 12 7.5V11.5L13 12.5H3Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/><path d="M6.75 14H9.25" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>"#
);
icon!(
    BELL_OFF,
    "chat-bell-off",
    r#"<path d="M4 11.5V7.5C4 6.7 4.2 6 4.6 5.4M6.2 3.9C6.7 3.6 7.4 3.5 8 3.5C10.2 3.5 12 5.3 12 7.5V10.5M11 12.5H3L4 11.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M2.5 2.5L13.5 13.5M6.75 14H9.25" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>"#
);
icon!(
    POP_OUT,
    "chat-pop-out",
    r#"<path d="M7 3.5H3.5C2.9 3.5 2.5 3.9 2.5 4.5V12.5C2.5 13.1 2.9 13.5 3.5 13.5H11.5C12.1 13.5 12.5 13.1 12.5 12.5V9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/><path d="M9.5 2.5H13.5V6.5M13.5 2.5L7.5 8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#
);
icon!(
    POP_IN,
    "chat-pop-in",
    r#"<rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M9.5 3V13" stroke="currentColor" stroke-width="1.2"/>"#
);
icon!(
    COPY,
    "chat-copy",
    r#"<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M10.5 3.5V3C10.5 2.7 10.3 2.5 10 2.5H3.5C2.9 2.5 2.5 2.9 2.5 3.5V10C2.5 10.3 2.7 10.5 3 10.5H3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/>"#
);
icon!(
    CHECK,
    "chat-check",
    r#"<path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#
);
icon!(
    TOOL,
    "chat-tool",
    r#"<path d="M9.8 2.7C8.6 2.3 7.2 2.6 6.3 3.6C5.4 4.5 5.1 5.8 5.5 7L2.6 9.9C2 10.5 2 11.4 2.6 12L4 13.4C4.6 14 5.5 14 6.1 13.4L9 10.5C10.2 10.9 11.5 10.6 12.4 9.7C13.4 8.8 13.7 7.4 13.3 6.2L11.4 8.1L9.2 7.9L8 6.7L7.9 4.6Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/>"#
);
icon!(
    CHEVRON,
    "chat-chevron",
    r#"<path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#
);
icon!(
    CHEVRON_DOWN,
    "chat-chevron-down",
    r#"<path d="M4.5 6.25L8 9.75L11.5 6.25" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#
);
icon!(
    CLOSE,
    "chat-close",
    r#"<path d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>"#
);
icon!(
    INFO,
    "chat-info",
    r#"<circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M8 7.25V11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="5.1" r=".8" fill="currentColor"/>"#
);
icon!(
    ALERT,
    "chat-alert",
    r#"<path d="M8 2.5L14 13H2Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/><path d="M8 6.5V9.25" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="11.1" r=".75" fill="currentColor"/>"#
);
icon!(
    RETRY,
    "chat-retry",
    r#"<path d="M13 8A5 5 0 1 1 11.5 4.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/><path d="M11.75 2V4.75H9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#
);
icon!(
    FILE,
    "chat-file",
    r#"<path d="M4 2.5H9.5L12.5 5.5V13C12.5 13.3 12.2 13.5 12 13.5H4C3.7 13.5 3.5 13.3 3.5 13V3C3.5 2.7 3.7 2.5 4 2.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/><path d="M9.5 2.5V5.5H12.5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/>"#
);
icon!(
    THOUGHT,
    "chat-thought",
    r#"<path d="M5.5 11.5C3.8 11.5 2.5 10.2 2.5 8.6C2.5 7.3 3.4 6.2 4.6 5.8C4.9 4 6.3 2.5 8.25 2.5C10.2 2.5 11.6 4 11.9 5.8C12.9 6.2 13.5 7.2 13.5 8.4C13.5 10.1 12.2 11.5 10.5 11.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/><circle cx="5" cy="13.75" r=".9" fill="currentColor"/>"#
);
icon!(
    FLOCK,
    "chat-flock",
    r#"<path d="M3 3.5H13C13.3 3.5 13.5 3.7 13.5 4V10.5C13.5 10.8 13.3 11 13 11H7L4 13.5V11H3C2.7 11 2.5 10.8 2.5 10.5V4C2.5 3.7 2.7 3.5 3 3.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/><path d="M5.5 7.25H10.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>"#
);
