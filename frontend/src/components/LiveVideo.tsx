"use client";

import { useEffect, useRef } from "react";

/** <video> bound to a MediaStream (muted to avoid feedback). */
export default function LiveVideo({
  stream,
  mirror = false,
  className = "",
  fit = "contain",
}: {
  stream: MediaStream | null;
  mirror?: boolean;
  className?: string;
  fit?: "contain" | "cover";
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) v.play().catch(() => {});
  }, [stream]);
  return (
    <video
      ref={ref}
      muted
      playsInline
      autoPlay
      className={`${fit === "cover" ? "object-cover" : "object-contain"} ${className}`}
      style={mirror ? { transform: "scaleX(-1)" } : undefined}
    />
  );
}
