//! An onboarding as it stands: its steps, what each leaves the human to do, and herdr's own
//! questions. A port of `OnboardSteps.vue`, `OnboardDialog.vue` and `useOnboarding`.

use super::common::{Tone, code, muted, toned};
use super::flock::settled;
use crate::App;
use collie_desktop_protocol::generated::{
    AnswerHerdrPayload, OnboardPayload, OpenLinkPayload, PasteCodePayload, RunStep, SkipItem,
    Status,
};
use rune::{El, TextEdit, col, el, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Dialog, Kit, Spinner, TextInput};
use serde_json::json;

fn dot(k: &Kit, status: &Status) -> El {
    if *status == Status::Running {
        return el()
            .size(16.0, 18.0)
            .center()
            .child(Spinner::new().size(12.0).build(k));
    }
    let color = match status {
        Status::Done | Status::InPlace => k.c.success.icon,
        Status::NeedsRoot | Status::NeedsHuman => k.c.warning.icon,
        Status::Failed => k.c.danger.icon,
        _ => k.c.icon_faint,
    };
    el().size(16.0, 18.0)
        .center()
        .a11y_hidden()
        .child(el().size(8.0, 8.0).radius(4.0).fill(color))
}

fn status_said(status: &Status) -> &'static str {
    match status {
        Status::Running => "running",
        Status::Done => "done",
        Status::InPlace => "in place",
        Status::Skipped => "skipped",
        Status::NeedsRoot => "needs root",
        Status::NeedsHuman => "needs you",
        Status::Failed => "failed",
    }
}

fn skippable(step: &str) -> Option<SkipItem> {
    match step {
        "helle" => Some(SkipItem::Helle),
        "linear" => Some(SkipItem::Linear),
        _ => None,
    }
}

fn small(label: &str, variant: ButtonVariant) -> Button {
    Button::new(label)
        .variant(variant)
        .control_size(ControlSize::Small)
}

/// The steps of an onboarding of the Machine on `profile`. `ended` once it has, when a step
/// left unsettled offers to try again; `job` is the onboarding a login code goes to.
pub fn steps(
    k: &Kit,
    key: &str,
    profile: &str,
    steps: &[RunStep],
    ended: bool,
    job: Option<(&str, &TextEdit)>,
) -> El {
    let items = steps.iter().map(|one| {
        let left = one.status != Status::Running && !settled(&one.status);
        let mut lines = col().grow(1.0).shrink().min_w(0.0).gap(4.0).child(
            row()
                .gap(8.0)
                .center_y()
                .child(
                    text(one.title.clone())
                        .key("title")
                        .font(k.ty.ui_medium)
                        .color(k.c.text_base),
                )
                .child(
                    text(status_said(&one.status))
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint),
                ),
        );
        if let Some(detail) = &one.detail {
            lines = lines.child(muted(k, detail.clone()).key("detail"));
        }
        if let Some(command) = &one.command {
            lines = lines.child(
                el().key("command")
                    .w_full()
                    .px(8.0)
                    .py(4.0)
                    .radius(k.radius.sm)
                    .fill(k.c.layer_02)
                    .child(code(k, command.clone())),
            );
        }
        let mut actions = row().gap(6.0).flex_wrap();
        let mut any = false;
        if let Some(url) = &one.url {
            let url = url.clone();
            any = true;
            actions = actions.child(
                small("Open", ButtonVariant::Outline)
                    .on_press(move |app: &mut App| app.open_link(&url))
                    .build(k)
                    .key("open"),
            );
        }
        if ended && left && one.step == "claude-login" {
            let profile = profile.to_string();
            any = true;
            actions = actions.child(
                small("Log in", ButtonVariant::Neutral)
                    .on_press(move |app: &mut App| app.login_on(&profile))
                    .build(k)
                    .key("login"),
            );
        }
        // Saving in herdr is not onboarding: a Machine herdr would not save is added again.
        if ended && left && one.step != "herdr" {
            let profile = profile.to_string();
            any = true;
            actions = actions.child(
                small("Retry", ButtonVariant::Neutral)
                    .on_press(move |app: &mut App| app.onboard_on(&profile, None))
                    .build(k)
                    .key("retry"),
            );
        }
        if let (true, true, Some(skip)) = (ended, left, skippable(&one.step)) {
            let profile = profile.to_string();
            any = true;
            actions = actions.child(
                small("Skip on this Machine", ButtonVariant::Ghost)
                    .on_press(move |app: &mut App| app.onboard_on(&profile, Some(skip.clone())))
                    .build(k)
                    .key("skip"),
            );
        }
        if any {
            lines = lines.child(actions);
        }
        if ended
            && one.status == Status::NeedsHuman
            && (one.step == "gitlab" || one.step == "helle")
        {
            lines = lines.child(muted(
                k,
                "Keep it once in Settings, under Credentials; then Retry onboards this Machine again.",
            ));
        }
        if let (Some((job, edit)), true, true, Some(_)) = (
            job,
            one.step == "claude-login",
            one.status == Status::Running,
            &one.url,
        ) {
            let job = job.to_string();
            let send = job.clone();
            lines = lines.child(
                row()
                    .w_full()
                    .gap(6.0)
                    .center_y()
                    .child(
                        TextInput::new(edit)
                            .placeholder("Code")
                            .label("The code the login page gave")
                            .on_edit(|app: &mut App| &mut app.pages.machines.code)
                            .on_submit(move |app: &mut App, _| app.paste_code(&job))
                            .build(k)
                            .key("code")
                            .grow(1.0),
                    )
                    .child(
                        small("Send code", ButtonVariant::Neutral)
                            .on_press(move |app: &mut App| app.paste_code(&send))
                            .build(k)
                            .key("send-code"),
                    ),
            );
        }
        row()
            .key(format!("step-{}", one.step))
            .role("group")
            .label(format!("{}: {}", one.title, status_said(&one.status)))
            .w_full()
            .gap(8.0)
            .items_start()
            .child(dot(k, &one.status))
            .child(lines)
    });
    col()
        .key(key.to_string())
        .w_full()
        .gap(10.0)
        .children(items)
}

impl App {
    fn shown_job(&mut self, started: Result<String, crate::calls::CallError>) {
        match started {
            Ok(job) => self.pages.machines.job = Some(job),
            Err(why) => self.pages.machines.told.say(why.0, false),
        }
    }

    /// Onboards, or repairs, the Machine `profile` reaches and shows it; `skip` from then on.
    pub fn onboard_on(&mut self, profile: &str, skip: Option<SkipItem>) {
        let Some(core) = &self.core else { return };
        let payload = OnboardPayload {
            profile: profile.into(),
            skip: skip.map(|one| vec![one]),
        };
        core.request("onboard", payload, |app: &mut App, job| app.shown_job(job));
    }

    /// Logs Claude Code in there through this computer's browser, then onboards it again.
    pub fn login_on(&mut self, profile: &str) {
        let Some(core) = &self.core else { return };
        core.request(
            "claudeLogin",
            json!({ "profile": profile }),
            |app: &mut App, job| app.shown_job(job),
        );
    }

    pub fn open_link(&mut self, url: &str) {
        let Some(core) = &self.core else { return };
        core.request(
            "openLink",
            OpenLinkPayload { url: url.into() },
            |_: &mut App, _: Result<serde_json::Value, _>| {},
        );
    }

    /// Types the code the human pasted into the login `job` runs.
    pub fn paste_code(&mut self, job: &str) {
        let pasted = self.pages.machines.code.text.trim().to_string();
        self.pages.machines.code.clear();
        if pasted.is_empty() {
            return;
        }
        let Some(core) = &self.core else { return };
        core.request(
            "pasteCode",
            PasteCodePayload {
                job: job.into(),
                code: pasted,
            },
            |_: &mut App, _: Result<serde_json::Value, _>| {},
        );
    }

    /// The human's answer to the question herdr asks in `job`.
    pub fn answer_herdr(&mut self, job: &str, yes: bool) {
        let Some(core) = &self.core else { return };
        core.request(
            "answerHerdr",
            AnswerHerdrPayload {
                job: job.into(),
                yes,
            },
            |_: &mut App, _: Result<serde_json::Value, _>| {},
        );
    }

    /// Closes the onboarding dialog; a question nobody can see any more takes herdr's default.
    pub fn close_onboarding(&mut self) {
        let Some(job) = self.pages.machines.job.take() else {
            return;
        };
        let asked = self
            .pages
            .machines
            .flock
            .job(&job)
            .and_then(|one| one.run.asked.clone());
        if let Some(asked) = asked {
            self.answer_herdr(&job, asked.yes);
        }
    }
}

/// The onboarding the human started, while its dialog is open, and herdr's question over it.
pub fn dialog(app: &App, k: &Kit, layer: &mut Vec<El>) {
    let Some(job) = app.pages.machines.job.as_deref() else {
        return;
    };
    let current = app.pages.machines.flock.job(job);
    let title = format!(
        "Onboarding {}",
        current.map_or("", |one| one.machine.name.as_str())
    );
    let body = match current {
        None => col().child(muted(k, "Starting…")),
        Some(one) => {
            let run = &one.run;
            let mut body = col().w_full().gap(12.0).child(steps(
                k,
                "onboarding-steps",
                &one.machine.profile,
                &run.steps,
                run.ready.is_some(),
                Some((job, &app.pages.machines.code)),
            ));
            match run.ready {
                Some(true) => {
                    body = body.child(
                        toned(k, "Onboarded: collie doctor is ready.", Tone::Ok).key("outcome"),
                    )
                }
                Some(false) => {
                    let said = match &run.reason {
                        None => "Not onboarded yet.".to_string(),
                        Some(why) => format!("Not onboarded yet: {why}"),
                    };
                    body = body.child(toned(k, said, Tone::Warn).key("outcome"));
                }
                None => {}
            }
            body
        }
    };
    Dialog::new("onboarding", title)
        .width(560.0)
        .fit()
        .open(true)
        .child(
            col()
                .key("onboarding")
                .w_full()
                .px(16.0)
                .pb(16.0)
                .max_h(520.0)
                .scroll(rune::ScrollSpec {
                    stick_bottom: false,
                })
                .child(body),
        )
        .on_close(|app: &mut App| app.close_onboarding())
        .build(k, layer);
    let Some(asked) = current.and_then(|one| one.run.asked.as_ref()) else {
        return;
    };
    let (no, yes, default) = (job.to_string(), job.to_string(), asked.yes);
    let closed = job.to_string();
    let answer = |label: &str, chosen: bool| {
        Button::new(label).variant(if chosen == default {
            ButtonVariant::Contrast
        } else {
            ButtonVariant::Outline
        })
    };
    Dialog::new("herdr-question", "herdr asks")
        .width(440.0)
        .fit()
        .open(true)
        .child(
            col()
                .key("herdr-question")
                .w_full()
                .px(16.0)
                .pb(16.0)
                .gap(14.0)
                .child(
                    text(asked.text.clone())
                        .key("question")
                        .font(k.ty.body)
                        .color(k.c.text_base)
                        .wrap()
                        .w_full(),
                )
                .child(
                    row()
                        .w_full()
                        .gap(8.0)
                        .child(el().grow(1.0))
                        .child(
                            answer("No", false)
                                .on_press(move |app: &mut App| app.answer_herdr(&no, false))
                                .build(k)
                                .key("herdr-no"),
                        )
                        .child(
                            answer("Yes", true)
                                .on_press(move |app: &mut App| app.answer_herdr(&yes, true))
                                .build(k)
                                .key("herdr-yes"),
                        ),
                ),
        )
        .on_close(move |app: &mut App| app.answer_herdr(&closed, default))
        .build(k, layer);
}
