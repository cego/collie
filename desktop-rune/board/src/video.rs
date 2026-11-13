#[cfg(not(target_os = "linux"))]
use rune::{El, SurfaceFit};
#[cfg(not(target_os = "linux"))]
use std::path::Path;
#[cfg(not(target_os = "linux"))]
use std::sync::Arc;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::Player;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct State {
    #[cfg(all(test, target_os = "linux"))]
    decoded: Vec<(f64, [u8; 32])>,
    #[cfg(all(test, target_os = "linux"))]
    audio_buffers: u64,
    pub loading: bool,
    pub playing: bool,
    pub ended: bool,
    pub muted: bool,
    pub time: f64,
    pub duration: Option<f64>,
    pub size: Option<(u32, u32)>,
    pub error: Option<String>,
    pub frames: u64,
    pub frame_time: Option<f64>,
    pub audio_streams: i32,
}

#[cfg(not(target_os = "linux"))]
pub struct Player(rune::Player);

#[cfg(not(target_os = "linux"))]
impl Player {
    pub fn open(path: &Path, _: Arc<dyn Fn() + Send + Sync>) -> Self {
        let player = rune::Player::file(path);
        player.set_muted(false);
        player.preload();
        Self(player)
    }
    pub fn state(&self) -> State {
        let state = self.0.state();
        State {
            loading: matches!(state, rune::PlayerState::Loading),
            playing: self.0.is_playing(),
            ended: matches!(state, rune::PlayerState::Ended),
            muted: self.0.muted(),
            time: self.0.time(),
            duration: self.0.duration(),
            size: self.0.natural_size(),
            error: if let rune::PlayerState::Failed(why) = state {
                Some(why)
            } else {
                None
            },
            ..State::default()
        }
    }
    pub fn play(&self) {
        self.0.play();
    }
    pub fn pause(&self) {
        self.0.pause();
    }
    pub fn seek(&self, seconds: f64) {
        self.0.seek(seconds);
    }
    pub fn mute(&self, muted: bool) {
        self.0.set_muted(muted);
    }
    pub fn surface(&self) -> &rune::NativeSurface {
        self.0.surface()
    }
    pub fn element(&self) -> El {
        rune::el().video(&self.0, SurfaceFit::Fit)
    }
}

#[cfg(not(target_os = "linux"))]
impl Drop for Player {
    fn drop(&mut self) {
        self.0.pause();
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use rune::render::{Gpu, OFFSCREEN_FORMAT, Offscreen, Renderer};

    fn view(player: &Player, _: &mut rune::Cx<Player>) -> El {
        player.element().w(64.0).h(48.0)
    }
    fn render(gpu: &Gpu, runtime: &mut rune::Runtime<Player>) -> Vec<u8> {
        let mut renderer = Renderer::new(&gpu.device, OFFSCREEN_FORMAT);
        renderer.prepare(
            &gpu.device,
            &gpu.queue,
            &mut runtime.text.atlas,
            &runtime.instances,
            (64, 48),
        );
        renderer.prepare_surfaces(&gpu.device, &gpu.queue, &runtime.surfaces, (64, 48));
        let target = Offscreen::new(&gpu.device, 64, 48);
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        renderer.draw(&mut encoder, &target.view, [0.0; 4]);
        target.copy(&mut encoder);
        renderer.submit(&gpu.queue, encoder);
        target.read(&gpu.device)
    }

    #[test]
    fn mp4_h264_aac_uses_the_native_decoder_and_retained_file_controls() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/artefact-video.mp4");
        let player = Player::open(&path, Arc::new(|| {}));
        let mut runtime = rune::Runtime::new(player, view, (64.0, 48.0), rune::Env::new(true, 1.0));
        let gpu = Gpu::new(Gpu::instance(), None);
        runtime.frame(0.0);
        let first = render(&gpu, &mut runtime);
        assert!(!runtime.state.state().playing);
        assert_eq!(runtime.state.state().size, Some((64, 48)));
        runtime.state.seek(1.0);
        runtime.frame(0.0);
        let second = render(&gpu, &mut runtime);
        assert_ne!(first, second);
        assert!((runtime.state.state().time - 1.0).abs() < 0.05);
        runtime.state.play();
        runtime.frame(0.0);
        runtime.frame(0.25);
        assert!(runtime.state.state().time > 1.2);
        runtime.state.pause();
        let paused = runtime.state.state().time;
        runtime.frame(0.5);
        assert_eq!(runtime.state.state().time, paused);
        runtime.state.mute(false);
        assert!(!runtime.state.state().muted);
        runtime.state.play();
        runtime.frame(3.0);
        assert!(runtime.state.state().ended);
        runtime.state.play();
        runtime.frame(0.0);
        assert!(runtime.state.state().time < 0.1);
        let audio = rune::Player::audio(path);
        assert_eq!(audio.state(), rune::PlayerState::Ready);
        assert!((audio.duration().unwrap() - 2.0).abs() < 0.1);
        audio.seek(0.5);
        assert_eq!(audio.time(), 0.5);
        let missing = Player::open(Path::new("/no-such-collie-file.mp4"), Arc::new(|| {}));
        assert!(missing.state().error.is_some());
    }
}
