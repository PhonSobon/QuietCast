"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import LiveVideo from "./LiveVideo";
import MicMeter from "./MicMeter";
import ReviewPanel, { type ReviewResult } from "./ReviewPanel";
import { Row, Segmented, Tabs, Toggle } from "./ui";
import { type Health, health } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import {
  type FormatOption,
  type Mode,
  OVERLAY_SIZE,
  type OverlayOptions,
  RecordingSession,
  overlayAspect,
  describeMediaError,
  getSupportedFormats,
  isRecordingSupported,
  isScreenCaptureSupported,
} from "@/lib/recorder";
import { type Settings, useSettings } from "@/lib/settings";

type Phase = "setup" | "preparing" | "countdown" | "recording" | "paused" | "review";

type Tab = "video" | "camera" | "audio" | "more";

export default function Recorder() {
  const { settings, update, updateOverlay } = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [phase, setPhase] = useState<Phase>("setup");
  const [error, setError] = useState<string | null>(null);
  const [formats, setFormats] = useState<FormatOption[]>([]);
  const [support, setSupport] = useState({ recording: true, screen: true });
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [camPreview, setCamPreview] = useState<MediaStream | null>(null);
  const [micPreview, setMicPreview] = useState<MediaStream | null>(null);
  const [liveStream, setLiveStream] = useState<MediaStream | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [saved, setSaved] = useState(false);
  const [denoiser, setDenoiser] = useState<Health["denoiser"] | null>(null);
  const [transcriber, setTranscriber] = useState<Health["transcriber"] | null>(null);
  const [liveAspect, setLiveAspect] = useState(16 / 9);
  const [tab, setTab] = useState<Tab>("video");

  const sessionRef = useRef<RecordingSession | null>(null);
  const finishingRef = useRef(false);

  const usesScreen = settings.mode !== "camera";
  const usesCamera = settings.mode !== "screen";

  // ---- capability detection (client only) ----
  useEffect(() => {
    setFormats(getSupportedFormats());
    const screen = isScreenCaptureSupported();
    setSupport({ recording: isRecordingSupported(), screen });
    if (!screen && settingsRef.current.mode !== "camera") update({ mode: "camera" });
  }, [update]);

  // Is the AI noise-removal (RE-USE) service available on the backend?
  useEffect(() => {
    health()
      .then((h) => {
        setDenoiser(h.denoiser);
        setTranscriber(h.transcriber);
      })
      .catch(() => {
        setDenoiser({ available: false, device: null, error: "Backend not reachable" });
        setTranscriber({ available: false, languages: null, error: "Backend not reachable" });
      });
  }, []);

  // Fall back to an available container if the saved one isn't supported
  useEffect(() => {
    if (formats.length && !formats.some((f) => f.id === settings.format)) {
      update({ format: formats[0].id });
    }
  }, [formats, settings.format, update]);

  // ---- devices ----
  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const list = await navigator.mediaDevices.enumerateDevices();
    setCams(list.filter((d) => d.kind === "videoinput" && d.deviceId));
    setMics(list.filter((d) => d.kind === "audioinput" && d.deviceId));
  }, []);

  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices?.addEventListener("devicechange", refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", refreshDevices);
  }, [refreshDevices]);

  // ---- setup previews (camera + mic level) ----
  useEffect(() => {
    if (phase !== "setup" || !usesCamera || !support.recording) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    const id = settings.cameraDeviceId;
    navigator.mediaDevices
      .getUserMedia({
        video: { deviceId: id ? { exact: id } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        setCamPreview(s);
        refreshDevices();
      })
      .catch((e) => {
        if (cancelled) return;
        if (id && (e as DOMException).name === "OverconstrainedError") update({ cameraDeviceId: "" });
        else setError(`Camera: ${describeMediaError(e)}`);
      });
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      setCamPreview(null);
    };
  }, [phase, usesCamera, settings.cameraDeviceId, support.recording, refreshDevices, update]);

  useEffect(() => {
    if (phase !== "setup" || !settings.mic || !support.recording) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    const id = settings.micDeviceId;
    navigator.mediaDevices
      .getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined } })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        setMicPreview(s);
        refreshDevices();
      })
      .catch((e) => {
        if (cancelled) return;
        if (id && (e as DOMException).name === "OverconstrainedError") update({ micDeviceId: "" });
        else setError(`Microphone: ${describeMediaError(e)}`);
      });
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      setMicPreview(null);
    };
  }, [phase, settings.mic, settings.micDeviceId, support.recording, refreshDevices, update]);

  // ---- recording flow ----
  const finish = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || finishingRef.current) return;
    finishingRef.current = true;
    try {
      if (s.state === "idle") {
        // stopped before recording began (e.g. during countdown)
        s.cancel();
        setPhase("setup");
        return;
      }
      const r = await s.stop();
      setResult({ ...r, url: URL.createObjectURL(r.blob), mode: settingsRef.current.mode });
      setSaved(false);
      setPhase("review");
    } catch (e) {
      setError(describeMediaError(e));
      setPhase("setup");
    } finally {
      sessionRef.current = null;
      finishingRef.current = false;
      setLiveStream(null);
    }
  }, []);

  const begin = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    try {
      s.start();
      setElapsedMs(0);
      setPhase("recording");
    } catch (e) {
      s.cancel();
      sessionRef.current = null;
      setLiveStream(null);
      setError(describeMediaError(e));
      setPhase("setup");
    }
  }, []);

  const startRecording = async () => {
    setError(null);
    const st = settingsRef.current;
    const fmt = formats.find((f) => f.id === st.format) ?? formats[0];
    setPhase("preparing"); // releases the setup previews
    const session = new RecordingSession({
      mode: st.mode,
      resolution: st.resolution,
      fps: st.fps,
      displaySurface: st.displaySurface,
      mic: st.mic,
      micDeviceId: st.micDeviceId || undefined,
      noiseSuppression: st.noiseSuppression,
      systemAudio: st.systemAudio && st.mode !== "camera",
      cameraDeviceId: st.cameraDeviceId || undefined,
      mimeType: fmt?.mimeType ?? "",
      overlay: st.overlay,
    });
    sessionRef.current = session;
    session.onSourceEnded = () => void finish();
    try {
      const out = await session.prepare();
      setLiveAspect(session.width && session.height ? session.width / session.height : 16 / 9);
      setLiveStream(out);
    } catch (e) {
      sessionRef.current = null;
      setError(describeMediaError(e));
      setPhase("setup");
      return;
    }
    if (st.countdown > 0) {
      setCountdown(st.countdown);
      setPhase("countdown");
    } else {
      begin();
    }
  };

  // countdown ticks
  useEffect(() => {
    if (phase !== "countdown") return;
    if (countdown <= 0) {
      begin();
      return;
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, countdown, begin]);

  // elapsed timer + auto-stop
  useEffect(() => {
    if (phase !== "recording" && phase !== "paused") return;
    const id = setInterval(() => {
      const s = sessionRef.current;
      if (!s) return;
      const ms = s.elapsedMs();
      setElapsedMs(ms);
      const limit = settingsRef.current.autoStopMin;
      if (limit > 0 && ms >= limit * 60_000) void finish();
    }, 250);
    return () => clearInterval(id);
  }, [phase, finish]);

  // live overlay changes while recording
  useEffect(() => {
    sessionRef.current?.updateOverlay(settings.overlay);
  }, [settings.overlay]);

  // tab title shows the timer (handy when recording another window)
  useEffect(() => {
    const base = "QuietCast";
    if (phase === "recording") document.title = `● ${formatDuration(elapsedMs / 1000)} Recording`;
    else if (phase === "paused") document.title = `❚❚ ${formatDuration(elapsedMs / 1000)} Paused`;
    else document.title = base;
    return () => {
      document.title = base;
    };
  }, [phase, elapsedMs]);

  // warn before leaving with an active or unsaved recording
  useEffect(() => {
    const busy = ["preparing", "countdown", "recording", "paused"].includes(phase) || (phase === "review" && !saved);
    if (!busy) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [phase, saved]);

  // cleanup on unmount
  useEffect(() => () => sessionRef.current?.cancel(), []);

  const togglePause = () => {
    const s = sessionRef.current;
    if (!s) return;
    if (phase === "recording") {
      s.pause();
      setPhase("paused");
    } else if (phase === "paused") {
      s.resume();
      setPhase("recording");
    }
  };

  const resetToSetup = () => {
    if (result) URL.revokeObjectURL(result.url);
    setResult(null);
    setPhase("setup");
  };

  // ---- render ----
  if (!support.recording) {
    return (
      <div className="card p-8 text-center">
        <h2 className="text-lg font-semibold">Recording isn&apos;t supported in this browser</h2>
        <p className="mt-2 text-sm text-gray-400">
          Please use a recent version of Chrome, Edge, Firefox or Safari on a desktop computer, and make sure the page is
          served from <code>localhost</code> or over HTTPS.
        </p>
      </div>
    );
  }

  if (phase === "review" && result) {
    return (
      <ReviewPanel
        result={result}
        autoUpload={settings.autoUpload}
        aiDenoise={settings.aiDenoise && !!denoiser?.available}
        denoiserAvailable={!!denoiser?.available}
        autoTranscribe={settings.autoTranscribe && !!transcriber?.available}
        transcriberAvailable={!!transcriber?.available}
        onSaved={() => setSaved(true)}
        onDone={resetToSetup}
      />
    );
  }

  const active = phase === "recording" || phase === "paused";
  const busy = phase !== "setup";
  const currentTab: Tab = tab === "camera" && !usesCamera ? "video" : tab;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
      {/* Left: mode, preview, controls */}
      <div className="min-w-0 space-y-4">
        <ModePicker
          value={settings.mode}
          disabled={busy}
          screenSupported={support.screen}
          onChange={(mode) => update({ mode })}
        />

        <Stage
          phase={phase}
          settings={settings}
          camPreview={camPreview}
          liveStream={liveStream}
          aspect={liveStream ? liveAspect : 16 / 9}
          countdown={countdown}
          onMoveCamera={(x, y) => updateOverlay({ x, y })}
        />

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {phase === "setup" && (
          <div className="flex flex-wrap items-center gap-3">
            <button
              className="btn btn-primary px-6 py-3 text-base"
              onClick={startRecording}
              disabled={!formats.length}
            >
              <span className="h-3 w-3 rounded-full bg-white" />
              Start recording
            </button>
            <p className="text-sm text-gray-400">
              {usesScreen
                ? "You'll be asked to choose a screen, window or tab to share."
                : "Recording from your camera."}
            </p>
          </div>
        )}

        {phase === "preparing" && <p className="text-sm text-gray-400">Waiting for permission…</p>}

        {phase === "countdown" && (
          <div className="flex items-center gap-3">
            <button className="btn btn-secondary" onClick={() => void finish()}>
              Cancel
            </button>
            <p className="text-sm text-gray-400">Recording starts in {countdown}…</p>
          </div>
        )}

        {active && (
          <div className="card flex flex-wrap items-center gap-3 p-3">
            <div className="flex items-center gap-2 px-2 font-mono text-lg tabular-nums">
              <span
                className={`h-3 w-3 rounded-full ${phase === "recording" ? "animate-pulse bg-brand" : "bg-yellow-400"}`}
              />
              {formatDuration(elapsedMs / 1000)}
              {settings.autoStopMin > 0 && (
                <span className="text-xs text-gray-500">/ {formatDuration(settings.autoStopMin * 60)}</span>
              )}
            </div>
            <button className="btn btn-secondary" onClick={togglePause}>
              {phase === "paused" ? "▶ Resume" : "❚❚ Pause"}
            </button>
            <button className="btn btn-primary" onClick={() => void finish()}>
              ■ Stop
            </button>
            {settings.mode === "screen_camera" && (
              <button
                className="btn btn-ghost ml-auto"
                onClick={() => updateOverlay({ visible: !settings.overlay.visible })}
              >
                {settings.overlay.visible ? "Hide camera" : "Show camera"}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Right: compact tabbed settings */}
      <aside className="card h-fit overflow-hidden">
        <Tabs
          value={currentTab}
          onChange={setTab}
          tabs={[
            { id: "video", label: "Video" },
            ...(usesCamera ? [{ id: "camera" as Tab, label: "Camera" }] : []),
            {
              id: "audio",
              label: "Audio",
              badge: (settings.aiDenoise && !!denoiser?.available) || (settings.autoTranscribe && !!transcriber?.available),
            },
            { id: "more", label: "More" },
          ]}
        />

        <div className="space-y-3.5 p-4">
          {currentTab === "video" && (
            <>
              <Row label="Quality">
                <select
                  className="select"
                  disabled={busy}
                  value={settings.resolution}
                  onChange={(e) => update({ resolution: e.target.value as Settings["resolution"] })}
                >
                  <option value="720p">720p HD</option>
                  <option value="1080p">1080p Full HD</option>
                  <option value="1440p">1440p 2K</option>
                </select>
              </Row>
              <Row label="Frame rate">
                <Segmented
                  value={settings.fps}
                  disabled={busy}
                  onChange={(fps) => update({ fps })}
                  options={[
                    { value: 30, label: "30 fps" },
                    { value: 60, label: "60 fps" },
                  ]}
                />
              </Row>
              {usesScreen && (
                <Row label="Share">
                  <select
                    className="select"
                    disabled={busy}
                    value={settings.displaySurface}
                    onChange={(e) => update({ displaySurface: e.target.value as Settings["displaySurface"] })}
                  >
                    <option value="any">Let me choose</option>
                    <option value="monitor">Entire screen</option>
                    <option value="window">A window</option>
                    <option value="browser">A browser tab</option>
                  </select>
                </Row>
              )}
              <Row label="Format">
                <select
                  className="select"
                  disabled={busy || formats.length < 2}
                  value={settings.format}
                  onChange={(e) => update({ format: e.target.value as Settings["format"] })}
                >
                  {formats.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </Row>
            </>
          )}

          {currentTab === "camera" && usesCamera && (
            <>
              <Row label="Device">
                <select
                  className="select"
                  disabled={busy}
                  value={settings.cameraDeviceId}
                  onChange={(e) => update({ cameraDeviceId: e.target.value })}
                >
                  <option value="">Default camera</option>
                  {cams.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Camera ${i + 1}`}
                    </option>
                  ))}
                </select>
              </Row>
              {settings.mode === "screen_camera" && (
                <>
                  <Row label="Size">
                    <Segmented
                      value={settings.overlay.size}
                      onChange={(size) => updateOverlay({ size })}
                      options={[
                        { value: "small", label: "S" },
                        { value: "medium", label: "M" },
                        { value: "large", label: "L" },
                      ]}
                    />
                  </Row>
                  <Row label="Shape">
                    <Segmented
                      value={settings.overlay.shape}
                      onChange={(shape) => updateOverlay({ shape })}
                      options={[
                        { value: "circle", label: "Circle" },
                        { value: "rounded", label: "Round" },
                        { value: "square", label: "Square" },
                      ]}
                    />
                  </Row>
                  <Toggle
                    label="Show camera"
                    checked={settings.overlay.visible}
                    onChange={(visible) => updateOverlay({ visible })}
                  />
                </>
              )}
              <Toggle
                label="Mirror"
                checked={settings.overlay.mirror}
                disabled={busy && settings.mode === "camera"}
                onChange={(mirror) => updateOverlay({ mirror })}
              />
              {settings.mode === "screen_camera" && (
                <p className="rounded-lg bg-white/[0.04] px-3 py-2 text-xs text-gray-400">
                  ✋ Drag the camera on the preview to place it anywhere, even while recording.
                </p>
              )}
            </>
          )}

          {currentTab === "audio" && (
            <>
              <Toggle label="Microphone" checked={settings.mic} disabled={busy} onChange={(mic) => update({ mic })} />
              {settings.mic && (
                <div className="space-y-2">
                  <select
                    className="select"
                    disabled={busy}
                    value={settings.micDeviceId}
                    onChange={(e) => update({ micDeviceId: e.target.value })}
                  >
                    <option value="">Default microphone</option>
                    {mics.map((d, i) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Microphone ${i + 1}`}
                      </option>
                    ))}
                  </select>
                  {phase === "setup" && <MicMeter stream={micPreview} />}
                  <Toggle
                    label="Noise suppression"
                    checked={settings.noiseSuppression}
                    disabled={busy}
                    onChange={(noiseSuppression) => update({ noiseSuppression })}
                  />
                </div>
              )}
              {usesScreen && (
                <Toggle
                  label="System / tab audio"
                  hint='Tick "Share audio" in the browser picker.'
                  checked={settings.systemAudio}
                  disabled={busy}
                  onChange={(systemAudio) => update({ systemAudio })}
                />
              )}
              <div className="space-y-1.5 border-t border-white/10 pt-3">
                <Toggle
                  label="✨ AI noise removal"
                  hint="NVIDIA RE-USE cleans the sound after saving."
                  checked={settings.aiDenoise}
                  disabled={!denoiser?.available}
                  onChange={(aiDenoise) => update({ aiDenoise })}
                />
                <p className={`text-xs ${denoiser?.available ? "text-emerald-400" : "text-amber-300/80"}`}>
                  {denoiser === null
                    ? "Checking AI service…"
                    : denoiser.available
                      ? `● Ready${denoiser.device ? ` on ${denoiser.device}` : ""}`
                      : `○ Unavailable: ${denoiser.error ?? "unknown error"}`}
                </p>
              </div>
              <div className="space-y-1.5 border-t border-white/10 pt-3">
                <Toggle
                  label="📝 Subtitles (speech to text)"
                  hint="Khmer, English or both. Made after saving; searchable in the library."
                  checked={settings.autoTranscribe}
                  disabled={!transcriber?.available}
                  onChange={(autoTranscribe) => update({ autoTranscribe })}
                />
                <p className={`text-xs ${transcriber?.available ? "text-emerald-400" : "text-amber-300/80"}`}>
                  {transcriber === null
                    ? "Checking speech-to-text service…"
                    : transcriber.available
                      ? "● Ready (Sota ASR, Khmer + English)"
                      : `○ Unavailable: ${transcriber.error ?? "unknown error"}`}
                </p>
              </div>
            </>
          )}

          {currentTab === "more" && (
            <>
              <Row label="Countdown">
                <Segmented
                  value={settings.countdown}
                  disabled={busy}
                  onChange={(countdown) => update({ countdown })}
                  options={[
                    { value: 0, label: "Off" },
                    { value: 3, label: "3s" },
                    { value: 5, label: "5s" },
                    { value: 10, label: "10s" },
                  ]}
                />
              </Row>
              <Row label="Auto-stop">
                <select
                  className="select"
                  disabled={busy}
                  value={settings.autoStopMin}
                  onChange={(e) => update({ autoStopMin: Number(e.target.value) })}
                >
                  <option value={0}>Never</option>
                  {[1, 5, 10, 15, 30, 60, 120].map((m) => (
                    <option key={m} value={m}>
                      After {m} min
                    </option>
                  ))}
                </select>
              </Row>
              <Toggle
                label="Auto-save to library"
                hint="Upload as soon as recording stops"
                checked={settings.autoUpload}
                onChange={(autoUpload) => update({ autoUpload })}
              />
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------ mode picker

const MODES: { value: Mode; label: string; icon: React.ReactNode }[] = [
  {
    value: "screen",
    label: "Screen",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </svg>
    ),
  },
  {
    value: "screen_camera",
    label: "Screen + Cam",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
        <circle cx="16.5" cy="11.5" r="2.5" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    value: "camera",
    label: "Camera",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3" y="6" width="13" height="12" rx="2" />
        <path d="M16 10l5-3v10l-5-3z" />
      </svg>
    ),
  },
];

function ModePicker({
  value,
  disabled,
  screenSupported,
  onChange,
}: {
  value: Mode;
  disabled: boolean;
  screenSupported: boolean;
  onChange: (m: Mode) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Recording mode" className="grid grid-cols-3 gap-2">
      {MODES.map((m) => {
        const selected = m.value === value;
        const off = disabled || (m.value !== "camera" && !screenSupported);
        return (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={off && !selected}
            onClick={() => onChange(m.value)}
            className={`flex flex-col items-center justify-center gap-1 rounded-xl border px-2 py-2 text-xs font-medium transition sm:flex-row sm:gap-2 sm:px-3 sm:py-2.5 sm:text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
              selected
                ? "border-brand bg-brand/10 text-white"
                : "border-white/10 bg-white/[0.03] text-gray-400 hover:border-white/25 hover:text-gray-200"
            }`}
          >
            {m.icon}
            <span className="truncate">{m.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ stage

function Stage({
  phase,
  settings,
  camPreview,
  liveStream,
  aspect,
  countdown,
  onMoveCamera,
}: {
  phase: Phase;
  settings: Settings;
  camPreview: MediaStream | null;
  liveStream: MediaStream | null;
  aspect: number;
  countdown: number;
  onMoveCamera: (x: number, y: number) => void;
}) {
  const o = settings.overlay;
  const showBubble = settings.mode === "screen_camera" && o.visible && phase !== "review";
  return (
    <div
      className="relative mx-auto w-full overflow-hidden rounded-2xl border border-white/10 bg-black"
      style={{ aspectRatio: String(aspect), maxWidth: `calc(70vh * ${aspect})` }}
    >
      {liveStream ? (
        // The camera is already drawn into the live stream; the bubble below is an invisible drag handle.
        <LiveVideo stream={liveStream} className="h-full w-full" />
      ) : settings.mode === "camera" ? (
        camPreview ? (
          <LiveVideo stream={camPreview} mirror={o.mirror} fit="cover" className="h-full w-full" />
        ) : (
          <Placeholder text="Waiting for camera…" />
        )
      ) : (
        <Placeholder text={phase === "preparing" ? "Choose what to share…" : "Your screen will appear here"} screen />
      )}

      {showBubble && (liveStream || camPreview) && (
        <CameraBubble overlay={o} stream={liveStream ? null : camPreview} onMove={onMoveCamera} />
      )}

      {phase === "countdown" && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/60">
          <span key={countdown} className="text-8xl font-bold text-white drop-shadow-lg">
            {countdown}
          </span>
        </div>
      )}
      {phase === "paused" && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/50">
          <span className="rounded-full bg-black/70 px-4 py-2 text-sm font-medium">Paused</span>
        </div>
      )}
      {phase === "recording" && (
        <span className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs font-semibold">
          <span className="h-2 w-2 animate-pulse rounded-full bg-brand" /> REC
        </span>
      )}
    </div>
  );
}

function Placeholder({ text, screen }: { text: string; screen?: boolean }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-gradient-to-br from-[#151a24] to-[#0b0d12]">
      <div className="text-center text-gray-500">
        <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-xl border border-white/10 text-2xl">
          {screen ? "🖥️" : "📷"}
        </div>
        <p className="text-sm">{text}</p>
      </div>
    </div>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Camera bubble that can be dragged anywhere on the stage.
 * - Setup: shows the camera preview.
 * - Recording: the camera is already composited into the video, so this is a transparent
 *   handle at exactly the same spot (same maths as the canvas compositor).
 */
function CameraBubble({
  overlay: o,
  stream,
  onMove,
}: {
  overlay: OverlayOptions;
  stream: MediaStream | null;
  onMove: (x: number, y: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const grab = useRef<{ dx: number; dy: number } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);

  // track the stage size so the bubble is clamped exactly like the recorded frame
  useEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver(([entry]) =>
      setBox({ w: entry.contentRect.width, h: entry.contentRect.height }),
    );
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  const bw = box.w * OVERLAY_SIZE[o.size];
  const bh = bw / overlayAspect(o.shape);
  const left = clamp(o.x * box.w - bw / 2, 0, box.w - bw);
  const top = clamp(o.y * box.h - bh / 2, 0, box.h - bh);

  const moveTo = (clientX: number, clientY: number) => {
    const parent = ref.current?.parentElement;
    if (!parent || !grab.current) return;
    const r = parent.getBoundingClientRect();
    const cx = clamp(clientX - r.left - grab.current.dx, bw / 2, r.width - bw / 2);
    const cy = clamp(clientY - r.top - grab.current.dy, bh / 2, r.height - bh / 2);
    onMove(cx / r.width, cy / r.height);
  };

  const live = !stream;
  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Camera position. Drag to move."
      title="Drag to move the camera"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const b = e.currentTarget.getBoundingClientRect();
        grab.current = { dx: e.clientX - (b.left + b.width / 2), dy: e.clientY - (b.top + b.height / 2) };
        setDragging(true);
      }}
      onPointerMove={(e) => moveTo(e.clientX, e.clientY)}
      onPointerUp={() => {
        grab.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        grab.current = null;
        setDragging(false);
      }}
      className={`group absolute touch-none select-none overflow-hidden ${dragging ? "cursor-grabbing" : "cursor-grab"} ${
        live
          ? `border-2 border-dashed ${dragging ? "border-white/80" : "border-transparent hover:border-white/60"}`
          : `border-2 border-white/90 shadow-xl ${dragging ? "ring-4 ring-brand/50" : ""}`
      }`}
      style={{
        width: bw || `${OVERLAY_SIZE[o.size] * 100}%`,
        height: bh || undefined,
        aspectRatio: box.w ? undefined : String(overlayAspect(o.shape)),
        left,
        top,
        borderRadius: o.shape === "circle" ? "9999px" : o.shape === "rounded" ? "8%" : "0",
        visibility: box.w ? "visible" : "hidden",
      }}
    >
      {stream && <LiveVideo stream={stream} mirror={o.mirror} fit="cover" className="pointer-events-none h-full w-full" />}
      <span
        className={`pointer-events-none absolute inset-x-0 bottom-1 mx-auto w-fit rounded-full bg-black/70 px-2 py-0.5 text-[10px] text-white transition ${
          dragging ? "opacity-0" : "opacity-0 group-hover:opacity-100"
        }`}
      >
        ✋ Drag
      </span>
    </div>
  );
}
