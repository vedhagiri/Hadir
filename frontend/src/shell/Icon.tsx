// Icon set — literal port of frontend/src/design/icons.jsx into TypeScript.
// The path data is copied verbatim from the design archive; only the React
// shape changes (typed props + export). Do not edit stroke data or add new
// icons without touching the design reference first.

import type { CSSProperties } from "react";

// NOTE: do NOT type this as ``Record<string, ReactNode>`` — that
// collapses ``keyof typeof paths`` to ``string``, which silently
// accepts any name at the ``<Icon name="…">`` call site and falls
// back to a circle on render (the bug found during P28.5c
// validation: Live Capture buttons looked icon-less because
// "play" / "pause" / "refresh" / "filter" / "download" weren't
// defined here but TypeScript didn't catch it). With ``as const``
// stripped off and the explicit Record type removed,
// ``IconName = keyof typeof paths`` resolves to the literal union
// of every key below — typecheck rejects unknown names.
const paths = {
  home: (
    <>
      <path d="M3 12 12 4l9 8" />
      <path d="M5 10v10h14V10" />
    </>
  ),
  camera: (
    <>
      <rect x="3" y="6" width="18" height="14" rx="2" />
      <circle cx="12" cy="13" r="4" />
      <path d="M8 6l2-2h4l2 2" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M15 20v-.5c0-2 1.6-3.5 3.5-3.5H19" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.3 3.1-6 7-6s7 2.7 7 6" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 13l3-8h12l3 8" />
      <path d="M3 13v6a1 1 0 001 1h16a1 1 0 001-1v-6" />
      <path d="M3 13h5l1 3h6l1-3h5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1A1.7 1.7 0 008 19.4a1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H2a2 2 0 010-4h.1A1.7 1.7 0 003.6 8 1.7 1.7 0 003.3 6.2l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H8a1.7 1.7 0 001-1.5V2a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V8a1.7 1.7 0 001.5 1H22a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </>
  ),
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronUp: <path d="M6 15l6-6 6 6" />,
  chevronsUpDown: <path d="M7 9l5-5 5 5M7 15l5 5 5-5" />,
  shield: <path d="M12 3l8 3v6c0 4-3.5 7.5-8 9-4.5-1.5-8-5-8-9V6l8-3z" />,
  clipboard: (
    <>
      <rect x="6" y="4" width="12" height="17" rx="1" />
      <path d="M9 4V3a1 1 0 011-1h4a1 1 0 011 1v1" />
      <path d="M9 11h6M9 15h4" />
    </>
  ),
  fileText: (
    <>
      <path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9l-6-6z" />
      <path d="M14 3v6h6M8 13h8M8 17h5" />
    </>
  ),
  upload: <path d="M12 16V4M7 9l5-5 5 5M4 21h16" />,
  logout: (
    <>
      <path d="M10 3H4v18h6M16 17l5-5-5-5M21 12H9" />
    </>
  ),
  activity: <path d="M3 12h4l3-9 4 18 3-9h4" />,
  sparkles: (
    <>
      <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5zM19 14l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2zM5 15l.7 1.4 1.4.6-1.4.6L5 19l-.7-1.4L3 17l1.3-.6.7-1.4z" />
    </>
  ),
  check: <path d="M5 12l5 5L20 6" />,
  circle: <circle cx="12" cy="12" r="4" />,
  // P22 + back-fill of icons referenced elsewhere in the tree.
  // Path data ported verbatim from frontend/src/design/icons.jsx.
  bell: (
    <>
      <path d="M18 16v-5a6 6 0 10-12 0v5l-2 2h16l-2-2z" />
      <path d="M10 21a2 2 0 004 0" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M6 6l12 12M6 18L18 6" />,
  moon: <path d="M21 13a9 9 0 11-10-10 7 7 0 0010 10z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5" />
    </>
  ),
  // ``maximize`` here is the design's chosen "comfortable" affordance —
  // a wide rectangle of negative space — and ``minimize`` is the
  // tighter "compact" counterpart. Path data borrowed from the design
  // archive's ``rectFill``-style stroke set.
  maximize: (
    <>
      <path d="M3 9V5a2 2 0 012-2h4M21 9V5a2 2 0 00-2-2h-4" />
      <path d="M3 15v4a2 2 0 002 2h4M21 15v4a2 2 0 01-2 2h-4" />
    </>
  ),
  minimize: (
    <>
      <path d="M9 3H5a2 2 0 00-2 2v4M15 3h4a2 2 0 012 2v4" />
      <path d="M9 21H5a2 2 0 01-2-2v-4M15 21h4a2 2 0 002-2v-4" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 7.5v.01" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" />
    </>
  ),

  // P28.5c follow-up: icons used across the app that were silently
  // falling back to ``circle`` because they hadn't been ported from
  // the design archive yet. Path data copied verbatim from
  // ``frontend/src/design/icons.jsx``.
  play: <path d="M7 4v16l14-8L7 4z" />,
  pause: (
    <>
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 01-13.7 5.7L3 15M4 12a8 8 0 0113.7-5.7L21 9" />
      <path d="M3 9V4M21 20v-5M21 15h-5M3 4h5" />
    </>
  ),
  filter: <path d="M4 5h16l-6 8v6l-4-2v-4L4 5z" />,
  download: <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />,
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 113 3L7 19l-4 1 1-4L16.5 3.5z" />
    </>
  ),
  trash: (
    <path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M5 6l1 14a2 2 0 002 2h8a2 2 0 002-2l1-14M10 11v6M14 11v6" />
  ),
  excel: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M8 8l8 8M16 8l-8 8" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </>
  ),
  send: <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />,
  zap: <path d="M13 2L4 14h8l-1 8 9-12h-8l1-8z" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="19" cy="12" r="1.3" />
    </>
  ),
  moreVertical: (
    <>
      <circle cx="12" cy="5" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="12" cy="19" r="1.3" />
    </>
  ),
  menu: (
    <>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </>
  ),
  chevronLeft: <path d="M15 6l-6 6 6 6" />,
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v6c0 1.7 4 3 9 3s9-1.3 9-3V5M3 11v6c0 1.7 4 3 9 3s9-1.3 9-3v-6" />
    </>
  ),
};

export type IconName = keyof typeof paths;

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
  style?: CSSProperties;
}

export function Icon({
  name,
  size = 14,
  className = "",
  strokeWidth = 1.5,
  style,
}: IconProps) {
  // P21: stamp ``icon-<kebabName>`` so the RTL CSS sweep can flip
  // direction-bearing icons (chevrons, arrows) without component-
  // level branching. ``chevronRight`` → ``icon-chevron-right``.
  const kebab = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const finalClass = `${className} icon-${kebab}`.trim();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={finalClass}
      style={style}
    >
      {paths[name] ?? paths.circle}
    </svg>
  );
}
