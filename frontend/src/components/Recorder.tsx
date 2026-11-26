"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import LiveVideo from "./LiveVideo";
import MicMeter from "./MicMeter";
import ReviewPanel, { type ReviewResult } from "./ReviewPanel";
import { Field, Section, Segmented, Toggle } from "./ui";
import { type Health, health } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import {
  type Corner,
  type FormatOption,
  type OverlayOptions,
  RecordingSession,
  describeMediaError,
  getSupportedFormats,
  isRecordingSupported,
  isScreenCaptureSupported,
} from "@/lib/recorder";
import { type Settings, useSettings } from "@/lib/settings";

type Phase = "setup" | "preparing" | "countdown" | "recording" | "paused" | "review";

const BUBBLE_SIZE = { small: 16, medium: 22, large: 30 } as const;

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
      .then((h) => setDenoiser(h.denoiser))
      .catch(() => setDenoiser({ available: false, device: null, error: "Backend not reachable" }));
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
        onSaved={() => setSaved(true)}
        onDone={resetToSetup}
      />
    );
  }

  const active = phase === "recording" || phase === "paused";
  const busy = phase !== "setup";

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      {/* Stage */}
      <div className="space-y-4">
        <Stage
          phase={phase}
          settings={settings}
          camPreview={camPreview}
          liveStream={liveStream}
          countdown={countdown}
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
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <button
                  className="btn btn-ghost"
                  onClick={() => updateOverlay({ visible: !settings.overlay.visible })}
                >
                  {settings.overlay.visible ? "Hide camera" : "Show camera"}
                </button>
                <CornerPicker value={settings.overlay.position} onChange={(position) => updateOverlay({ position })} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Settings */}
      <aside className="card h-fit space-y-5 p-5">
        <Section title="Recording mode">
          <Segmented
            value={settings.mode}
            disabled={busy}
            onChange={(mode) => update({ mode })}
            options={[
              { value: "screen", label: "Screen", disabled: !support.screen },
              { value: "camera", label: "Camera" },
              { value: "screen_camera", label: "Screen + Cam", disabled: !support.screen },
            ]}
          />
        </Section>

        <Section title="Video">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quality">
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
            </Field>
            <Field label="Frame rate">
              <Segmented
                value={settings.fps}
                disabled={busy}
                onChange={(fps) => update({ fps })}
                options={[
                  { value: 30, label: "30" },
                  { value: 60, label: "60" },
                ]}
              />
            </Field>
          </div>
          {usesScreen && (
            <Field label="Share">
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
            </Field>
          )}
          <Field label="File format">
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
          </Field>
        </Section>

        {usesCamera && (
          <Section title="Camera">
            <Field label="Device">
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
            </Field>
            {settings.mode === "screen_camera" && (
              <>
                <div className="grid grid-cols-[auto_1fr] items-end gap-3">
                  <Field label="Position">
                    <CornerPicker
                      value={settings.overlay.position}
                      onChange={(position) => updateOverlay({ position })}
                    />
                  </Field>
                  <Field label="Size">
                    <Segmented
                      value={settings.overlay.size}
                      onChange={(size) => updateOverlay({ size })}
                      options={[
                        { value: "small", label: "S" },
                        { value: "medium", label: "M" },
                        { value: "large", label: "L" },
                      ]}
                    />
                  </Field>
                </div>
                <Field label="Shape">
                  <Segmented
                    value={settings.overlay.shape}
                    onChange={(shape) => updateOverlay({ shape })}
                    options={[
                      { value: "circle", label: "Circle" },
                      { value: "rounded", label: "Rounded" },
                      { value: "square", label: "Square" },
                    ]}
                  />
                </Field>
                <Toggle
                  label="Show camera"
                  checked={settings.overlay.visible}
                  onChange={(visible) => updateOverlay({ visible })}
                />
              </>
            )}
            <Toggle
              label="Mirror camera"
              hint="Flip horizontally, like a mirror"
              checked={settings.overlay.mirror}
              disabled={busy && settings.mode === "camera"}
              onChange={(mirror) => updateOverlay({ mirror })}
            />
          </Section>
        )}

        <Section title="Audio">
          <Toggle
            label="Microphone"
            checked={settings.mic}
            disabled={busy}
            onChange={(mic) => update({ mic })}
          />
          {settings.mic && (
            <>
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
            </>
          )}
          {usesScreen && (
            <Toggle
              label="System / tab audio"
              hint='Tick "Share audio" in the browser picker. Full system audio works on Windows & ChromeOS (Chrome/Edge).'
              checked={settings.systemAudio}
              disabled={busy}
              onChange={(systemAudio) => update({ systemAudio })}
            />
          )}
        </Section>

        <Section title="AI noise removal">
          <Toggle
            label="Remove background noise (AI)"
            hint="NVIDIA NemotronLabs RE-USE cleans noise, echo and poor-mic sound on the server after the recording is saved to the library."
            checked={settings.aiDenoise}
            disabled={!denoiser?.available}
            onChange={(aiDenoise) => update({ aiDenoise })}
          />
          <p className={`text-xs ${denoiser?.available ? "text-emerald-400" : "text-amber-300/80"}`}>
            {denoiser === null
              ? "Checking AI service…"
              : denoiser.available
                ? `● AI service ready${denoiser.device ? ` on ${denoiser.device}` : ""}`
                : `○ AI service unavailable: ${denoiser.error ?? "unknown error"}`}
          </p>
        </Section>

        <Section title="Options">
          <Field label="Countdown">
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
          </Field>
          <Field label="Auto-stop after">
            <select
              className="select"
              disabled={busy}
              value={settings.autoStopMin}
              onChange={(e) => update({ autoStopMin: Number(e.target.value) })}
            >
              <option value={0}>Never</option>
              {[1, 5, 10, 15, 30, 60, 120].map((m) => (
                <option key={m} value={m}>
                  {m} minute{m > 1 ? "s" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Toggle
            label="Auto-save to library"
            hint="Upload to the server as soon as recording stops"
            checked={settings.autoUpload}
            onChange={(autoUpload) => update({ autoUpload })}
          />
        </Section>
      </aside>
    </div>
  );
}

function Stage({
  phase,
  settings,
  camPreview,
  liveStream,
  countdown,
}: {
  phase: Phase;
  settings: Settings;
  camPreview: MediaStream | null;
  liveStream: MediaStream | null;
  countdown: number;
}) {
  const o = settings.overlay;
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-black">
      {liveStream ? (
        <LiveVideo stream={liveStream} className="h-full w-full" />
      ) : settings.mode === "camera" ? (
        camPreview ? (
          <LiveVideo stream={camPreview} mirror={o.mirror} fit="cover" className="h-full w-full" />
        ) : (
          <Placeholder text="Waiting for camera…" />
        )
      ) : (
        <>
          <Placeholder
            text={phase === "preparing" ? "Choose what to share…" : "Your screen will appear here"}
            screen
          />
          {settings.mode === "screen_camera" && o.visible && camPreview && <Bubble overlay={o} stream={camPreview} />}
        </>
      )}

      {phase === "countdown" && (
        <div className="absolute inset-0 grid place-items-center bg-black/60">
          <span key={countdown} className="text-8xl font-bold text-white drop-shadow-lg">
            {countdown}
          </span>
        </div>
      )}
      {phase === "paused" && (
        <div className="absolute inset-0 grid place-items-center bg-black/50">
          <span className="rounded-full bg-black/70 px-4 py-2 text-sm font-medium">Paused</span>
        </div>
      )}
      {phase === "recording" && (
        <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs font-semibold">
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

function Bubble({ overlay: o, stream }: { overlay: OverlayOptions; stream: MediaStream }) {
  const w = BUBBLE_SIZE[o.size];
  const style: React.CSSProperties = {
    width: `${w}%`,
    aspectRatio: o.shape === "rounded" ? "4 / 3" : "1 / 1",
    borderRadius: o.shape === "circle" ? "9999px" : o.shape === "rounded" ? "8%" : "0",
    [o.position.startsWith("top") ? "top" : "bottom"]: "3%",
    [o.position.endsWith("left") ? "left" : "right"]: "1.7%",
  };
  return (
    <div className="absolute overflow-hidden border-2 border-white/90 shadow-xl" style={style}>
      <LiveVideo stream={stream} mirror={o.mirror} fit="cover" className="h-full w-full" />
    </div>
  );
}

function CornerPicker({ value, onChange }: { value: Corner; onChange: (c: Corner) => void }) {
  const corners: Corner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
  return (
    <div className="grid h-[38px] w-[60px] grid-cols-2 gap-1 rounded-lg border border-white/10 bg-[#141821] p-1">
      {corners.map((c) => (
        <button
          key={c}
          type="button"
          title={c.replace("-", " ")}
          aria-label={`Camera ${c.replace("-", " ")}`}
          onClick={() => onChange(c)}
          className={`rounded-sm ${value === c ? "bg-brand" : "bg-white/10 hover:bg-white/20"}`}
        />
      ))}
    </div>
  );
}
