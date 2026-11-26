export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/$/, "");

export type RecordingMode = "screen" | "camera" | "screen_camera";

export type JobStatus = "none" | "processing" | "done" | "failed";

export interface Health {
  status: string;
  ffmpeg: boolean;
  denoiser: { available: boolean; device: string | null; error: string | null };
  transcriber: { available: boolean; languages: string[] | null; error: string | null };
}

export interface Recording {
  id: string;
  title: string;
  mime_type: string;
  size_bytes: number;
  duration_sec: number;
  mode: RecordingMode;
  width: number | null;
  height: number | null;
  has_thumbnail: boolean;
  has_mp4: boolean;
  convert_status: JobStatus;
  has_denoised: boolean;
  denoise_status: JobStatus;
  denoise_error: string | null;
  has_transcript: boolean;
  transcript_status: JobStatus;
  transcript_error: string | null;
  created_at: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export function health() {
  return request<Health>("/api/health");
}

export function listRecordings(q?: string) {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  return request<Recording[]>(`/api/recordings${qs}`);
}

export function getRecording(id: string) {
  return request<Recording>(`/api/recordings/${id}`);
}

export function renameRecording(id: string, title: string) {
  return request<Recording>(`/api/recordings/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export function deleteRecording(id: string) {
  return request<void>(`/api/recordings/${id}`, { method: "DELETE" });
}

export function convertRecording(id: string) {
  return request<Recording>(`/api/recordings/${id}/convert`, { method: "POST" });
}

/** Remove background noise with NVIDIA NemotronLabs RE-USE (server-side, async). */
export function denoiseRecording(id: string) {
  return request<Recording>(`/api/recordings/${id}/denoise`, { method: "POST" });
}

/** Speech to text (Khmer / English) with Sota ASR; makes subtitles (server-side, async). */
export function transcribeRecording(id: string) {
  return request<Recording>(`/api/recordings/${id}/transcribe`, { method: "POST" });
}

export interface Caption {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  text: string;
  seconds: number;
  captions: Caption[];
}

export function getTranscript(id: string) {
  return request<Transcript>(`/api/recordings/${id}/transcript`);
}

export function captionsUrl(id: string, format: "vtt" | "srt" | "txt" = "vtt", download = false, version = "") {
  const p = new URLSearchParams({ format });
  if (download) p.set("download", "true");
  if (version) p.set("v", version);
  return `${API_URL}/api/recordings/${id}/captions?${p}`;
}

export function fileUrl(id: string, opts: { format?: "original" | "mp4" | "denoised"; download?: boolean } = {}) {
  const p = new URLSearchParams();
  if (opts.format) p.set("format", opts.format);
  if (opts.download) p.set("download", "true");
  const qs = p.toString();
  return `${API_URL}/api/recordings/${id}/file${qs ? `?${qs}` : ""}`;
}

export function thumbnailUrl(id: string) {
  return `${API_URL}/api/recordings/${id}/thumbnail`;
}

export interface UploadMeta {
  title: string;
  durationSec: number;
  mode: RecordingMode;
  width?: number;
  height?: number;
  /** Run AI noise removal after upload */
  denoise?: boolean;
  /** Make subtitles (speech to text) after upload */
  transcribe?: boolean;
}

/** Upload with progress reporting (fetch has no upload progress, so use XHR). */
export function uploadRecording(
  blob: Blob,
  meta: UploadMeta,
  onProgress?: (fraction: number) => void,
): { promise: Promise<Recording>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Recording>((resolve, reject) => {
    const form = new FormData();
    const ext = blob.type.includes("mp4") ? "mp4" : "webm";
    form.append("file", blob, `recording.${ext}`);
    form.append("title", meta.title);
    form.append("duration_sec", String(meta.durationSec));
    form.append("mode", meta.mode);
    if (meta.width) form.append("width", String(meta.width));
    if (meta.height) form.append("height", String(meta.height));
    if (meta.denoise) form.append("denoise", "true");
    if (meta.transcribe) form.append("transcribe", "true");

    xhr.open("POST", `${API_URL}/api/recordings`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        let detail = `Upload failed (${xhr.status})`;
        try {
          detail = JSON.parse(xhr.responseText).detail ?? detail;
        } catch {
          /* ignore */
        }
        reject(new Error(detail));
      }
    };
    xhr.onerror = () => reject(new Error("Cannot reach the server. Is the backend running?"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}
