"use client";

import { useEffect, useRef } from "react";

/**
 * Video player that works around browser-recorded WebM files having no duration
 * in their header (Chrome reports Infinity and the seek bar doesn't work).
 */
export default function SeekableVideo({
  src,
  className = "",
  autoPlay = false,
  poster,
}: {
  src: string;
  className?: string;
  autoPlay?: boolean;
  poster?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const onMeta = () => {
      if (v.duration === Infinity || Number.isNaN(v.duration)) {
        const onTime = () => {
          v.removeEventListener("timeupdate", onTime);
          v.currentTime = 0;
        };
        v.addEventListener("timeupdate", onTime);
        v.currentTime = 1e101; // forces the browser to scan for the real duration
      }
    };
    v.addEventListener("loadedmetadata", onMeta);
    return () => v.removeEventListener("loadedmetadata", onMeta);
  }, [src]);

  return (
    <video
      ref={ref}
      src={src}
      poster={poster}
      controls
      autoPlay={autoPlay}
      playsInline
      preload="metadata"
      className={`bg-black ${className}`}
    />
  );
}
