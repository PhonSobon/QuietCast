import type { ReactNode, SVGProps } from "react";

/**
 * Small inline SVG icon set (24x24, stroke = currentColor).
 * Size with Tailwind (default h-4 w-4), colour follows the text colour.
 */
type IconProps = SVGProps<SVGSVGElement>;

function base(children: ReactNode, { className = "h-4 w-4", ...props }: IconProps, filled = false) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
      {...props}
    >
      {children}
    </svg>
  );
}

export const RecordIcon = (p: IconProps) => base(<circle cx="12" cy="12" r="7" />, p, true);

export const PlayIcon = (p: IconProps) => base(<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z" />, p, true);

export const PauseIcon = (p: IconProps) =>
  base(
    <>
      <rect x="6" y="4.5" width="4" height="15" rx="1" />
      <rect x="14" y="4.5" width="4" height="15" rx="1" />
    </>,
    p,
    true,
  );

export const StopIcon = (p: IconProps) => base(<rect x="5.5" y="5.5" width="13" height="13" rx="2" />, p, true);

export const SparklesIcon = (p: IconProps) =>
  base(
    <>
      <path d="M10 3.5 11.6 8.4 16.5 10 11.6 11.6 10 16.5 8.4 11.6 3.5 10 8.4 8.4Z" />
      <path d="M18 14v6M15 17h6" />
    </>,
    p,
  );

export const CaptionsIcon = (p: IconProps) =>
  base(
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M10.5 10.2a2.2 2.2 0 1 0 0 3.6M17 10.2a2.2 2.2 0 1 0 0 3.6" />
    </>,
    p,
  );

export const DownloadIcon = (p: IconProps) =>
  base(
    <>
      <path d="M12 4v11" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 20h14" />
    </>,
    p,
  );

export const UploadCloudIcon = (p: IconProps) =>
  base(
    <>
      <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 10a4 4 0 0 1-1 7.9" />
      <path d="M12 12v8" />
      <path d="m8.5 15.5 3.5-3.5 3.5 3.5" />
    </>,
    p,
  );

export const LinkIcon = (p: IconProps) =>
  base(
    <>
      <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" />
      <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" />
    </>,
    p,
  );

export const PencilIcon = (p: IconProps) =>
  base(
    <>
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
      <path d="m14.5 5.5 3 3" />
    </>,
    p,
  );

export const TrashIcon = (p: IconProps) =>
  base(
    <>
      <path d="M4 7h16" />
      <path d="M9 7V4.5h6V7" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M10 11v5M14 11v5" />
    </>,
    p,
  );

export const XIcon = (p: IconProps) => base(<path d="M6 6l12 12M18 6 6 18" />, p);

export const RefreshIcon = (p: IconProps) =>
  base(
    <>
      <path d="M20 12a8 8 0 0 1-14.3 4.9" />
      <path d="M4 12a8 8 0 0 1 14.3-4.9" />
      <path d="M18.5 3v4.5H14M5.5 21v-4.5H10" />
    </>,
    p,
  );

export const ArrowRightIcon = (p: IconProps) =>
  base(
    <>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </>,
    p,
  );

export const MonitorIcon = (p: IconProps) =>
  base(
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>,
    p,
  );

export const CameraIcon = (p: IconProps) =>
  base(
    <>
      <rect x="2.5" y="6.5" width="13" height="11" rx="2" />
      <path d="m15.5 10.5 6-3.5v10l-6-3.5" />
    </>,
    p,
  );

export const MoveIcon = (p: IconProps) =>
  base(
    <>
      <path d="M12 3v18M3 12h18" />
      <path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />
    </>,
    p,
  );

/** Small coloured status dot (inherits text colour), filled when on. */
export function StatusDot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 shrink-0 rounded-full border border-current ${on ? "bg-current" : ""}`}
    />
  );
}
