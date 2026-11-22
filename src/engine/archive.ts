// The Daily Archive: one permanent stamp per completed Daily Challenge,
// recording the score and the languages heard that day. Pure and
// framework-free; storage.ts persists it. All date maths works on
// `YYYY-MM-DD` keys in UTC (the keys are already London days), never on
// local-time Date getters, so DST and the player's zone cannot shift a day.
import { LANGUAGES, type LangCode } from '../data/languages.ts'
import { previousDateKey, type DailyRecord } from './daily.ts'

/** Stamps kept at most (over two years); the oldest are dropped first. */
export const ARCHIVE_CAP = 800

export interface DayStamp {
  /** `YYYY-MM-DD`, London. */
  date: string
  score: number
  correct: number
  total: number
  /** Languages played, in round order; empty for days recorded before v2. */
  languages: LangCode[]
  /** The streak as it stood on that day. */
  streak: number
}

export interface Archive {
  v: 2
  stamps: Record<string, DayStamp>
  /** Earliest stamped day; '' while the archive is empty. */
  firstDate: string
}

export function emptyArchive(): Archive {
  return { v: 2, stamps: {}, firstDate: '' }
}

/** A real calendar day as `YYYY-MM-DD` (rejects `2026-02-30`). */
export function isDateKey(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === s
}

/**
 * The stamp for `date`, read from the daily record. The record is expected
 * to hold that day already (callers stamp right after recording it); a
 * missing day reads as zero rather than throwing.
 */
export function stampFromDaily(date: string, record: DailyRecord, languages: LangCode[], streak: number): DayStamp {
  const r = record.results[date]
  return {
    date,
    score: r?.score ?? 0,
    correct: r?.correct ?? 0,
    total: r?.total ?? 0,
    languages: [...languages],
    streak,
  }
}

/**
 * Adds a day. A date that is already stamped is left alone (and the same
 * archive returned), matching `recordDailyResult`: finishing twice never
 * rewrites the day.
 */
export function addStamp(archive: Archive, stamp: DayStamp): Archive {
  if (archive.stamps[stamp.date]) return archive
  const kept = Object.keys(archive.stamps).concat(stamp.date).sort().slice(-ARCHIVE_CAP)
  const all: Record<string, DayStamp> = { ...archive.stamps, [stamp.date]: stamp }
  return { v: 2, stamps: Object.fromEntries(kept.map((d) => [d, all[d] as DayStamp])), firstDate: kept[0] ?? '' }
}

// ---- calendar -----------------------------------------------------------------

/** `year` and `month` (1–12) to `YYYY-MM-DD` for `day`. */
export function dateKeyOf(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10)
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * The month's day keys laid out Monday-first: leading nulls up to the first
 * day's weekday, trailing nulls to fill the last week, so the length is a
 * multiple of 7.
 */
export function monthDates(year: number, month: number): (string | null)[] {
  // getUTCDay: 0 = Sunday. Shift so Monday = 0.
  const lead = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7
  const days = Array.from({ length: daysInMonth(year, month) }, (_, i) => dateKeyOf(year, month, i + 1))
  const cells: (string | null)[] = [...Array<null>(lead).fill(null), ...days]
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

/** `monthDates` with each day replaced by its stamp, or null if unplayed or padding. */
export function monthGrid(archive: Archive, year: number, month: number): (DayStamp | null)[] {
  return monthDates(year, month).map((d) => (d ? (archive.stamps[d] ?? null) : null))
}

function stampsIn(archive: Archive, year: number, month: number): DayStamp[] {
  const prefix = dateKeyOf(year, month, 1).slice(0, 8)
  return Object.keys(archive.stamps)
    .filter((d) => d.startsWith(prefix))
    .sort()
    .map((d) => archive.stamps[d] as DayStamp)
}

/** Distinct languages across `stamps`, in order of first appearance. */
function distinct(stamps: readonly DayStamp[]): LangCode[] {
  return [...new Set(stamps.flatMap((s) => s.languages))]
}

export interface MonthSummary {
  daysPlayed: number
  distinctLanguages: number
  /** Distinct languages heard that month, first heard first. */
  languages: LangCode[]
  /** 0 for a month with no stamps. */
  bestScore: number
}

export function monthSummary(archive: Archive, year: number, month: number): MonthSummary {
  const stamps = stampsIn(archive, year, month)
  const languages = distinct(stamps)
  return {
    daysPlayed: stamps.length,
    distinctLanguages: languages.length,
    languages,
    bestScore: stamps.reduce((best, s) => Math.max(best, s.score), 0),
  }
}

/** Every distinct language ever stamped, oldest first (newest last). */
export function collectedLanguages(archive: Archive): LangCode[] {
  return distinct(
    Object.keys(archive.stamps)
      .sort()
      .map((d) => archive.stamps[d] as DayStamp),
  )
}

/**
 * The live streak as of `today`, recomputed from the stamps by walking back
 * one day at a time. A streak is still alive until the end of the day after
 * its last stamp, as in `currentStreak`. The daily record's own `lastDate` is
 * not consulted: an import or a lost write could leave it out of step.
 */
export function archiveStreak(archive: Archive, today: string): number {
  let day = archive.stamps[today] ? today : previousDateKey(today)
  let n = 0
  while (archive.stamps[day]) {
    n++
    day = previousDateKey(day)
  }
  return n
}

// ---- export / import ------------------------------------------------------------

export function exportJson(archive: Archive): string {
  return JSON.stringify(archive, null, 2)
}

const ROSTER = new Set<string>(LANGUAGES.map((l) => l.code))
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

function parseStamp(key: string, value: unknown): DayStamp | null {
  if (!isDateKey(key) || typeof value !== 'object' || value === null) return null
  const { date, score, correct, total, languages, streak } = value as Record<string, unknown>
  if (date !== key || !isCount(score) || !isCount(correct) || !isCount(total) || !isCount(streak)) return null
  if (correct > total) return null
  if (!Array.isArray(languages) || !languages.every((c) => typeof c === 'string' && ROSTER.has(c))) return null
  return { date: key, score, correct, total, languages: [...(languages as LangCode[])], streak }
}

/**
 * Parses an exported archive. Anything off — bad JSON, wrong version, a
 * malformed date, an unknown language code — rejects the whole file with
 * null: a half-imported record would be worse than none. Never throws.
 */
export function importJson(raw: string): Archive | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const { v, stamps } = parsed as Record<string, unknown>
    if (v !== 2 || typeof stamps !== 'object' || stamps === null || Array.isArray(stamps)) return null
    let archive = emptyArchive()
    for (const [key, value] of Object.entries(stamps)) {
      const stamp = parseStamp(key, value)
      if (!stamp) return null
      archive = addStamp(archive, stamp)
    }
    return archive
  } catch {
    return null
  }
}

/** Both archives' days; where both hold a date, `base` keeps its own. */
export function mergeArchives(base: Archive, extra: Archive): Archive {
  return Object.values(extra.stamps).reduce(addStamp, base)
}
