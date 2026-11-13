use crate::App;
use collie_desktop_protocol::generated::{
    Address, ArtefactCollection, ArtefactsPayload, Narrative, NarrativeState,
};
use rune::{El, col, text};
use rune_kit::{Button, Kit};

pub fn concise(source: &str) -> String {
    let words = source.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut sentences = 0;
    let mut chars = Vec::new();
    for ch in words.chars() {
        chars.push(ch);
        if matches!(ch, '.' | '!' | '?' | '。' | '！' | '？') {
            sentences += 1;
            if sentences == 2 {
                break;
            }
        }
    }
    if chars.len() > 360 {
        chars.truncate(359);
        chars.push('…');
    }
    chars.into_iter().collect::<String>().trim().into()
}

pub fn report(report: &Narrative, k: &Kit) -> El {
    let mut block = col().w_full().gap(6.0);
    if let Some(blocker) = &report.blocker {
        block = block.child(
            text(format!("Blocker: {}", concise(blocker)))
                .font(k.ty.small)
                .color(k.c.warning.fg)
                .wrap()
                .w_full(),
        );
    }
    if let Some(action) = &report.next_action {
        block = block.child(
            text(format!("Next: {}", concise(action)))
                .font(k.ty.small)
                .color(k.c.text_base)
                .wrap()
                .w_full(),
        );
    }
    if let Some(address) = report
        .address
        .as_ref()
        .filter(|_| report.state == NarrativeState::Ready)
    {
        let address = address.clone();
        block = block.child(
            Button::new("Open report")
                .on_press(move |app: &mut App| app.open_report(address.clone()))
                .build(k)
                .label(format!("Open report: {}", report.title))
                .key("open-report"),
        );
    } else {
        let state = match report.state {
            NarrativeState::Preparing => "Preparing report".into(),
            NarrativeState::Failed => format!(
                "Report preparation failed: {}",
                report
                    .reason
                    .as_deref()
                    .unwrap_or("retry from the Run's material")
            ),
            _ => format!(
                "Report unavailable: {}",
                report
                    .reason
                    .as_deref()
                    .unwrap_or("its owner has not registered a retained report")
            ),
        };
        block = block.child(
            text(state)
                .font(k.ty.small)
                .color(k.c.text_muted)
                .wrap()
                .w_full(),
        );
    }
    block
}

impl App {
    pub fn retry_reports(&mut self, installation: String, run_id: String) {
        let Some(core) = self.core.clone() else {
            return;
        };
        core.request(
            "artefacts",
            ArtefactsPayload {
                installation,
                run_id,
                refresh: Some(Some(true)),
            },
            |app: &mut App, result: Result<ArtefactCollection, _>| {
                if let Err(why) = result {
                    app.warn(format!("Report preparation failed: {why}"));
                }
            },
        );
    }

    pub fn open_report(&mut self, address: Address) {
        self.board.opened = None;
        let expected = address.clone();
        let machine = self
            .machines
            .iter()
            .find(|one| one.machine.installation == address.installation)
            .map(|one| one.machine.name.clone())
            .unwrap_or_else(|| address.installation.clone());
        self.open_record(
            address.installation,
            address.run,
            machine,
            Some("artefacts"),
        );
        if let Some(record) = &mut self.record.open {
            record.artefacts.report_only = true;
            record.artefacts.expected_report = Some(expected);
            record.artefacts.selected = Some((address.id, address.revision));
        }
    }
}
