//! The Workflows page: the Workflows and Personas a host reads, one view for the Flock (In
//! sync Machines share their definitions), and each one read in full. A port of
//! `WorkflowsPage.vue` and `desktop/src/shared/definitions-view.ts`.

use super::common::{Tone, code, heading, muted, toned};
use crate::App;
use collie_desktop_protocol::generated::{
    DefinitionsPayload, DefinitionsSuccess, Layer, Persona, PersonaLayer, Workflow,
};
use rune::{El, col, el, row, text};
use rune_kit::{
    Badge, BadgeVariant, Button, ButtonVariant, ControlSize, Divider, Kit, Markdown, Tree,
    TreeItem, TreeModel,
};
use serde_json::Value;

/// A follow-up or card action a module's metadata declares.
#[derive(Debug, Clone, PartialEq)]
pub struct Offer {
    pub id: String,
    pub title: String,
    pub workflow: String,
    pub when: String,
}

/// The follow-ups and card actions a module's metadata declares; none where it says none, or
/// says them in another shape.
pub fn offers_of(metadata: &Value) -> Vec<Offer> {
    let offered = |v: &Value| -> Option<(String, String, String)> {
        Some((
            v.get("id")?.as_str()?.to_string(),
            v.get("title")?.as_str()?.to_string(),
            v.get("workflow")?.as_str()?.to_string(),
        ))
    };
    let list = |key: &str| -> Option<Vec<Value>> {
        match metadata.get(key) {
            None => Some(vec![]),
            Some(Value::Array(items)) => Some(items.clone()),
            Some(_) => None,
        }
    };
    let (Some(follow_ups), Some(actions)) = (list("followUps"), list("actions")) else {
        return vec![];
    };
    if !metadata.is_object() {
        return vec![];
    }
    let follow: Option<Vec<Offer>> = follow_ups
        .iter()
        .map(|v| {
            let (id, title, workflow) = offered(v)?;
            let when = match v.get("when")?.as_str()? {
                "succeeded" => "after it succeeds",
                "failed" => "after it fails",
                "always" => "after it ends",
                _ => return None,
            };
            Some(Offer {
                id,
                title,
                workflow,
                when: when.into(),
            })
        })
        .collect();
    let acts: Option<Vec<Offer>> = actions
        .iter()
        .map(|v| {
            let (id, title, workflow) = offered(v)?;
            Some(Offer {
                id,
                title,
                workflow,
                when: "on its card".into(),
            })
        })
        .collect();
    match (follow, acts) {
        (Some(mut follow), Some(acts)) => {
            follow.extend(acts);
            follow
        }
        _ => vec![],
    }
}

/// A module's Markdown is read rendered; anything else is code.
pub fn is_markdown(path: &str) -> bool {
    path.ends_with(".md")
}

/// A tree row: a section or a Workflow, Persona or problem in it.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub label: String,
    pub badge: Option<String>,
    pub broken: bool,
}

fn label(entry: &Entry) -> &str {
    &entry.label
}

#[derive(Default)]
pub struct Workflows {
    /// The installation read from and its Machine's name.
    pub from: Option<(String, String)>,
    pub read: Option<DefinitionsSuccess>,
    pub failed: Option<String>,
    pub tree: TreeModel<Entry>,
    /// Whether a Workflow's raw metadata is shown, as today's `<details>` opens it.
    pub metadata_open: bool,
}

fn layer_of(layer: &Layer) -> &'static str {
    match layer {
        Layer::Project => "project",
        Layer::User => "user",
        Layer::Shipped => "shipped",
    }
}

fn persona_layer(layer: &PersonaLayer) -> &'static str {
    match layer {
        PersonaLayer::Baseline => "baseline",
        PersonaLayer::User => "user",
        PersonaLayer::Project => "project",
    }
}

/// The tree of what a host read: its Workflows, what would not load, and its Personas.
pub fn tree_of(read: &DefinitionsSuccess) -> TreeModel<Entry> {
    let mut tree = TreeModel::new().key("definitions");
    let section = |label: String| Entry {
        label,
        badge: None,
        broken: false,
    };
    tree.insert(
        None,
        "workflows",
        section(format!("Workflows · {}", read.workflows.len())),
    );
    for one in &read.workflows {
        tree.insert(
            Some("workflows"),
            format!("workflow:{}", one.id),
            Entry {
                label: one.title.clone(),
                badge: Some(layer_of(&one.layer).into()),
                broken: one.broken.is_some(),
            },
        );
    }
    if !read.problems.is_empty() {
        tree.insert(None, "problems", section("Would not load".into()));
        for (i, problem) in read.problems.iter().enumerate() {
            tree.insert(
                Some("problems"),
                format!("problem:{i}"),
                Entry {
                    label: problem.path.clone(),
                    badge: None,
                    broken: true,
                },
            );
        }
    }
    tree.insert(
        None,
        "personas",
        section(format!("Personas · {}", read.personas.len())),
    );
    for one in &read.personas {
        tree.insert(
            Some("personas"),
            format!("persona:{}", one.name),
            Entry {
                label: one.name.clone(),
                badge: Some(persona_layer(&one.layer).into()),
                broken: false,
            },
        );
    }
    if !read.errors.is_empty() {
        tree.insert(
            None,
            "errors",
            section("Personas that would not load".into()),
        );
        for (i, error) in read.errors.iter().enumerate() {
            tree.insert(
                Some("errors"),
                format!("error:{i}"),
                Entry {
                    label: error.clone(),
                    badge: None,
                    broken: true,
                },
            );
        }
    }
    tree.expand_all();
    tree
}

impl Workflows {
    /// The sidebar has opened this page: each opening reads again.
    pub fn opened(app: &mut App) {
        let from = app
            .machines
            .iter()
            .min_by_key(|m| m.machine.profile != "local")
            .map(|m| (m.machine.installation.clone(), m.machine.name.clone()));
        let state = &mut app.pages.workflows;
        state.read = None;
        state.from = from.clone();
        state.failed = from
            .is_none()
            .then(|| "No Machine is connected".to_string());
        let (Some(core), Some((installation, _))) = (&app.core, from) else {
            return;
        };
        core.request(
            "definitions",
            DefinitionsPayload { installation },
            |app: &mut App, read: Result<DefinitionsSuccess, _>| {
                let state = &mut app.pages.workflows;
                match read {
                    Ok(read) => {
                        state.tree = tree_of(&read);
                        state.read = Some(read);
                    }
                    Err(why) => state.failed = Some(why.0),
                }
            },
        );
    }

    fn chosen(&self) -> Option<Chosen<'_>> {
        let read = self.read.as_ref()?;
        let id = self.tree.cursor()?;
        if let Some(id) = id.strip_prefix("workflow:") {
            return read
                .workflows
                .iter()
                .find(|w| w.id == id)
                .map(Chosen::Workflow);
        }
        if let Some(name) = id.strip_prefix("persona:") {
            return read
                .personas
                .iter()
                .find(|p| p.name == name)
                .map(Chosen::Persona);
        }
        if let Some(i) = id.strip_prefix("problem:") {
            let problem = read.problems.get(i.parse::<usize>().ok()?)?;
            return Some(Chosen::Problem(&problem.path, &problem.message));
        }
        None
    }
}

enum Chosen<'a> {
    Workflow(&'a Workflow),
    Persona(&'a Persona),
    Problem(&'a str, &'a str),
}

fn badge(k: &Kit, label: &str) -> El {
    Badge::new(label.to_string())
        .variant(BadgeVariant::Neutral)
        .build(k)
}

fn json(value: &Option<Value>) -> String {
    match value {
        None => "null".into(),
        Some(v) => serde_json::to_string_pretty(v).unwrap_or_default(),
    }
}

fn schema(k: &Kit, value: &Option<Value>) -> El {
    col()
        .w_full()
        .min_w(0.0)
        .padding(10.0)
        .radius(k.radius.sm)
        .fill(k.c.layer_02)
        .child(code(k, json(value)).w_full())
}

fn fence(path: &str, source: &str) -> String {
    let language = path.rsplit('.').next().unwrap_or("");
    let ticks = if source.contains("```") {
        "````"
    } else {
        "```"
    };
    format!("{ticks}{language}\n{source}\n{ticks}")
}

/// A Workflow's or Persona's title, what it is for, and where it was read, over a rule.
fn header(k: &Kit, title: &str, description: &str, facts: El) -> El {
    col()
        .w_full()
        .gap(10.0)
        .child(
            text(title.to_string())
                .role("heading")
                .font(
                    rune::TextStyle {
                        size: 22.0,
                        ..k.ty.ui_medium
                    }
                    .lh(28.0),
                )
                .color(k.c.text_strong)
                .wrap()
                .w_full(),
        )
        .child(
            text(description.to_string())
                .font(k.ty.body)
                .color(k.c.text_base)
                .wrap()
                .w_full(),
        )
        .child(facts)
        .child(Divider::horizontal().build(k).mt(8.0))
}

fn path_text(k: &Kit, path: &str) -> El {
    text(path.to_string())
        .font(k.ty.text_small)
        .color(k.c.text_faint)
        .wrap_anywhere()
        .shrink()
        .selectable(true)
        .selection_color(k.selection())
}

fn workflow(k: &Kit, one: &Workflow, metadata_open: bool) -> El {
    let facts = row()
        .w_full()
        .flex_wrap()
        .gap(8.0)
        .center_y()
        .child(badge(k, layer_of(&one.layer)))
        .child(
            text(one.id.clone())
                .font(k.ty.mono)
                .color(k.c.text_muted),
        )
        .child(text("·").font(k.ty.text_small).color(k.c.text_faint))
        .child(path_text(k, &one.path));
    let mut article = col().key("workflow").w_full().gap(28.0).child(header(
        k,
        &one.title,
        &one.description,
        facts,
    ));
    if let Some(broken) = &one.broken {
        article = article.child(
            col()
                .key("broken")
                .role("alert")
                .w_full()
                .padding(12.0)
                .gap(4.0)
                .radius(k.radius.md)
                .fill(k.c.danger.bg)
                .child(
                    text("Won't construct")
                        .font(k.ty.ui_medium)
                        .color(k.c.danger.fg),
                )
                .child(toned(k, broken.clone(), Tone::Bad)),
        );
    }
    let mut inputs = col().w_full().gap(10.0).child(heading(k, "Inputs"));
    if one.inputs.is_empty() {
        inputs = inputs.child(muted(k, "None"));
    }
    for input in &one.inputs {
        let mut line = row()
            .gap(8.0)
            .center_y()
            .child(
                text(input.name.clone())
                    .font(k.ty.mono)
                    .color(k.c.text_strong),
            )
            .child(
                Badge::new(if input.required {
                    "required"
                } else {
                    "optional"
                })
                .variant(if input.required {
                    BadgeVariant::Accent
                } else {
                    BadgeVariant::Neutral
                })
                .build(k),
            );
        if let Some(strategy) = &input.strategy {
            line = line.child(
                text(format!("inferred by {strategy}"))
                    .font(k.ty.text_small)
                    .color(k.c.text_muted),
            );
        }
        let about = input
            .schema
            .as_ref()
            .and_then(|s| s.get("description"))
            .and_then(Value::as_str)
            .map(|d| muted(k, d.to_string()));
        let mut card = super::common::panel(k, format!("input-{}", input.name), input.name.clone())
            .child(line)
            .children(about)
            .child(schema(k, &input.schema));
        for limit in &input.limits {
            card = card.child(muted(k, limit.clone()));
        }
        inputs = inputs.child(card);
    }
    article = article.child(inputs);
    let offers = offers_of(&one.metadata);
    let mut offered = col()
        .key("offers")
        .w_full()
        .gap(8.0)
        .child(heading(k, "Offers"));
    if offers.is_empty() {
        offered = offered.child(muted(k, "None"));
    }
    for offer in &offers {
        offered = offered.child(
            row()
                .w_full()
                .flex_wrap()
                .gap(6.0)
                .center_y()
                .child(
                    text(offer.title.clone())
                        .font(k.ty.text_small_medium)
                        .color(k.c.text_base),
                )
                .child(
                    text(format!("starts {} {}", offer.workflow, offer.when))
                        .font(k.ty.text_small)
                        .color(k.c.text_muted),
                ),
        );
    }
    article = article.child(offered);
    for (title, drawn) in [("Result", &one.success), ("Failure", &one.error)] {
        let mut part = col()
            .w_full()
            .gap(8.0)
            .child(heading(k, title))
            .child(schema(k, &drawn.schema));
        for limit in &drawn.limits {
            part = part.child(muted(k, limit.clone()));
        }
        article = article.child(part);
    }
    let mut options = col()
        .w_full()
        .gap(6.0)
        .child(heading(k, "Settled by the host"));
    for option in &one.options {
        options = options.child(
            row()
                .w_full()
                .gap(12.0)
                .items_start()
                .child(
                    text(option.name.clone())
                        .font(k.ty.mono)
                        .color(k.c.text_base)
                        .w(180.0),
                )
                .child(muted(k, option.meaning.clone()).grow(1.0).shrink()),
        );
    }
    article = article.child(options).child(
        col()
            .key("metadata")
            .w_full()
            .gap(8.0)
            .child(
                row()
                    .w_full()
                    .gap(8.0)
                    .center_y()
                    .child(heading(k, "Metadata"))
                    .child(
                        Button::new(if metadata_open { "Hide" } else { "Show" })
                            .variant(ButtonVariant::GhostMuted)
                            .control_size(ControlSize::Small)
                            .expanded(metadata_open)
                            .on_press(|app: &mut App| {
                                let state = &mut app.pages.workflows;
                                state.metadata_open = !state.metadata_open;
                            })
                            .build(k)
                            .key("metadata-toggle")
                            .label(if metadata_open {
                                "Hide metadata"
                            } else {
                                "Show metadata"
                            }),
                    ),
            )
            .children(metadata_open.then(|| schema(k, &Some(one.metadata.clone())))),
    );
    for file in &one.files {
        let shown = if is_markdown(&file.path) {
            Markdown::new(file.text.clone()).build(k)
        } else {
            Markdown::new(fence(&file.path, &file.text)).build(k)
        };
        article = article.child(
            col()
                .key(format!("file-{}", file.path))
                .role("group")
                .label(file.path.clone())
                .w_full()
                .radius(k.radius.md)
                .border(1.0, k.c.border_muted)
                .clip_rounded(k.radius.md)
                .child(
                    el().w_full()
                        .px(14.0)
                        .py(8.0)
                        .fill(k.c.layer_02)
                        .child(path_text(k, &file.path)),
                )
                .child(Divider::horizontal().build(k))
                .child(col().w_full().px(16.0).py(14.0).child(shown)),
        );
    }
    article
}

fn persona(k: &Kit, one: &Persona) -> El {
    let mut facts = row()
        .w_full()
        .flex_wrap()
        .gap(8.0)
        .center_y()
        .child(badge(k, persona_layer(&one.layer)))
        .child(path_text(k, &one.path));
    if let Some(base) = &one.extends {
        facts = facts
            .child(text("·").font(k.ty.text_small).color(k.c.text_faint))
            .child(
                text(format!("extends {base}"))
                    .font(k.ty.text_small)
                    .color(k.c.text_muted),
            );
    }
    col()
        .key("persona")
        .w_full()
        .max_w(760.0)
        .gap(20.0)
        .child(header(k, &one.name, &one.description, facts))
        .child(Markdown::new(one.body.clone()).build(k))
}

pub fn view(app: &App, k: &Kit, _layer: &mut Vec<El>) -> El {
    let state = &app.pages.workflows;
    let from = state.from.as_ref().map(|(_, name)| name.as_str());
    let Some(read) = &state.read else {
        let said = match &state.failed {
            Some(why) => toned(k, why.clone(), Tone::Bad).key("read-failed"),
            None => muted(k, "Reading…"),
        };
        return col().key("workflows-page").padding(20.0).child(said);
    };
    let tree = Tree::new(
        |app: &App| &app.pages.workflows.tree,
        |app: &mut App| &mut app.pages.workflows.tree,
        label,
    )
    .name("Workflows and Personas")
    .row({
        let (faint, bad) = (k.c.text_faint, k.c.danger.icon);
        move |entry: &Entry, _| {
            let mut item = TreeItem::new(entry.label.clone());
            if entry.broken {
                item = item.dot(bad);
            }
            match &entry.badge {
                Some(layer) => item.badge(layer.clone()),
                None if !entry.broken => item.label_color(faint),
                None => item,
            }
        }
    })
    .build(app, k)
    .grow(1.0)
    .min_h(0.0);
    let list = col()
        .key("definitions-list")
        .w(300.0)
        .h_full()
        .padding(8.0)
        .gap(8.0)
        .border(1.0, k.c.border_muted)
        .child(
            text(format!("Read from {}", from.unwrap_or("this Machine")))
                .key("read-from")
                .font(k.ty.text_small)
                .color(k.c.text_muted)
                .px(8.0)
                .pt(4.0),
        )
        .child(tree);
    let detail = match state.chosen() {
        Some(Chosen::Workflow(one)) => workflow(k, one, state.metadata_open),
        Some(Chosen::Persona(one)) => persona(k, one),
        Some(Chosen::Problem(path, message)) => col()
            .key("problem")
            .gap(8.0)
            .child(heading(k, "Would not load"))
            .child(code(k, path.to_string()))
            .child(toned(k, message.to_string(), Tone::Bad)),
        None => col()
            .key("nothing-chosen")
            .w_full()
            .max_w(440.0)
            .gap(8.0)
            .pt(80.0)
            .child(
                text("Choose a Workflow or a Persona to read it")
                    .font(k.ty.ui_medium)
                    .color(k.c.text_base),
            )
            .child(muted(
                k,
                format!(
                    "A Workflow shows its Inputs, what it gives back, what it offers next and its \
                     files. A Persona shows its instructions. {} Workflows and {} Personas are read \
                     from {}.",
                    read.workflows.len(),
                    read.personas.len(),
                    from.unwrap_or("this Machine")
                ),
            )),
    };
    row()
        .key("workflows-page")
        .label("Workflows")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .child(list)
        .child(
            col()
                .key("definition")
                .grow(1.0)
                .min_w(0.0)
                .h_full()
                .scroll(rune::ScrollSpec {
                    stick_bottom: false,
                })
                .child(col().w_full().max_w(880.0).px(28.0).py(24.0).child(detail)),
        )
}
