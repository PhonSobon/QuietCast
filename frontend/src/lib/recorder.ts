/**
 * Browser recording engine.
 *
 * - Screen: navigator.mediaDevices.getDisplayMedia
 * - Camera / microphone: navigator.mediaDevices.getUserMedia
 * - Screen + camera: both are drawn onto a <canvas> (camera as a bubble in a corner)
 *   and the canvas is captured as the output video track.
 * - Microphone + system audio are mixed with the Web Audio API.
 * - Encoding: MediaRecorder.
 */

export type Mode = "screen" | "camera" | "screen_camera";
export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type Resolution = "720p" | "1080p" | "1440p";
export type DisplaySurface = "any" | "monitor" | "window" | "browser";

export interface OverlayOptions {
  visible: boolean;
  position: Corner;
  size: "small" | "medium" | "large";
  shape: "circle" | "rounded" | "square";
  mirror: boolean;
}

export interface RecorderOptions {
  mode: Mode;
  resolution: Resolution;
  fps: number;
  displaySurface: DisplaySurface;
  mic: boolean;
  micDeviceId?: string;
  noiseSuppression: boolean;
  systemAudio: boolean;
  cameraDeviceId?: string;
  mimeType: string;
  overlay: OverlayOptions;
}

export interface RecordingResult {
  blob: Blob;
  durationSec: number;
  width: number;
  height: number;
  mimeType: string;
}

export const RESOLUTIONS: Record<Resolution, { w: number; h: number; bitrate: number }> = {
  "720p": { w: 1280, h: 720, bitrate: 5_000_000 },
  "1080p": { w: 1920, h: 1080, bitrate: 8_000_000 },
  "1440p": { w: 2560, h: 1440, bitrate: 14_000_000 },
};

const OVERLAY_SIZE = { small: 0.16, medium: 0.22, large: 0.3 } as const;

export interface FormatOption {
  id: "webm" | "mp4";
  label: string;
  mimeType: string;
}

/** Container/codec combinations the current browser can record. */
export function getSupportedFormats(): FormatOption[] {
  if (typeof MediaRecorder === "undefined") return [];
  const candidates: FormatOption[] = [
    { id: "webm", label: "WebM (VP9)", mimeType: "video/webm;codecs=vp9,opus" },
    { id: "webm", label: "WebM (VP8)", mimeType: "video/webm;codecs=vp8,opus" },
    { id: "webm", label: "WebM", mimeType: "video/webm" },
    { id: "mp4", label: "MP4 (H.264)", mimeType: "video/mp4;codecs=avc1,mp4a.40.2" },
    { id: "mp4", label: "MP4", mimeType: "video/mp4" },
  ];
  const out: FormatOption[] = [];
  for (const c of candidates) {
    // keep only the best option per container
    if (out.some((o) => o.id === c.id)) continue;
    if (MediaRecorder.isTypeSupported(c.mimeType)) out.push(c);
  }
  return out;
}

export function isRecordingSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"
  );
}

export function isScreenCaptureSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
}

/**
 * A timer that keeps ticking while the tab is in the background
 * (requestAnimationFrame and main-thread timers get throttled there,
 * which would freeze the composited video).
 */
function createTicker(fps: number, cb: () => void): () => void {
  const code =
    "let id; onmessage = (e) => { clearInterval(id); if (e.data > 0) id = setInterval(() => postMessage(0), e.data); };";
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  const worker = new Worker(url);
  worker.onmessage = cb;
  worker.postMessage(1000 / fps);
  return () => {
    worker.terminate();
    URL.revokeObjectURL(url);
  };
}

async function streamToVideo(stream: MediaStream): Promise<HTMLVideoElement> {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.srcObject = stream;
  await v.play();
  if (!v.videoWidth) {
    await new Promise<void>((resolve) =>
      v.addEventListener("loadedmetadata", () => resolve(), { once: true }),
    );
  }
  return v;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Source crop rectangle that fills `aspect` from the centre of the video. */
function coverCrop(vw: number, vh: number, aspect: number): [number, number, number, number] {
  if (vw / vh > aspect) {
    const sw = vh * aspect;
    return [(vw - sw) / 2, 0, sw, vh];
  }
  const sh = vw / aspect;
  return [0, (vh - sh) / 2, vw, sh];
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  v: HTMLVideoElement,
  src: [number, number, number, number],
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  mirror: boolean,
) {
  const [sx, sy, sw, sh] = src;
  if (mirror) {
    ctx.save();
    ctx.translate(dx + dw, dy);
    ctx.scale(-1, 1);
    ctx.drawImage(v, sx, sy, sw, sh, 0, 0, dw, dh);
    ctx.restore();
  } else {
    ctx.drawImage(v, sx, sy, sw, sh, dx, dy, dw, dh);
  }
}

export class RecordingSession {
  private opts: RecorderOptions;
  private sources: MediaStream[] = [];
  private screenVideo?: HTMLVideoElement;
  private camVideo?: HTMLVideoElement;
  private ctx2d?: CanvasRenderingContext2D;
  private stopTicker?: () => void;
  private audioCtx?: AudioContext;
  private recorder?: MediaRecorder;
  private chunks: Blob[] = [];
  private stopped?: Promise<Blob>;
  private finishing?: Promise<RecordingResult>;
  private startedAt = 0;
  private pausedAt = 0;
  private pausedTotal = 0;
  private cleanedUp = false;

  output?: MediaStream;
  width = 0;
  height = 0;
  /** Called when a source ends on its own (e.g. the browser's "Stop sharing" button). */
  onSourceEnded?: () => void;

  constructor(opts: RecorderOptions) {
    this.opts = { ...opts, overlay: { ...opts.overlay } };
  }

  get state(): RecordingState | "idle" {
    return this.recorder?.state ?? "idle";
  }

  /** Change the camera bubble while recording (only affects screen + camera mode). */
  updateOverlay(overlay: OverlayOptions) {
    this.opts.overlay = { ...overlay };
  }

  /** Ask for permissions and build the output stream. Returns a stream for live preview. */
  async prepare(): Promise<MediaStream> {
    const { mode, fps, resolution } = this.opts;
    const res = RESOLUTIONS[resolution];
    try {
      let screen: MediaStream | undefined;
      let cam: MediaStream | undefined;
      let mic: MediaStream | undefined;

      if (mode !== "camera") {
        const video: MediaTrackConstraints & { displaySurface?: string } = {
          frameRate: { ideal: fps, max: fps },
          width: { ideal: res.w, max: res.w },
          height: { ideal: res.h, max: res.h },
        };
        if (this.opts.displaySurface !== "any") video.displaySurface = this.opts.displaySurface;
        screen = await navigator.mediaDevices.getDisplayMedia({
          video,
          audio: this.opts.systemAudio,
          selfBrowserSurface: "exclude",
          surfaceSwitching: "include",
          systemAudio: this.opts.systemAudio ? "include" : "exclude",
        } as DisplayMediaStreamOptions);
        this.sources.push(screen);
        screen.getVideoTracks()[0]?.addEventListener("ended", () => this.onSourceEnded?.());
      }

      if (mode !== "screen") {
        const camRes = mode === "camera" ? res : RESOLUTIONS["720p"];
        cam = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: this.opts.cameraDeviceId ? { exact: this.opts.cameraDeviceId } : undefined,
            width: { ideal: camRes.w },
            height: { ideal: camRes.h },
            frameRate: { ideal: fps },
          },
        });
        this.sources.push(cam);
        cam.getVideoTracks()[0]?.addEventListener("ended", () => this.onSourceEnded?.());
      }

      if (this.opts.mic) {
        mic = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: this.opts.micDeviceId ? { exact: this.opts.micDeviceId } : undefined,
            echoCancellation: true,
            noiseSuppression: this.opts.noiseSuppression,
            autoGainControl: true,
          },
        });
        this.sources.push(mic);
      }

      // ---- video ----
      let videoTrack: MediaStreamTrack;
      const needsCanvas = mode === "screen_camera" || (mode === "camera" && this.opts.overlay.mirror);
      if (!needsCanvas) {
        videoTrack = (screen ?? cam)!.getVideoTracks()[0];
        const s = videoTrack.getSettings();
        this.width = s.width ?? 0;
        this.height = s.height ?? 0;
      } else {
        if (screen) this.screenVideo = await streamToVideo(screen);
        if (cam) this.camVideo = await streamToVideo(cam);
        const base = (this.screenVideo ?? this.camVideo)!;
        this.width = even(base.videoWidth || res.w);
        this.height = even(base.videoHeight || res.h);
        const canvas = document.createElement("canvas");
        canvas.width = this.width;
        canvas.height = this.height;
        this.ctx2d = canvas.getContext("2d", { alpha: false })!;
        this.draw();
        videoTrack = canvas.captureStream(fps).getVideoTracks()[0];
        this.stopTicker = createTicker(fps, this.draw);
      }

      // ---- audio ----
      const audioTracks = [...(screen?.getAudioTracks() ?? []), ...(mic?.getAudioTracks() ?? [])];
      let audioTrack: MediaStreamTrack | undefined;
      if (audioTracks.length === 1) {
        audioTrack = audioTracks[0];
      } else if (audioTracks.length > 1) {
        this.audioCtx = new AudioContext();
        const dest = this.audioCtx.createMediaStreamDestination();
        for (const t of audioTracks) {
          this.audioCtx.createMediaStreamSource(new MediaStream([t])).connect(dest);
        }
        audioTrack = dest.stream.getAudioTracks()[0];
      }

      this.output = new MediaStream(audioTrack ? [videoTrack, audioTrack] : [videoTrack]);
      return this.output;
    } catch (err) {
      this.cleanup();
      throw err;
    }
  }

  private draw = () => {
    const ctx = this.ctx2d;
    if (!ctx) return;
    const W = this.width;
    const H = this.height;
    const o = this.opts.overlay;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);

    const sv = this.screenVideo;
    const cv = this.camVideo;

    if (sv && sv.videoWidth) {
      // Fit the screen inside the canvas (window shares can change size mid-recording)
      const s = Math.min(W / sv.videoWidth, H / sv.videoHeight);
      const dw = sv.videoWidth * s;
      const dh = sv.videoHeight * s;
      ctx.drawImage(sv, (W - dw) / 2, (H - dh) / 2, dw, dh);

      if (cv && cv.videoWidth && o.visible) {
        const aspect = o.shape === "rounded" ? 4 / 3 : 1;
        const w = Math.round(W * OVERLAY_SIZE[o.size]);
        const h = Math.round(w / aspect);
        const m = Math.round(Math.min(W, H) * 0.03);
        const x = o.position.endsWith("left") ? m : W - w - m;
        const y = o.position.startsWith("top") ? m : H - h - m;

        ctx.save();
        ctx.beginPath();
        if (o.shape === "circle") ctx.arc(x + w / 2, y + h / 2, w / 2, 0, Math.PI * 2);
        else if (o.shape === "rounded") ctx.roundRect(x, y, w, h, w * 0.08);
        else ctx.rect(x, y, w, h);
        ctx.save();
        ctx.clip();
        drawFrame(ctx, cv, coverCrop(cv.videoWidth, cv.videoHeight, aspect), x, y, w, h, o.mirror);
        ctx.restore();
        ctx.lineWidth = Math.max(2, w * 0.012);
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.stroke();
        ctx.restore();
      }
    } else if (cv && cv.videoWidth) {
      drawFrame(ctx, cv, coverCrop(cv.videoWidth, cv.videoHeight, W / H), 0, 0, W, H, o.mirror);
    }
  };

  start() {
    if (!this.output) throw new Error("Call prepare() first");
    const base = RESOLUTIONS[this.opts.resolution].bitrate;
    const videoBitsPerSecond = Math.round(base * (this.opts.fps > 30 ? 1.5 : 1));
    const rec = new MediaRecorder(this.output, {
      mimeType: this.opts.mimeType || undefined,
      videoBitsPerSecond,
      audioBitsPerSecond: 128_000,
    });
    this.recorder = rec;
    this.chunks = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.stopped = new Promise<Blob>((resolve) => {
      rec.onstop = () =>
        resolve(new Blob(this.chunks, { type: rec.mimeType || this.opts.mimeType || "video/webm" }));
    });
    rec.start(1000);
    this.startedAt = performance.now();
    this.pausedTotal = 0;
    this.pausedAt = 0;
  }

  pause() {
    if (this.recorder?.state === "recording") {
      this.recorder.pause();
      this.pausedAt = performance.now();
    }
  }

  resume() {
    if (this.recorder?.state === "paused") {
      this.recorder.resume();
      this.pausedTotal += performance.now() - this.pausedAt;
      this.pausedAt = 0;
    }
  }

  /** Elapsed recording time in milliseconds, excluding pauses. */
  elapsedMs(): number {
    if (!this.startedAt) return 0;
    const now = this.pausedAt || performance.now();
    return Math.max(0, now - this.startedAt - this.pausedTotal);
  }

  stop(): Promise<RecordingResult> {
    if (this.finishing) return this.finishing;
    this.finishing = (async () => {
      const durationSec = this.elapsedMs() / 1000;
      const rec = this.recorder;
      if (!rec || !this.stopped) {
        this.cleanup();
        throw new Error("Recording was not started");
      }
      if (rec.state !== "inactive") rec.stop();
      const blob = await this.stopped;
      this.cleanup();
      return {
        blob,
        durationSec,
        width: this.width,
        height: this.height,
        mimeType: blob.type,
      };
    })();
    return this.finishing;
  }

  /** Abort without producing a file (e.g. cancelled during the countdown). */
  cancel() {
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.cleanup();
  }

  private cleanup() {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.stopTicker?.();
    this.output?.getTracks().forEach((t) => t.stop());
    this.sources.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    this.audioCtx?.close().catch(() => {});
    for (const v of [this.screenVideo, this.camVideo]) {
      if (v) v.srcObject = null;
    }
    this.ctx2d = undefined;
  }
}

/** Human-friendly message for getUserMedia / getDisplayMedia errors. */
export function describeMediaError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
        return "Permission was denied or the screen picker was cancelled.";
      case "NotFoundError":
        return "No matching camera or microphone was found.";
      case "NotReadableError":
        return "The camera or microphone is already in use by another application.";
      case "OverconstrainedError":
        return "The selected device does not support the requested settings.";
      case "NotSupportedError":
        return "This browser does not support the requested recording settings.";
    }
    return err.message || err.name;
  }
  return err instanceof Error ? err.message : String(err);
}
