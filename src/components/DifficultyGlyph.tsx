import type { Difficulty } from '../engine/game.ts'

// Bar heights in viewBox units (of 24). More bars, packed tighter in time,
// read as denser speech: 3 / 6 / 9 / 12 for easy → expert.
const HEIGHTS: Record<Difficulty, readonly number[]> = {
  easy: [8, 14, 8],
  normal: [8, 14, 10, 16, 12, 8],
  hard: [6, 12, 18, 10, 20, 14, 8, 16, 10],
  expert: [6, 14, 10, 20, 12, 22, 8, 18, 14, 22, 10, 16],
}

const PITCH = 4

/** A still waveform whose bar count encodes how dense a level's clips are. Decorative. */
export function DifficultyGlyph({ level }: { level: Difficulty }) {
  const heights = HEIGHTS[level]
  const width = heights.length * PITCH
  return (
    <svg
      className="level__glyph"
      viewBox={`0 0 ${width} 24`}
      width={width}
      height="24"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      {heights.map((h, i) => {
        const x = i * PITCH + PITCH / 2
        // Inset by the round cap so the drawn bar is exactly `h` tall.
        return <line key={i} x1={x} x2={x} y1={12 - h / 2 + 1} y2={12 + h / 2 - 1} />
      })}
    </svg>
  )
}
