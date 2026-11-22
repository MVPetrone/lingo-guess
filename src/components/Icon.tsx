// Hand-drawn 24×24 stroke icons. Decorative: every caller pairs them with text,
// so they are always aria-hidden. Colour comes from `currentColor`.

const PATHS = {
  play: <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none" />,
  replay: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4.5 4.5v4h4" />
    </>
  ),
  arrow: <path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  cross: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  dash: <path d="M6 12h12" />,
  chevron: <path d="M9.5 6l6 6-6 6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </>
  ),
  share: (
    <>
      <path d="M12 15V4M7.5 8.5L12 4l4.5 4.5" />
      <path d="M5 13v5.5h14V13" />
    </>
  ),
  /** The aperture motif, small: a dot inside two arcs. Used as the "fact" glyph. */
  aperture: (
    <>
      <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
      <path d="M8.2 8.2a5.4 5.4 0 0 1 7.6 0M15.8 15.8a5.4 5.4 0 0 1-7.6 0" />
      <path d="M5.1 5.1a9.8 9.8 0 0 1 13.8 0M18.9 18.9a9.8 9.8 0 0 1-13.8 0" opacity=".55" />
    </>
  ),
  warn: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4.5M12 17.2v.3" />
    </>
  ),
  heart: (
    <path
      d="M12 19.5s-7.5-4.6-7.5-10.1A4.1 4.1 0 0 1 12 7a4.1 4.1 0 0 1 7.5 2.4c0 5.5-7.5 10.1-7.5 10.1z"
      fill="currentColor"
    />
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5z" />
    </>
  ),
  keyboard: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M10.3 10h.01M13.7 10h.01M17 10h.01M8 14h8" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M15.5 5.6a3 3 0 0 1 0 5.8M17.5 14.2a5.5 5.5 0 0 1 3 4.8" />
    </>
  ),
  star: <path d="M12 4l2.4 5 5.4.7-4 3.7 1 5.4-4.8-2.6-4.8 2.6 1-5.4-4-3.7 5.4-.7z" />,
  /** Two dashes: a clip's length, drawn as a line of speech. */
  'short-clips': <path d="M5 9.5h14M5 14.5h9" />,
  'plus-circle': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8.5v7M8.5 12h7" />
    </>
  ),
  /** Two offset squares: languages that look like each other. */
  'look-alikes': (
    <>
      <rect x="4" y="8.5" width="11.5" height="11.5" rx="2" />
      <path d="M8.5 4h9.5a2 2 0 0 1 2 2v9.5" />
    </>
  ),
  diamond: <path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z" />,
  choices: <path d="M9.5 7H20M9.5 12H20M9.5 17H20M4.5 7h.01M4.5 12h.01M4.5 17h.01" />,
  speed: <path d="M5.5 6l6 6-6 6M12.5 6l6 6-6 6" />,
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.3 12.4l2.6 2.6 4.8-5.2" />
    </>
  ),
  trophy: (
    <>
      <path d="M8 4.5h8v4.5a4 4 0 0 1-8 0z" />
      <path d="M8 6.5H5.5a2.6 2.6 0 0 0 3 3.6M16 6.5h2.5a2.6 2.6 0 0 1-3 3.6" />
      <path d="M12 13v4M8.5 20h7M9.5 17h5" />
    </>
  ),
  speaker: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      <path d="M15.5 9.2a4 4 0 0 1 0 5.6M18 6.7a7.5 7.5 0 0 1 0 10.6" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </>
  ),
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
