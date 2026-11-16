use super::State;
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as app;
use gstreamer_video as video;
use gstreamer_video::VideoFrameExt;
use rune::NativeSurface;
use rune::native_surface::{ByteFrame, ColorInfo, Format};
use std::path::Path;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

#[derive(Default, Clone)]
struct Intent {
    playing: bool,
    muted: bool,
    seek: Option<(u64, f64)>,
}

pub struct Player {
    surface: NativeSurface,
    state: Arc<Mutex<State>>,
    intent: Arc<Mutex<Intent>>,
    stop: Arc<AtomicBool>,
}

const REQUIREMENTS: &str = "Native video requires GStreamer playback, ISO MP4 demux, H.264 and AAC decoders. Reinstall Collie Desktop's Linux bundle, or use Open/Save for this revision.";

fn frame(sample: &gst::Sample) -> Result<(ByteFrame, f64), String> {
    let caps = sample.caps().ok_or("The video frame has no format")?;
    let info = video::VideoInfo::from_caps(caps).map_err(|e| e.to_string())?;
    if info.width() > 4096 || info.height() > 4096 {
        return Err("Video exceeds the 4096 by 4096 native frame limit; use Open or Save.".into());
    }
    let buffer = sample.buffer().ok_or("The video frame has no buffer")?;
    let pts = buffer.pts().map_or(0.0, |t| t.nseconds() as f64 / 1e9);
    let mapped =
        video::VideoFrameRef::from_buffer_ref_readable(buffer, &info).map_err(|e| e.to_string())?;
    let plane = mapped.plane_data(0).map_err(|e| e.to_string())?;
    let stride = usize::try_from(mapped.plane_stride()[0])
        .map_err(|_| "The video frame has an unsupported negative stride")?;
    let width = info.width() as usize * 4;
    let mut bytes = Vec::with_capacity(width * info.height() as usize);
    for row in 0..info.height() as usize {
        bytes.extend_from_slice(
            plane
                .get(row * stride..row * stride + width)
                .ok_or("The video frame has an invalid stride")?,
        );
    }
    Ok((
        ByteFrame {
            width: info.width(),
            height: info.height(),
            format: Format::Bgra,
            color: ColorInfo::default(),
            planes: [bytes, Vec::new()],
        },
        pts,
    ))
}

fn pipeline(
    path: &Path,
    surface: NativeSurface,
    state: Arc<Mutex<State>>,
    audio: Option<&str>,
) -> Result<gst::Element, String> {
    gst::init().map_err(|e| format!("{e}. {REQUIREMENTS}"))?;
    let uri = gst::glib::filename_to_uri(path, None).map_err(|e| e.to_string())?;
    let sink = app::AppSink::builder()
        .caps(
            &gst::Caps::builder("video/x-raw")
                .field("format", "BGRA")
                .build(),
        )
        .max_buffers(1)
        .drop(true)
        .sync(true)
        .build();
    #[cfg(test)]
    let audio_state = state.clone();
    let present = move |sample: gst::Sample| -> Result<gst::FlowSuccess, gst::FlowError> {
        match frame(&sample) {
            Ok((frame, pts)) => {
                let mut state = state.lock().unwrap();
                state.frames += 1;
                state.frame_time = Some(pts);
                state.size = Some((frame.width, frame.height));
                #[cfg(test)]
                if state.decoded.len() < 32 {
                    use sha2::Digest;
                    state
                        .decoded
                        .push((pts, sha2::Sha256::digest(&frame.planes[0]).into()));
                }
                state.loading = false;
                if let Err(why) = surface.push_bytes(frame, state.frames) {
                    state.error = Some(why);
                    return Err(gst::FlowError::Error);
                }
                Ok(gst::FlowSuccess::Ok)
            }
            Err(why) => {
                state.lock().unwrap().error = Some(why);
                Err(gst::FlowError::Error)
            }
        }
    };
    let present = Arc::new(present);
    let preroll = present.clone();
    sink.set_callbacks(
        app::AppSinkCallbacks::builder()
            .new_sample(move |sink| present(sink.pull_sample().map_err(|_| gst::FlowError::Eos)?))
            .new_preroll(move |sink| preroll(sink.pull_preroll().map_err(|_| gst::FlowError::Eos)?))
            .build(),
    );
    let player = gst::ElementFactory::make("playbin")
        .property("uri", uri.as_str())
        .property("video-sink", &sink)
        .build()
        .map_err(|e| format!("{e}. {REQUIREMENTS}"))?;
    if let Some(audio) = audio {
        let sink = gst::ElementFactory::make(audio)
            .property("sync", true)
            .build()
            .map_err(|e| e.to_string())?;
        #[cfg(test)]
        if audio == "fakesink" {
            sink.set_property("signal-handoffs", true);
            sink.connect("handoff", false, move |_| {
                audio_state.lock().unwrap().audio_buffers += 1;
                None
            });
        }
        player.set_property("audio-sink", sink);
    }
    Ok(player)
}

impl Player {
    pub fn open(path: &Path, notify: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self::open_with_audio(path, notify, None)
    }

    fn open_with_audio(
        path: &Path,
        notify: Arc<dyn Fn() + Send + Sync>,
        audio: Option<&'static str>,
    ) -> Self {
        let player = Self {
            surface: NativeSurface::new(),
            state: Arc::new(Mutex::new(State {
                loading: true,
                ..State::default()
            })),
            intent: Arc::default(),
            stop: Arc::default(),
        };
        let (surface, state, intent, stop) = (
            player.surface.clone(),
            player.state.clone(),
            player.intent.clone(),
            player.stop.clone(),
        );
        let path = path.to_path_buf();
        std::thread::spawn(move || {
            let result = (|| -> Result<(), String> {
                let player = pipeline(&path, surface, state.clone(), audio)?;
                let bus = player.bus().ok_or("The native player has no event bus")?;
                let run = (|| -> Result<(), String> {
                    player
                        .set_state(gst::State::Paused)
                        .map_err(|e| format!("{e}. {REQUIREMENTS}"))?;
                    let mut previous = Intent::default();
                    let mut reported = State::default();
                    while !stop.load(Ordering::Acquire) {
                        let wanted = intent.lock().unwrap().clone();
                        if wanted.muted != previous.muted {
                            player.set_property("mute", wanted.muted);
                        }
                        if wanted.seek != previous.seek
                            && let Some((_, seconds)) = wanted.seek
                        {
                            player
                                .seek_simple(
                                    gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE,
                                    gst::ClockTime::from_nseconds((seconds * 1e9) as u64),
                                )
                                .map_err(|e| e.to_string())?;
                            state.lock().unwrap().ended = false;
                        }
                        if wanted.playing != previous.playing || wanted.seek != previous.seek {
                            player
                                .set_state(if wanted.playing {
                                    gst::State::Playing
                                } else {
                                    gst::State::Paused
                                })
                                .map_err(|e| e.to_string())?;
                        }
                        previous = wanted.clone();
                        if let Some(message) = bus.timed_pop(gst::ClockTime::from_mseconds(20)) {
                            match message.view() {
                                gst::MessageView::Error(error) => {
                                    return Err(format!("{}. {REQUIREMENTS}", error.error()));
                                }
                                gst::MessageView::Eos(_) => {
                                    let mut state = state.lock().unwrap();
                                    state.ended = true;
                                    state.playing = false;
                                }
                                _ => {}
                            }
                        }
                        let mut state = state.lock().unwrap();
                        state.time = player
                            .query_position::<gst::ClockTime>()
                            .map_or(state.time, |time| time.nseconds() as f64 / 1e9);
                        state.duration = player
                            .query_duration::<gst::ClockTime>()
                            .map(|time| time.nseconds() as f64 / 1e9);
                        state.audio_streams = player.property::<i32>("n-audio");
                        state.playing = wanted.playing && !state.ended && !state.loading;
                        state.muted = wanted.muted;
                        if *state != reported {
                            reported = state.clone();
                            drop(state);
                            notify();
                        }
                    }
                    Ok(())
                })();
                let _ = player.set_state(gst::State::Null);
                run
            })();
            if let Err(why) = result {
                let mut state = state.lock().unwrap();
                state.loading = false;
                state.playing = false;
                state.error = Some(why);
                drop(state);
                notify();
            }
        });
        player
    }
    pub fn state(&self) -> State {
        self.state.lock().unwrap().clone()
    }
    pub fn play(&self) {
        if self.state().ended {
            self.seek(0.0);
        }
        self.intent.lock().unwrap().playing = true;
    }
    pub fn pause(&self) {
        self.intent.lock().unwrap().playing = false;
    }
    pub fn seek(&self, seconds: f64) {
        if !seconds.is_finite() {
            return;
        }
        let seconds = seconds
            .max(0.0)
            .min(self.state().duration.unwrap_or(seconds.max(0.0)));
        let mut intent = self.intent.lock().unwrap();
        intent.seek = Some((intent.seek.map_or(1, |(n, _)| n + 1), seconds));
    }
    pub fn mute(&self, muted: bool) {
        self.intent.lock().unwrap().muted = muted;
    }
    pub fn surface(&self) -> &NativeSurface {
        &self.surface
    }
    pub fn element(&self) -> rune::El {
        rune::el().native_surface(&self.surface, rune::SurfaceFit::Fit)
    }
}
impl Drop for Player {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.surface.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{Receiver, channel};
    use std::time::{Duration, Instant};

    fn wait(player: &Player, changed: &Receiver<()>, wanted: impl Fn(&State) -> bool) -> State {
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            let state = player.state();
            assert!(state.error.is_none(), "{state:?}");
            if wanted(&state) {
                return state;
            }
            let left = until.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "decoder timed out: {state:?}");
            changed.recv_timeout(left).expect("decoder state changed");
        }
    }

    #[test]
    fn mp4_h264_aac_decodes_distinct_frames_and_controls_its_retained_file() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/artefact-video.mp4");
        let (sent, changed) = channel();
        let player = Player::open_with_audio(
            &path,
            Arc::new(move || {
                let _ = sent.send(());
            }),
            Some("fakesink"),
        );
        let first = wait(&player, &changed, |s| {
            s.frames > 0 && s.audio_streams == 1 && s.duration.is_some()
        });
        assert!(!first.playing);
        assert_eq!(first.size, Some((64, 48)));
        assert!((first.duration.unwrap() - 2.0).abs() < 0.1);
        player.seek(1.0);
        let sought = wait(&player, &changed, |s| {
            s.frame_time.is_some_and(|t| t >= 0.99)
        });
        assert!(!sought.playing);
        assert_ne!(first.decoded[0].1, sought.decoded.last().unwrap().1);
        assert!(sought.decoded.last().unwrap().0 > first.decoded[0].0);
        player.play();
        wait(&player, &changed, |s| {
            s.playing && s.time > 1.2 && s.audio_buffers > 0
        });
        player.pause();
        let paused = wait(&player, &changed, |s| !s.playing);
        let _ = changed.recv_timeout(Duration::from_millis(150));
        assert!((player.state().time - paused.time).abs() < 0.03);
        player.mute(true);
        wait(&player, &changed, |s| s.muted);
        player.play();
        wait(&player, &changed, |s| s.ended);
        player.play();
        wait(&player, &changed, |s| s.playing && s.time < 0.5);
        let released = Arc::downgrade(&player.state);
        drop(player);
        let deadline = Instant::now() + Duration::from_secs(10);
        while released.upgrade().is_some() {
            assert!(
                Instant::now() < deadline,
                "the decoder and audio sink were not released"
            );
            let _ = changed.recv_timeout(Duration::from_millis(10));
        }
    }

    #[test]
    fn a_missing_video_reports_a_decoder_failure_instead_of_playing() {
        let (sent, changed) = channel();
        let player = Player::open(
            Path::new("/no-such-collie-file.mp4"),
            Arc::new(move || {
                let _ = sent.send(());
            }),
        );
        changed.recv_timeout(Duration::from_secs(10)).unwrap();
        let failed = player.state();
        assert!(
            failed
                .error
                .as_ref()
                .is_some_and(|why| why.contains("GStreamer"))
        );
        assert!(!failed.playing);
        assert_eq!(failed.frames, 0);
    }

    #[test]
    fn missing_plugins_are_actionable() {
        if std::env::var_os("COLLIE_TEST_EMPTY_MEDIA_RUNTIME").is_some() {
            let (sent, changed) = channel();
            let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/artefact-video.mp4");
            let player = Player::open(
                &path,
                Arc::new(move || {
                    let _ = sent.send(());
                }),
            );
            changed.recv_timeout(Duration::from_secs(10)).unwrap();
            let failed = player.state();
            assert!(
                failed
                    .error
                    .as_ref()
                    .is_some_and(|why| why.contains("Reinstall Collie Desktop")),
                "{failed:?}"
            );
            assert_eq!(failed.frames, 0);
            return;
        }
        let dir = std::env::temp_dir().join(format!("collie-empty-codecs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "video::linux::tests::missing_plugins_are_actionable",
                "--nocapture",
            ])
            .env("COLLIE_TEST_EMPTY_MEDIA_RUNTIME", "1")
            .env("GST_PLUGIN_SYSTEM_PATH_1_0", "")
            .env("GST_PLUGIN_PATH_1_0", "")
            .env("GST_REGISTRY_1_0", dir.join("registry.bin"))
            .status();
        std::fs::remove_dir_all(dir).unwrap();
        assert!(result.unwrap().success());
    }
}
