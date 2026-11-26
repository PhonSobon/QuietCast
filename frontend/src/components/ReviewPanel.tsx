"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Recording, uploadRecording } from "@/lib/api";
import { defaultTitle, downloadBlob, formatBytes, formatDuration, safeFilename } from "@/lib/format";
import type { Mode, RecordingResult } from "@/lib/recorder";
import SeekableVideo from "./SeekableVideo";

export type ReviewResult = RecordingResult & { url: string; mode: Mode };

type UploadState =
  | { status: "idle" }
  | { status: "uploading"; progress: number }
  | { status: "done"; recording: Recording }
  | { status: "error"; message: string };

export default function ReviewPanel({
  result,
  autoUpload,
  aiDenoise,
  denoiserAvailable,
  autoTranscribe,
  transcriberAvailable,
  onSaved,
  onDone,
}: {
  result: ReviewResult;
  autoUpload: boolean;
  aiDenoise: boolean;
  denoiserAvailable: boolean;
  autoTranscribe: boolean;
  transcriberAvailable: boolean;
  onSaved: () => void;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [upload, setUpload] = useState<UploadState>({ status: "idle" });
  const [downloaded, setDownloaded] = useState(false);
  const [denoise, setDenoise] = useState(aiDenoise);
  const [transcribe, setTranscribe] = useState(autoTranscribe);
  const abortRef = useRef<(() => void) | null>(null);
  const autoStarted = useRef(false);

  const ext = result.mimeType.includes("mp4") ? "mp4" : "webm";
  const kept = downloaded || upload.status === "done";

  const save = useCallback(async () => {
    setUpload({ status: "uploading", progress: 0 });
    const { promise, abort } = uploadRecording(
      result.blob,
      {
        title: title.trim() || "Untitled recording",
        durationSec: result.durationSec,
        mode: result.mode,
        width: result.width,
        height: result.height,
        denoise,
        transcribe,
      },
      (progress) => setUpload({ status: "uploading", progress }),
    );
    abortRef.current = abort;
    try {
      const recording = await promise;
      setUpload({ status: "done", recording });
      onSaved();
    } catch (e) {
      setUpload({ status: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      abortRef.current = null;
    }
  }, [result, title, denoise, transcribe, onSaved]);

  useEffect(() => {
    if (autoUpload && !autoStarted.current) {
      autoStarted.current = true;
      void save();
    }
  }, [autoUpload, save]);

  useEffect(() => () => abortRef.current?.(), []);

  const download = () => {
    downloadBlob(result.blob, `${safeFilename(title)}.${ext}`);
    setDownloaded(true);
    onSaved();
  };

  const discard = () => {
    if (!kept && !confirm("Discard this recording? It hasn't been downloaded or saved.")) return;
    abortRef.current?.();
    onDone();
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-black">
        <SeekableVideo src={result.url} className="aspect-video w-full" />
      </div>

      <aside className="card h-fit space-y-5 p-5">
        <div>
          <h2 className="text-lg font-semibold">Recording ready</h2>
          <p className="text-sm text-gray-400">Preview it, then download or save it to your library.</p>
        </div>

        <div>
          <label className="label" htmlFor="rec-title">
            Title
          </label>
          <input
            id="rec-title"
            className="select"
            value={title}
            maxLength={200}
            disabled={upload.status === "uploading" || upload.status === "done"}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Info label="Duration" value={formatDuration(result.durationSec)} />
          <Info label="Size" value={formatBytes(result.blob.size)} />
          <Info label="Resolution" value={result.width ? `${result.width}×${result.height}` : "—"} />
          <Info label="Format" value={ext.toUpperCase()} />
        </dl>

        <div className="space-y-2">
          <button className="btn btn-secondary w-full" onClick={download}>
            ⬇ Download to computer
          </button>

          {upload.status === "idle" && (
            <>
              <label
                className={`flex items-start gap-2 rounded-lg bg-white/[0.04] px-3 py-2 text-sm ${
                  denoiserAvailable ? "cursor-pointer" : "opacity-50"
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[var(--color-brand)]"
                  checked={denoise}
                  disabled={!denoiserAvailable}
                  onChange={(e) => setDenoise(e.target.checked)}
                />
                <span>
                  Remove background noise with AI
                  <span className="block text-xs text-gray-500">
                    {denoiserAvailable
                      ? "NVIDIA RE-USE runs on the server after upload; the original is kept."
                      : "AI service is not running."}
                  </span>
                </span>
              </label>
              <label
                className={`flex items-start gap-2 rounded-lg bg-white/[0.04] px-3 py-2 text-sm ${
                  transcriberAvailable ? "cursor-pointer" : "opacity-50"
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[var(--color-brand)]"
                  checked={transcribe}
                  disabled={!transcriberAvailable}
                  onChange={(e) => setTranscribe(e.target.checked)}
                />
                <span>
                  Make subtitles (Khmer / English)
                  <span className="block text-xs text-gray-500">
                    {transcriberAvailable
                      ? "Speech to text on the server; uses the clean audio when noise removal is on."
                      : "Speech-to-text service is not running."}
                  </span>
                </span>
              </label>
              <button className="btn btn-primary w-full" onClick={save}>
                ☁ Save to library
              </button>
            </>
          )}
          {upload.status === "uploading" && (
            <div className="space-y-2">
              <div className="h-2 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full bg-brand transition-[width]"
                  style={{ width: `${Math.round(upload.progress * 100)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-gray-400">
                <span>Uploading… {Math.round(upload.progress * 100)}%</span>
                <button className="hover:text-white" onClick={() => abortRef.current?.()}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {upload.status === "done" && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
              Saved to library.
              {upload.recording.denoise_status === "processing" && " AI noise removal is running…"}
              {upload.recording.transcript_status === "processing" && " Making subtitles…"}{" "}
              <Link href="/library" className="underline">
                Open library →
              </Link>
            </div>
          )}
          {upload.status === "error" && (
            <div className="space-y-2">
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {upload.message}
              </div>
              <button className="btn btn-primary w-full" onClick={save}>
                Retry upload
              </button>
            </div>
          )}
        </div>

        <div className="flex gap-2 border-t border-white/10 pt-4">
          <button className="btn btn-secondary flex-1" onClick={kept ? onDone : discard}>
            ● New recording
          </button>
          {!kept && (
            <button className="btn btn-ghost text-red-300" onClick={discard}>
              Discard
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.04] px-3 py-2">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
