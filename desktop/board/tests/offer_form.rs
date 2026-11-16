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
        Control::Enum(vec![json!(""), json!("finish"), json!("release")])
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

#[test]
fn an_enum_of_numbers_booleans_or_null_is_a_choice_of_exactly_those_values_sent_as_themselves() {
    let drawn = json!({"type": "object", "properties": {
        "priority": {"type": "number", "enum": [1, 2], "default": 2},
        "mode": {"enum": ["fast", true, null]},
        "level": {"anyOf": [{"type": "string", "enum": ["low"]}, {"type": "number", "enum": [1]},
            {"type": "boolean", "enum": [true]}]},
    }});
    let fields = offer_fields(Some(&drawn));
    let of = |name: &str| fields.iter().find(|f| f.name == name).unwrap();
    assert_eq!(
        of("priority").control,
        Control::Enum(vec![json!(1), json!(2)])
    );
    assert_eq!(of("priority").initial.as_deref(), Some("2"));
    assert_eq!(
        of("level").control,
        Control::Enum(vec![json!("low"), json!(1), json!(true)])
    );
    assert_eq!(
        offer_choices(of("mode")),
        [
            ("Not set".to_string(), None),
            ("fast".to_string(), Some("fast".to_string())),
            ("true".to_string(), Some("true".to_string())),
            ("null".to_string(), Some("null".to_string())),
        ]
    );
    assert_eq!(
        offer_input(
            Some(&drawn),
            &entries(&[("priority", "1"), ("mode", "true"), ("level", "1")])
        ),
        Ok(json!({"priority": 1, "mode": true, "level": 1}))
    );
    assert_eq!(
        offer_input(
            Some(&drawn),
            &entries(&[("priority", "3"), ("mode", "slow"), ("level", "2")])
        ),
        Err(vec![
            ("level".into(), "Level must be one of: low, 1, true".into()),
            (
                "mode".into(),
                "Mode must be one of: fast, true, null".into()
            ),
            ("priority".into(), "Priority must be one of: 1, 2".into()),
        ])
    );
}

#[test]
fn an_enum_holding_a_string_and_a_value_that_writes_the_same_is_still_a_choice_between_the_two() {
    let drawn = json!({"type": "object", "required": ["pick"], "properties": {
        "pick": {"anyOf": [
            {"type": "string", "enum": ["1"]}, {"type": "number", "enum": [1]},
            {"type": "string", "enum": ["true"]}, {"type": "boolean", "enum": [true]},
            {"type": "string", "enum": ["null"]}, {"type": "object", "enum": [null]},
        ]},
    }});
    let fields = offer_fields(Some(&drawn));
    let choices = offer_choices(&fields[0]);
    let labels: std::collections::HashSet<_> = choices.iter().map(|(label, _)| label).collect();
    let made: std::collections::HashSet<_> = choices.iter().map(|(_, entry)| entry).collect();
    assert_eq!((labels.len(), made.len()), (6, 6));
    let sent: Vec<Value> = choices
        .iter()
        .map(|(_, entry)| {
            let entry = entry.clone().unwrap();
            offer_input(Some(&drawn), &entries(&[("pick", &entry)])).unwrap()["pick"].clone()
        })
        .collect();
    assert_eq!(
        sent,
        [
            json!("1"),
            json!(1),
            json!("true"),
            json!(true),
            json!("null"),
            Value::Null
        ]
    );
}
