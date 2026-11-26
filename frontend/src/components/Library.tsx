"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Caption,
  type Recording,
  captionsUrl,
  convertRecording,
  deleteRecording,
  denoiseRecording,
  fileUrl,
  getRecording,
  health,
  listRecordings,
  renameRecording,
  thumbnailUrl,
  getTranscript,
  transcribeRecording,
} from "@/lib/api";
import { formatBytes, formatDate, formatDuration } from "@/lib/format";
import SeekableVideo from "./SeekableVideo";

const MODE_LABEL = { screen: "Screen", camera: "Camera", screen_camera: "Screen + Cam" } as const;

export default function Library() {
  const [items, setItems] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [ffmpeg, setFfmpeg] = useState(false);
  const [denoiserOk, setDenoiserOk] = useState(false);
  const [transcriberOk, setTranscriberOk] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async (q: string) => {
    try {
      setItems(await listRecordings(q || undefined));
      setError(null);
    } catch (e) {
      setError(
        e instanceof TypeError
          ? "Cannot reach the backend. Start it with: uvicorn app.main:app --reload (in the backend folder)."
          : (e as Error).message,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    health()
      .then((h) => {
        setFfmpeg(h.ffmpeg);
        setDenoiserOk(h.denoiser.available);
        setTranscriberOk(h.transcriber.available);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(query), 250);
    return () => clearTimeout(t);
  }, [query, load]);

  // refresh items whose thumbnail / conversion is still pending
  useEffect(() => {
    const pending = items.filter(
      (r) => r.convert_status === "processing" || r.denoise_status === "processing" || r.transcript_status === "processing",
    );
    if (!pending.length) return;
    const t = setInterval(async () => {
      const updated = await Promise.all(pending.map((r) => getRecording(r.id).catch(() => r)));
      setItems((prev) => prev.map((r) => updated.find((u) => u.id === r.id) ?? r));
    }, 2000);
    return () => clearInterval(t);
  }, [items]);

  const replace = (r: Recording) => setItems((prev) => prev.map((x) => (x.id === r.id ? r : x)));
  const remove = (id: string) => setItems((prev) => prev.filter((x) => x.id !== id));
  const open = items.find((r) => r.id === openId) ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Library</h1>
          <p className="text-sm text-gray-400">
            {items.length} recording{items.length === 1 ? "" : "s"} saved on the server
          </p>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <input
            className="select sm:w-64"
            placeholder="Search titles and transcripts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Link href="/" className="btn btn-primary shrink-0">
            ● Record
          </Link>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : items.length === 0 && !error ? (
        <div className="card p-10 text-center">
          <p className="text-gray-300">{query ? "No recordings match your search." : "No recordings yet."}</p>
          {!query && (
            <Link href="/" className="btn btn-primary mt-4">
              Make your first recording
            </Link>
          )}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((r) => (
            <Card key={r.id} rec={r} onOpen={() => setOpenId(r.id)} />
          ))}
        </div>
      )}

      {open && (
        <PlayerModal
          rec={open}
          ffmpeg={ffmpeg}
          denoiserOk={denoiserOk}
          transcriberOk={transcriberOk}
          onClose={() => setOpenId(null)}
          onChange={replace}
          onDelete={(id) => {
            remove(id);
            setOpenId(null);
          }}
        />
      )}
    </div>
  );
}

function Card({ rec, onOpen }: { rec: Recording; onOpen: () => void }) {
  const [thumbOk, setThumbOk] = useState(true);
  return (
    <button onClick={onOpen} className="card group overflow-hidden text-left transition hover:border-white/25">
      <div className="relative aspect-video bg-gradient-to-br from-[#151a24] to-[#0b0d12]">
        {thumbOk && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailUrl(rec.id)}
            alt=""
            className="h-full w-full object-cover"
            onError={() => setThumbOk(false)}
          />
        )}
        {!thumbOk && <div className="absolute inset-0 grid place-items-center text-3xl text-gray-600">▶</div>}
        <span className="absolute bottom-2 right-2 rounded bg-black/75 px-1.5 py-0.5 font-mono text-xs">
          {formatDuration(rec.duration_sec)}
        </span>
        <span className="absolute left-2 top-2 rounded bg-black/75 px-1.5 py-0.5 text-xs">{MODE_LABEL[rec.mode]}</span>
        {rec.has_denoised && (
          <span className="absolute right-2 top-2 rounded bg-emerald-600/90 px-1.5 py-0.5 text-xs">✨ Clean audio</span>
        )}
        {rec.denoise_status === "processing" && (
          <span className="absolute right-2 top-2 rounded bg-black/75 px-1.5 py-0.5 text-xs">Removing noise…</span>
        )}
        {rec.has_transcript && (
          <span className="absolute bottom-2 left-2 rounded bg-black/75 px-1.5 py-0.5 text-xs font-semibold">CC</span>
        )}
        {rec.transcript_status === "processing" && (
          <span className="absolute bottom-2 left-2 rounded bg-black/75 px-1.5 py-0.5 text-xs">Subtitles…</span>
        )}
        <div className="absolute inset-0 grid place-items-center bg-black/40 opacity-0 transition group-hover:opacity-100">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-white/90 pl-1 text-xl text-black">▶</span>
        </div>
      </div>
      <div className="p-3">
        <p className="truncate font-medium">{rec.title}</p>
        <p className="text-xs text-gray-500">
          {formatDate(rec.created_at)} · {formatBytes(rec.size_bytes)}
        </p>
      </div>
    </button>
  );
}

function PlayerModal({
  rec,
  ffmpeg,
  denoiserOk,
  transcriberOk,
  onClose,
  onChange,
  onDelete,
}: {
  rec: Recording;
  ffmpeg: boolean;
  denoiserOk: boolean;
  transcriberOk: boolean;
  onClose: () => void;
  onChange: (r: Recording) => void;
  onDelete: (id: string) => void;
}) {
  const [title, setTitle] = useState(rec.title);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isMp4 = rec.mime_type === "video/mp4";
  const [version, setVersion] = useState<"original" | "denoised">(rec.has_denoised ? "denoised" : "original");
  useEffect(() => {
    if (rec.has_denoised) setVersion("denoised");
  }, [rec.has_denoised]);
  const playing = version === "denoised" && rec.has_denoised ? "denoised" : "original";
  const videoRef = useRef<HTMLVideoElement>(null);
  const [captions, setCaptions] = useState<Caption[] | null>(null);
  const [now, setNow] = useState(0);
  const [showSubs, setShowSubs] = useState(true);
  // cache-buster for the subtitles file: changes each time a (new) transcript becomes available
  const captionsVersion = useMemo(() => (rec.has_transcript ? Date.now().toString(36) : ""), [rec.has_transcript]);

  // load the transcript once it exists (and again after "Run again")
  useEffect(() => {
    if (!rec.has_transcript) {
      setCaptions(null);
      return;
    }
    let alive = true;
    getTranscript(rec.id)
      .then((t) => alive && setCaptions(t.captions))
      .catch(() => alive && setCaptions([]));
    return () => {
      alive = false;
    };
  }, [rec.id, rec.has_transcript, rec.transcript_status]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveTitle = () =>
    run(async () => {
      const t = title.trim();
      if (!t || t === rec.title) return setEditing(false);
      onChange(await renameRecording(rec.id, t));
      setEditing(false);
    });

  const del = () => {
    if (!confirm(`Delete "${rec.title}"? This cannot be undone.`)) return;
    void run(async () => {
      await deleteRecording(rec.id);
      onDelete(rec.id);
    });
  };

  const convert = () => run(async () => onChange(await convertRecording(rec.id)));
  const denoise = () => run(async () => onChange(await denoiseRecording(rec.id)));
  const transcribe = () => run(async () => onChange(await transcribeRecording(rec.id)));
  const seek = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = t;
    void v.play().catch(() => {});
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="card max-h-[94vh] w-full max-w-4xl overflow-y-auto bg-[#0f1219]"
        onClick={(e) => e.stopPropagation()}
      >
        <SeekableVideo
          key={playing}
          src={fileUrl(rec.id, playing === "denoised" ? { format: "denoised" } : {})}
          autoPlay
          className="max-h-[60vh] w-full"
          videoRef={videoRef}
          onTime={setNow}
          subtitles={
            showSubs && rec.has_transcript
              ? { src: captionsUrl(rec.id, "vtt", false, captionsVersion), label: "Khmer / English", srclang: "km" }
              : null
          }
        />
        <div className="space-y-4 p-5">
          <div className="flex items-start justify-between gap-3">
            {editing ? (
              <div className="flex flex-1 gap-2">
                <input
                  className="select"
                  value={title}
                  autoFocus
                  maxLength={200}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveTitle()}
                />
                <button className="btn btn-primary" onClick={saveTitle} disabled={busy}>
                  Save
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setTitle(rec.title);
                    setEditing(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold">{rec.title}</h2>
                <p className="text-sm text-gray-400">
                  {formatDate(rec.created_at)} · {formatDuration(rec.duration_sec)} · {formatBytes(rec.size_bytes)}
                  {rec.width ? ` · ${rec.width}×${rec.height}` : ""} · {MODE_LABEL[rec.mode]}
                </p>
              </div>
            )}
            <button className="btn btn-ghost px-2" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>

          {err && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{err}</div>
          )}

          {/* AI noise removal (NVIDIA NemotronLabs RE-USE) */}
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-white/[0.04] px-3 py-2.5 text-sm">
            <span className="font-medium">✨ AI noise removal</span>
            {rec.has_denoised && (
              <div className="seg">
                <button data-active={playing === "original"} onClick={() => setVersion("original")}>
                  Original
                </button>
                <button data-active={playing === "denoised"} onClick={() => setVersion("denoised")}>
                  Noise removed
                </button>
              </div>
            )}
            {rec.denoise_status === "processing" ? (
              <span className="flex items-center gap-2 text-gray-300">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Processing on GPU…
              </span>
            ) : (
              <button
                className="btn btn-secondary py-1.5"
                onClick={denoise}
                disabled={busy || !denoiserOk}
                title={denoiserOk ? "Clean the audio with NVIDIA RE-USE" : "The AI denoiser service is not running"}
              >
                {rec.has_denoised ? "Run again" : rec.denoise_status === "failed" ? "Retry" : "Remove noise"}
              </button>
            )}
            {rec.has_denoised && (
              <a className="btn btn-secondary py-1.5" href={fileUrl(rec.id, { format: "denoised", download: true })}>
                ⬇ Download clean version
              </a>
            )}
            {!denoiserOk && rec.denoise_status !== "processing" && (
              <span className="text-xs text-gray-500">AI service not running</span>
            )}
            {rec.denoise_status === "failed" && rec.denoise_error && (
              <span className="w-full text-xs text-red-300">Failed: {rec.denoise_error}</span>
            )}
          </div>

          {/* Speech to text / subtitles (Sota ASR Khmer) */}
          <div className="space-y-3 rounded-lg bg-white/[0.04] px-3 py-2.5 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">📝 Subtitles</span>
              {rec.transcript_status === "processing" ? (
                <span className="flex items-center gap-2 text-gray-300">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Converting speech to text…
                </span>
              ) : (
                <button
                  className="btn btn-secondary py-1.5"
                  onClick={transcribe}
                  disabled={busy || !transcriberOk}
                  title={transcriberOk ? "Speech to text (Khmer / English)" : "The speech-to-text service is not running"}
                >
                  {rec.has_transcript ? "Run again" : rec.transcript_status === "failed" ? "Retry" : "Make subtitles"}
                </button>
              )}
              {rec.has_transcript && (
                <>
                  <label className="flex cursor-pointer items-center gap-1.5 text-gray-300">
                    <input
                      type="checkbox"
                      className="accent-[var(--color-brand)]"
                      checked={showSubs}
                      onChange={(e) => setShowSubs(e.target.checked)}
                    />
                    Show on video
                  </label>
                  <div className="ml-auto flex gap-1.5">
                    {(["srt", "vtt", "txt"] as const).map((f) => (
                      <a key={f} className="btn btn-secondary px-2.5 py-1.5 text-xs" href={captionsUrl(rec.id, f, true)}>
                        ⬇ {f.toUpperCase()}
                      </a>
                    ))}
                  </div>
                </>
              )}
              {!transcriberOk && rec.transcript_status !== "processing" && !rec.has_transcript && (
                <span className="text-xs text-gray-500">Speech-to-text service not running</span>
              )}
              {rec.transcript_status === "failed" && rec.transcript_error && (
                <span className="w-full text-xs text-red-300">Failed: {rec.transcript_error}</span>
              )}
            </div>

            {rec.has_transcript && captions && (
              <ol className="max-h-56 space-y-0.5 overflow-y-auto pr-1">
                {captions.length === 0 && <li className="text-xs text-gray-500">No speech was detected.</li>}
                {captions.map((c, i) => {
                  const active = now >= c.start && now < c.end;
                  return (
                    <li key={i}>
                      <button
                        onClick={() => seek(c.start)}
                        className={`flex w-full gap-3 rounded-md px-2 py-1 text-left transition ${
                          active ? "bg-brand/15 text-white" : "text-gray-300 hover:bg-white/5"
                        }`}
                      >
                        <span className="shrink-0 font-mono text-xs leading-6 text-gray-500">
                          {formatDuration(c.start)}
                        </span>
                        <span className="khmer leading-6">{c.text}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <a className="btn btn-secondary" href={fileUrl(rec.id, { download: true })}>
              ⬇ Download {isMp4 ? "MP4" : rec.mime_type.split("/")[1]?.toUpperCase()}
            </a>
            {!isMp4 &&
              (rec.has_mp4 ? (
                <a className="btn btn-secondary" href={fileUrl(rec.id, { format: "mp4", download: true })}>
                  ⬇ Download MP4
                </a>
              ) : rec.convert_status === "processing" ? (
                <button className="btn btn-secondary" disabled>
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Converting to MP4…
                </button>
              ) : (
                <button
                  className="btn btn-secondary"
                  onClick={convert}
                  disabled={busy || !ffmpeg}
                  title={ffmpeg ? "Convert to MP4 for wider compatibility" : "ffmpeg is not installed on the server"}
                >
                  ⟳ {rec.convert_status === "failed" ? "Retry MP4 conversion" : "Convert to MP4"}
                </button>
              ))}
            <button
              className="btn btn-secondary"
              onClick={() => navigator.clipboard?.writeText(fileUrl(rec.id))}
              title="Copy a direct link to the video file"
            >
              🔗 Copy link
            </button>
            {!editing && (
              <button className="btn btn-secondary" onClick={() => setEditing(true)}>
                ✎ Rename
              </button>
            )}
            <button className="btn btn-ghost ml-auto text-red-300" onClick={del} disabled={busy}>
              🗑 Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
