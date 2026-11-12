//! Rune's copy of an offer's form, held to the cases of `test/offer-form.test.ts`.

use collie_desktop_board::board::offer_form::{
    Control, Holds, offer_choices, offer_fields, offer_input,
};
use serde_json::{Value, json};

fn drawn() -> Value {
    json!({"type": "object", "required": ["confirmed", "note"], "properties": {
        "notify": {"type": "boolean", "description": "Tell the channel"},
        "confirmed": {"type": "boolean"},
        "then": {"type": "string", "enum": ["", "finish", "release"]},
        "count": {"type": "integer"},
        "ratio": {"anyOf": [{"type": "number"}, {"type": "string", "enum": ["NaN"]}]},
        "reviewers": {"type": "array", "items": {"type": "string"}},
        "note": {"type": "string", "default": "as it is"},
        "extra": {"type": "object"},
    }})
}

fn entries(pairs: &[(&str, &str)]) -> Vec<(String, Option<String>)> {
    pairs
        .iter()
        .map(|(name, entry)| (name.to_string(), Some(entry.to_string())))
        .collect()
}

#[test]
fn each_field_takes_the_control_its_schema_draws_with_its_label_help_and_default() {
    let fields = offer_fields(Some(&drawn()));
    let of = |name: &str| fields.iter().find(|f| f.name == name).unwrap().clone();
    assert_eq!(of("notify").control, Control::Boolean);
    assert_eq!(of("notify").help.as_deref(), Some("Tell the channel"));
    assert_eq!(of("confirmed").initial.as_deref(), Some("false"));
    assert_eq!(
        of("then").control,
        Control::Enum(vec!["".into(), "finish".into(), "release".into()])
    );
    assert_eq!(of("count").control, Control::Integer);
    assert_eq!(of("ratio").control, Control::Number);
    assert_eq!(of("reviewers").control, Control::List);
    assert_eq!(of("note").initial.as_deref(), Some("as it is"));
    assert!(of("note").required);
    assert_eq!(of("extra").control, Control::Json(Holds::Object));
    let internal = offer_fields(Some(&json!({"properties": {"merge_only": {}}})));
    assert_eq!(internal[0].label, "Merge only");
}

#[test]
fn entries_are_sent_as_their_fields_take_them_and_false_stays_false() {
    assert_eq!(
        offer_input(
            Some(&drawn()),
            &entries(&[
                ("notify", "false"),
                ("confirmed", "true"),
                ("then", ""),
                ("count", " 3 "),
                ("ratio", "0.5"),
                ("reviewers", "alice\n\n bob \n"),
                ("note", "kept"),
                ("extra", r#"{"a":1}"#),
            ]),
        ),
        Ok(
            json!({"notify": false, "confirmed": true, "then": "", "count": 3, "ratio": 0.5,
            "reviewers": ["alice", "bob"], "note": "kept", "extra": {"a": 1}})
        )
    );
    assert_eq!(
        offer_input(
            Some(&drawn()),
            &[
                ("confirmed".into(), Some("false".into())),
                ("note".into(), Some("x".into())),
                ("notify".into(), None),
            ],
        ),
        Ok(json!({"confirmed": false, "note": "x"}))
    );
}

#[test]
fn an_entry_its_field_cannot_take_is_refused_with_why_and_nothing_malformed_is_sent() {
    let refused = offer_input(
        Some(&drawn()),
        &entries(&[
            ("notify", "maybe"),
            ("then", "later"),
            ("count", "2.5"),
            ("ratio", "lots"),
            ("note", ""),
            ("extra", "{a:1"),
        ]),
    )
    .unwrap_err();
    let why = |name: &str| {
        refused
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, w)| w.as_str())
    };
    assert_eq!(why("notify"), Some("Notify must be yes or no"));
    assert_eq!(why("confirmed"), Some("Confirmed needs a value"));
    assert_eq!(
        why("then"),
        Some("Then must be one of: (empty), finish, release")
    );
    assert_eq!(why("count"), Some("Count must be a whole number"));
    assert_eq!(why("ratio"), Some("Ratio must be a number"));
    assert_eq!(why("note"), Some("Note needs a value"));
    assert_eq!(why("extra"), Some("Extra is not valid JSON"));
    assert_eq!(
        offer_input(
            Some(&drawn()),
            &entries(&[("confirmed", "true"), ("note", "x"), ("extra", "[1]")]),
        ),
        Err(vec![("extra".into(), "Extra must be a JSON object".into())])
    );
}

#[test]
fn an_optional_choice_can_be_left_unset_and_a_required_one_cannot() {
    let fields = offer_fields(Some(&drawn()));
    let of = |name: &str| fields.iter().find(|f| f.name == name).unwrap();
    let entries_of = |name: &str| -> Vec<Option<String>> {
        offer_choices(of(name))
            .into_iter()
            .map(|(_, e)| e)
            .collect()
    };
    assert_eq!(
        entries_of("notify"),
        [None, Some("true".into()), Some("false".into())]
    );
    assert_eq!(
        entries_of("confirmed"),
        [Some("true".into()), Some("false".into())]
    );
    assert_eq!(offer_choices(of("then"))[1].0, "(empty)");
}
