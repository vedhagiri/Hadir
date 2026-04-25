// Icon set — literal port of frontend/src/design/icons.jsx into TypeScript.
// The path data is copied verbatim from the design archive; only the React
// shape changes (typed props + export). Do not edit stroke data or add new
// icons without touching the design reference first.

import type { CSSProperties, ReactNode } from "react";

const paths: Record<string, ReactNode> = {
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
