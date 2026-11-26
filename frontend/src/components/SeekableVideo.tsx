"use client";

import { type RefObject, useEffect, useRef } from "react";

/**
 * Video player that works around browser-recorded WebM files having no duration
 * in their header (Chrome reports Infinity and the seek bar doesn't work).
 * Optionally shows a subtitles track (WebVTT).
 */
export default function SeekableVideo({
  src,
  className = "",
  autoPlay = false,
  poster,
  subtitles,
  videoRef,
  onTime,
}: {
  src: string;
  className?: string;
  autoPlay?: boolean;
  poster?: string;
  subtitles?: { src: string; label: string; srclang: string } | null;
  videoRef?: RefObject<HTMLVideoElement | null>;
  onTime?: (seconds: number) => void;
}) {
  const own = useRef<HTMLVideoElement>(null);
  const ref = videoRef ?? own;

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const onMeta = () => {
      if (v.duration === Infinity || Number.isNaN(v.duration)) {
        const onTimeFix = () => {
          v.removeEventListener("timeupdate", onTimeFix);
          v.currentTime = 0;
        };
        v.addEventListener("timeupdate", onTimeFix);
        v.currentTime = 1e101; // forces the browser to scan for the real duration
      }
    };
    v.addEventListener("loadedmetadata", onMeta);
    return () => v.removeEventListener("loadedmetadata", onMeta);
  }, [src, ref]);

  // show subtitles by default once the track is loaded
  useEffect(() => {
    const v = ref.current;
    if (!v || !subtitles) return;
    const show = () => {
      for (const t of Array.from(v.textTracks)) t.mode = "showing";
    };
    show();
    v.textTracks.addEventListener?.("addtrack", show);
    return () => v.textTracks.removeEventListener?.("addtrack", show);
  }, [subtitles, ref]);

  return (
    <video
      ref={ref}
      src={src}
      poster={poster}
      controls
      autoPlay={autoPlay}
      playsInline
      preload="metadata"
      // tracks from another origin (the API) need CORS
      crossOrigin={subtitles ? "anonymous" : undefined}
      onTimeUpdate={onTime ? (e) => onTime(e.currentTarget.currentTime) : undefined}
      className={`bg-black ${className}`}
    >
      {subtitles && <track kind="subtitles" src={subtitles.src} srcLang={subtitles.srclang} label={subtitles.label} default />}
    </video>
  );
}
