//! A mouse wheel's line steps glide; a touchpad's precise deltas still scroll 1:1.

use collie_desktop_chat::glide::{Glide, smooth};
use rune::{Cx, El, Env, Runtime, ScrollSpec, WheelEvent, col, el};
use std::cell::Cell;

#[test]
fn steps_add_up_while_a_glide_runs_and_stop_at_the_ends() {
    let mut g = Glide::default();
    g.scrolled(0.0, 400.0);
    assert_eq!(g.step(-40.0, 0.0), Some(40.0));
    // The view hasn't moved yet: the next step goes on from where the first was going.
    assert_eq!(g.step(-40.0, 0.05), Some(80.0));
    g.scrolled(80.0, 400.0);
    assert_eq!(g.step(-40.0, 0.1), Some(120.0));
    // Up from the middle of a glide turns it around from where it was going.
    g.scrolled(100.0, 400.0);
    assert_eq!(g.step(40.0, 0.12), Some(80.0));
    // Long after, a step starts from where the view is.
    g.scrolled(20.0, 400.0);
    assert_eq!(g.step(-40.0, 5.0), Some(60.0));
    // Clamped to the ends, and nothing at all where it already is.
    g.scrolled(390.0, 400.0);
    assert_eq!(g.step(-40.0, 10.0), Some(400.0));
    g.scrolled(400.0, 400.0);
    assert_eq!(g.step(-40.0, 20.0), None);
    g.scrolled(0.0, 400.0);
    assert_eq!(g.step(40.0, 30.0), None);
}

#[test]
fn the_hand_taking_over_drops_where_a_glide_was_going() {
    let mut g = Glide::default();
    g.scrolled(0.0, 400.0);
    assert_eq!(g.step(-40.0, 0.0), Some(40.0));
    g.held();
    g.scrolled(10.0, 400.0);
    assert_eq!(g.step(-40.0, 0.05), Some(50.0));
}

thread_local! {
    static VIEWS: Cell<u32> = const { Cell::new(0) };
}

#[derive(Default)]
struct S;

fn view(_: &S, _: &mut Cx<S>) -> El {
    VIEWS.with(|v| v.set(v.get() + 1));
    let list = col()
        .key("list")
        .w(300.0)
        .h(200.0)
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .child(
            col()
                .key("rows")
                .w_full()
                .children((0..50).map(|i| el().key(format!("r{i}")).w_full().h(40.0))),
        );
    col().w_full().h_full().child(smooth::<S>(list, "list"))
}

fn rows_y(rt: &Runtime<S>) -> f32 {
    rt.elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("rows"))
        .map(|e| e.rect[1])
        .expect("rows")
}

fn runtime() -> Runtime<S> {
    let mut rt = Runtime::new(
        S,
        view,
        (400.0, 300.0),
        Env {
            system_dark: true,
            scale: 1.0,
        },
    );
    rt.frame(0.0);
    rt.frame(1.0 / 60.0);
    rt
}

#[test]
fn a_wheel_step_glides_there_without_running_the_view() {
    let mut rt = runtime();
    let top = rows_y(&rt);
    let views = VIEWS.with(Cell::get);
    rt.wheel_event(WheelEvent::new(0.0, -40.0).at(150.0, 100.0).precise(false));
    rt.frame(1.0 / 60.0);
    let first = top - rows_y(&rt);
    assert!(
        first > 0.0 && first < 39.0,
        "a step eases in, not jumps: moved {first} on its first frame"
    );
    for _ in 0..60 {
        rt.frame(1.0 / 60.0);
    }
    assert!(
        (top - rows_y(&rt) - 40.0).abs() < 0.5,
        "lands one step down"
    );
    assert_eq!(VIEWS.with(Cell::get), views, "the glide commits nothing");
}

#[test]
fn a_touchpad_still_scrolls_under_the_fingers() {
    let mut rt = runtime();
    let top = rows_y(&rt);
    rt.wheel_event(WheelEvent::new(0.0, -40.0).at(150.0, 100.0).precise(true));
    rt.frame(1.0 / 60.0);
    assert!(
        (top - rows_y(&rt) - 40.0).abs() < 0.5,
        "moved the whole delta at once"
    );
}
