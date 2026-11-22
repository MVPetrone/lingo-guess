import {
  addStamp,
  emptyArchive,
  exportJson,
  importJson,
  mergeArchives,
  stampFromDaily,
  type Archive,
} from './engine/archive.ts'
import { parseDailyRecord, previousDateKey, type DailyRecord } from './engine/daily.ts'

// localStorage can be disabled, full, or throw on access (Safari private mode,
// sandboxed iframes, blocked cookies). Every call here degrades to "no value".
const BEST_KEY = 'gtl:bestScore'

export function loadBestScore(): number | null {
  try {
    const raw = window.localStorage.getItem(BEST_KEY)
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}

export function saveBestScore(score: number): void {
  try {
    window.localStorage.setItem(BEST_KEY, String(score))
  } catch {
    // Not persisted; the in-memory best for this session still works.
  }
}

const HEARD_KEY = 'gtl:heard'
/** Recently heard clip keys kept across games; oldest are dropped first. */
export const HEARD_CAP = 400

/** Clip keys (`code|voice|sentence`) heard in earlier games, oldest first. */
export function loadHeard(): string[] {
  try {
    const raw = window.localStorage.getItem(HEARD_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((k): k is string => typeof k === 'string').slice(-HEARD_CAP)
  } catch {
    return []
  }
}

export function saveHeard(keys: readonly string[]): void {
  try {
    window.localStorage.setItem(HEARD_KEY, JSON.stringify(keys.slice(-HEARD_CAP)))
  } catch {
    // Not persisted; the game still avoids repeats within a game.
  }
}

/** `keys` with `key` moved to the newest end, capped at `HEARD_CAP`. */
export function appendHeard(keys: readonly string[], key: string): string[] {
  return [...keys.filter((k) => k !== key), key].slice(-HEARD_CAP)
}

const KNOWN_KEY = 'gtl:known'

/**
 * Codes of the languages the player said they know, or null if they have
 * never been asked (or storage is unavailable, in which case they are asked
 * again on the next visit).
 */
export function loadKnown(): string[] | null {
  try {
    const raw = window.localStorage.getItem(KNOWN_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : null
  } catch {
    return null
  }
}

export function saveKnown(codes: readonly string[]): void {
  try {
    window.localStorage.setItem(KNOWN_KEY, JSON.stringify(codes))
  } catch {
    // Not persisted; the choice still applies for this session.
  }
}

/** v1 is read-only legacy: read once to migrate, then left in place untouched. */
const DAILY_KEY_V1 = 'lingo.daily.v1'
/** v2 adds `languages`, the languages heard each day. */
const DAILY_KEY = 'lingo.daily.v2'

/**
 * The Daily Challenge record, or null if none is stored or it is unreadable.
 * A v1 record is migrated on first read (no languages for its days) and
 * written back as v2.
 */
export function loadDaily(): DailyRecord | null {
  try {
    const raw = window.localStorage.getItem(DAILY_KEY)
    if (raw !== null) return parseDailyRecord(JSON.parse(raw))
    const legacy = window.localStorage.getItem(DAILY_KEY_V1)
    if (legacy === null) return null
    const migrated = parseDailyRecord(JSON.parse(legacy))
    if (migrated) saveDaily(migrated)
    return migrated
  } catch {
    return null
  }
}

export function saveDaily(record: DailyRecord): void {
  try {
    window.localStorage.setItem(DAILY_KEY, JSON.stringify(record))
  } catch {
    // Not persisted; today's result still shows for this session.
  }
}

const ARCHIVE_KEY = 'lingo.archive.v1'

/**
 * Stamps for the days the daily record holds but the archive does not: the
 * first load after upgrading builds the archive from existing results, and a
 * stamp whose write failed is recovered next visit. Each day's streak is
 * recomputed from the record's consecutive days; the run ending on
 * `lastDate` also honours the record's own streak, which can be longer than
 * the results kept (v1 kept only 60 days).
 */
export function backfillArchive(archive: Archive, record: DailyRecord | null): Archive {
  if (!record) return archive
  const dates = Object.keys(record.results).sort()
  const streakOn = new Map<string, number>()
  for (const d of dates) streakOn.set(d, (streakOn.get(previousDateKey(d)) ?? 0) + 1)
  for (let d = record.lastDate, k = 0; streakOn.has(d); d = previousDateKey(d), k++) {
    streakOn.set(d, Math.max(streakOn.get(d) ?? 0, record.streak - k))
  }
  return dates.reduce(
    (a, d) => (a.stamps[d] ? a : addStamp(a, stampFromDaily(d, record, record.languages[d] ?? [], streakOn.get(d) ?? 1))),
    archive,
  )
}

/**
 * The archive, filled in from the daily record where it lags behind. An
 * unreadable stored archive is treated as empty and rebuilt from the record
 * rather than left blocking the screen.
 */
export function loadArchive(record: DailyRecord | null): Archive {
  let stored: Archive | null = null
  try {
    const raw = window.localStorage.getItem(ARCHIVE_KEY)
    stored = raw === null ? null : importJson(raw)
  } catch {
    stored = null
  }
  const base = stored ?? emptyArchive()
  const archive = backfillArchive(base, record)
  if (archive !== stored && Object.keys(archive.stamps).length > 0) saveArchive(archive)
  return archive
}

export function saveArchive(archive: Archive): void {
  try {
    window.localStorage.setItem(ARCHIVE_KEY, exportJson(archive))
  } catch {
    // Not persisted; the stamp still shows this session and is rebuilt from
    // the daily record next visit.
  }
}

/** The archive as a JSON file body, for the Export download. */
export function exportArchive(archive: Archive): string {
  return exportJson(archive)
}

/**
 * Merges an exported file into `current` and saves the result. Days already
 * on this device keep their own stamp. Null when the file is not a valid
 * archive; nothing is written in that case.
 */
export function importArchive(current: Archive, raw: string): Archive | null {
  const incoming = importJson(raw)
  if (!incoming) return null
  const merged = mergeArchives(current, incoming)
  saveArchive(merged)
  return merged
}

/** `lingo-archive-2026-11-22.json` / `.png`. */
export function archiveFileName(today: string, ext: 'json' | 'png'): string {
  return `lingo-archive-${today}.${ext}`
}
