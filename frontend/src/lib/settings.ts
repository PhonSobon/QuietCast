"use client";

import { useCallback, useEffect, useState } from "react";
import type { DisplaySurface, Mode, OverlayOptions, Resolution } from "./recorder";

export interface Settings {
  mode: Mode;
  resolution: Resolution;
  fps: 30 | 60;
  displaySurface: DisplaySurface;
  mic: boolean;
  micDeviceId: string;
  noiseSuppression: boolean;
  systemAudio: boolean;
  cameraDeviceId: string;
  format: "webm" | "mp4";
  overlay: OverlayOptions;
  countdown: 0 | 3 | 5 | 10;
  autoStopMin: number;
  autoUpload: boolean;
  /** AI noise removal with NVIDIA RE-USE (applied on the server after saving) */
  aiDenoise: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: "screen_camera",
  resolution: "1080p",
  fps: 30,
  displaySurface: "any",
  mic: true,
  micDeviceId: "",
  noiseSuppression: true,
  systemAudio: true,
  cameraDeviceId: "",
  format: "webm",
  overlay: { visible: true, position: "bottom-right", size: "medium", shape: "circle", mirror: true },
  countdown: 3,
  autoStopMin: 0,
  autoUpload: false,
  aiDenoise: false,
};

const KEY = "recorder.settings.v1";

/** Settings persisted in localStorage (best effort; works without it). */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        setSettings({
          ...DEFAULT_SETTINGS,
          ...saved,
          overlay: { ...DEFAULT_SETTINGS.overlay, ...(saved.overlay ?? {}) },
        });
      }
    } catch {
      /* storage unavailable */
    }
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }, []);

  const updateOverlay = useCallback(
    (patch: Partial<OverlayOptions>) =>
      setSettings((prev) => {
        const next = { ...prev, overlay: { ...prev.overlay, ...patch } };
        try {
          localStorage.setItem(KEY, JSON.stringify(next));
        } catch {
          /* storage unavailable */
        }
        return next;
      }),
    [],
  );

  return { settings, update, updateOverlay };
}
