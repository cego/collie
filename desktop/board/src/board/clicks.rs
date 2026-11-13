//! What a click, a double-click, a name, a close and Escape do to the selected card and the
//! open record: `desktop/src/shared/board-clicks.ts`, which stays its owner.

/// What is selected, by card key, and the record open, by card key.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BoardState {
    pub selected: Option<String>,
    pub page: Option<String>,
}

/// Where a click or double-click landed. A control takes its own presses in Rune, so only a
/// card's body and the background reach the board.
#[derive(Debug, Clone, PartialEq)]
pub enum Landed {
    Card { card: String, as_of: bool },
    Background,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Gesture {
    Click(Landed),
    DoubleClick(Landed),
    Name(String),
    Close,
    Escape { overlay: bool, typing: bool },
}

pub fn after_gesture(state: &BoardState, gesture: &Gesture) -> BoardState {
    match gesture {
        Gesture::Click(landed) | Gesture::DoubleClick(landed) => match landed {
            Landed::Background if state.page.is_none() => BoardState {
                selected: None,
                ..state.clone()
            },
            Landed::Background => state.clone(),
            Landed::Card { card, as_of } => {
                // A card whose Machine dropped has nobody to read its record from.
                let opens = matches!(gesture, Gesture::DoubleClick(_)) && !as_of;
                BoardState {
                    selected: Some(card.clone()),
                    page: if opens {
                        Some(card.clone())
                    } else {
                        state.page.clone()
                    },
                }
            }
        },
        Gesture::Name(card) => BoardState {
            selected: Some(card.clone()),
            page: Some(card.clone()),
        },
        Gesture::Close => BoardState {
            page: None,
            ..state.clone()
        },
        Gesture::Escape { overlay, typing } => {
            if *overlay || *typing {
                state.clone()
            } else if state.page.is_none() {
                BoardState {
                    selected: None,
                    ..state.clone()
                }
            } else {
                BoardState {
                    page: None,
                    ..state.clone()
                }
            }
        }
    }
}

/// Opening a record whose Run reported something unseen is seeing it: true where the record
/// opened is new and its card is unseen.
pub fn seen_on_opening(
    before: &BoardState,
    after: &BoardState,
    unseen: impl Fn(&str) -> bool,
) -> bool {
    match &after.page {
        Some(page) if before.page.as_ref() != Some(page) => unseen(page),
        _ => false,
    }
}
