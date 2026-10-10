// Small product illustrations for the grid cards: a face + fingerprint
// access terminal. (Camera cards use assets/camera_dome.png.) Pure SVG (no image assets),
// so they render offline and stay crisp at any size.

export function TerminalArt({ size = 76 }: { size?: number }) {
  return (
    <svg width={size * 0.72} height={size} viewBox="0 0 72 100" aria-hidden="true">
      <defs>
        <linearGradient id="tm-body" x1="0" x2="1">
          <stop offset="0" stopColor="#2b3035" />
          <stop offset="0.5" stopColor="#3b4249" />
          <stop offset="1" stopColor="#23272b" />
        </linearGradient>
        <linearGradient id="tm-screen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5b6f86" />
          <stop offset="1" stopColor="#1d2733" />
        </linearGradient>
      </defs>
      <rect x="6" y="2" width="60" height="96" rx="9" fill="url(#tm-body)" />
      <rect x="6.6" y="2.6" width="58.8" height="94.8" rx="8.6" fill="none" stroke="#5a636c" strokeWidth="1" />
      <circle cx="36" cy="9" r="1.8" fill="#11161b" />
      <rect x="14" y="14" width="44" height="30" rx="3" fill="url(#tm-screen)" />
      <path d="M14 30 L58 18 L58 14 L14 14Z" fill="#ffffff" opacity="0.12" />
      {[0, 1, 2].map((r) =>
        [0, 1, 2].map((c) => (
          <rect key={`${r}-${c}`} x={15 + c * 9} y={52 + r * 9} width="6.5" height="6" rx="1.4" fill="#596470" />
        )),
      )}
      <rect x="45" y="54" width="13" height="22" rx="4" fill="#0f1418" />
      <rect x="47.5" y="57" width="8" height="16" rx="3" fill="#2fe07a" opacity="0.9" />
      <rect x="47.5" y="57" width="8" height="16" rx="3" fill="none" stroke="#9cf5c1" strokeWidth="0.6" />
      <rect x="18" y="86" width="36" height="3" rx="1.5" fill="#1a1e22" />
    </svg>
  );
}
