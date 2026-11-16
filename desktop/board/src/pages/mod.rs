//! The pages the sidebar opens beside the Board, each with its own state.

pub mod artefacts;
pub mod cleanup;
pub mod clock;
pub mod common;
pub mod flock;
pub mod in_sync;
pub mod machines;
pub mod onboard;
pub mod schedules;
pub mod settings;
pub mod usage;
pub mod workflows;

#[derive(Default)]
pub struct Pages {
    pub settings: settings::Settings,
    pub machines: machines::Machines,
    pub workflows: workflows::Workflows,
    pub schedules: schedules::Schedules,
    pub usage: usage::Usage,
    pub artefacts: artefacts::Artefacts,
}
