// Account sync: the archive and the daily record travel as one versioned JSON
// blob, and every merge happens here, on the client. Pure and framework-free.
// The rules only ever add: a day on either side survives, a conflict on the
// same day keeps the better result, and the streak is recomputed from the
// union rather than trusted from either side.
import { ARCHIVE_CAP, emptyArchive, parseArchive, type Archive, type DayStamp } from './archive.ts'
import {
  DAILY_RESULTS_CAP,
  parseDailyRecord,
  previousDateKey,
  type DailyRecord,
  type DailyResult,
} from './daily.ts'
import type { LangCode } from '../data/languages.ts'

/** Bumped when the payload's shape changes; older clients refuse to overwrite a newer one. */
export const SYNC_VERSION = 1

export interface SyncPayload {
  archive: Archive
  daily: DailyRecord | null
}

export function emptyPayload(): SyncPayload {
  return { archive: emptyArchive(), daily: null }
}

// ---- ordering -------------------------------------------------------------------

/**
 * Positive when `a` should win over `b`. A total order — the serialised form
 * is the last tiebreak — so merge(a, b) and merge(b, a) always pick the same
 * value and the merge is commutative.
 */
function compareBy(a: unknown, b: unknown, keys: readonly number[]): number {
  for (const k of keys) if (k !== 0) return k
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  return sa === sb ? 0 : sa > sb ? 1 : -1
}

function stampOrder(a: DayStamp, b: DayStamp): number {
  return compareBy(a, b, [a.score - b.score, a.correct - b.correct, a.languages.length - b.languages.length, a.streak - b.streak])
}

type Day = { result: DailyResult; languages: LangCode[] | undefined }

function dayOrder(a: Day, b: Day): number {
  return compareBy(a, b, [
    a.result.score - b.result.score,
    a.result.correct - b.result.correct,
    (a.languages?.length ?? 0) - (b.languages?.length ?? 0),
    Number(a.result.grid !== undefined) - Number(b.result.grid !== undefined),
  ])
}

// ---- archive --------------------------------------------------------------------

/**
 * Both archives' days. Where both hold a date, the higher score wins (then
 * more correct, then more languages recorded). No day on either side is
 * dropped, short of the archive's own cap of ARCHIVE_CAP newest days.
 */
export function mergeArchives(a: Archive, b: Archive): Archive {
  const stamps: Record<string, DayStamp> = { ...a.stamps }
  for (const [date, theirs] of Object.entries(b.stamps)) {
    const ours = stamps[date]
    stamps[date] = !ours || stampOrder(theirs, ours) > 0 ? theirs : ours
  }
  const kept = Object.keys(stamps).sort().slice(-ARCHIVE_CAP)
  return { v: 2, stamps: Object.fromEntries(kept.map((d) => [d, stamps[d] as DayStamp])), firstDate: kept[0] ?? '' }
}

/** Dates `local` holds that `remote` does not: what "bring your N days" counts. */
export function localOnlyDays(local: Archive, remote: Archive): string[] {
  return Object.keys(local.stamps)
    .filter((d) => !remote.stamps[d])
    .sort()
}

// ---- daily ----------------------------------------------------------------------

/** Length of the run of consecutive days in `days` that ends on `last`. */
function runEndingOn(days: ReadonlySet<string>, last: string): number {
  let n = 0
  for (let d = last; days.has(d); d = previousDateKey(d)) n++
  return n
}

/**
 * Both records' results, one per date, the better result winning. `lastDate`
 * and `streak` are recomputed from the merged days plus `archive`'s stamps
 * (an imported or synced stamp counts even where no result was kept);
 * a record's own streak still counts when it ends on the merged `lastDate`,
 * since it may reach back past the results kept. `best` never goes down.
 */
export function mergeDaily(a: DailyRecord | null, b: DailyRecord | null, archive: Archive = emptyArchive()): DailyRecord | null {
  if (!a || !b) {
    const only = a ?? b
    if (!only) return null
    // One side only: still recompute, so a record that lags the stamps catches up.
    return mergeDaily(only, { ...only }, archive)
  }

  const days = new Map<string, Day>()
  for (const rec of [a, b]) {
    for (const [date, result] of Object.entries(rec.results)) {
      const candidate: Day = { result, languages: rec.languages[date] }
      const held = days.get(date)
      if (!held) {
        days.set(date, candidate)
        continue
      }
      const [win, lose] = dayOrder(candidate, held) > 0 ? [candidate, held] : [held, candidate]
      // The daily is the same for everyone on a date, so the loser's
      // languages are right for the winner's day if the winner has none.
      days.set(date, { result: win.result, languages: win.languages ?? lose.languages })
    }
  }

  const kept = [...days.keys()].sort().slice(-DAILY_RESULTS_CAP)
  const played = new Set([...kept, ...Object.keys(archive.stamps)])
  const lastDate = [a.lastDate, b.lastDate, ...played].reduce((m, d) => (d > m ? d : m))
  const streak = Math.max(
    runEndingOn(played, lastDate),
    a.lastDate === lastDate ? a.streak : 0,
    b.lastDate === lastDate ? b.streak : 0,
    archive.stamps[lastDate]?.streak ?? 0,
  )

  return {
    lastDate,
    streak,
    best: Math.max(a.best, b.best, streak),
    results: Object.fromEntries(kept.map((d) => [d, (days.get(d) as Day).result])),
    languages: Object.fromEntries(
      kept.flatMap((d) => {
        const langs = (days.get(d) as Day).languages
        return langs ? [[d, langs]] : []
      }),
    ),
  }
}

/** The whole payload: archives first, then the daily record against the merged stamps. */
export function mergeAll(local: SyncPayload, remote: SyncPayload): SyncPayload {
  const archive = mergeArchives(local.archive, remote.archive)
  return { archive, daily: mergeDaily(local.daily, remote.daily, archive) }
}

// ---- wire format ------------------------------------------------------------------

export function serialize(archive: Archive, daily: DailyRecord | null): string {
  return JSON.stringify({ v: SYNC_VERSION, archive, daily })
}

let warned = false

function unreadable(why: string): SyncPayload {
  if (!warned) {
    warned = true
    console.warn(`Lingo Guess sync: ignoring unreadable account data (${why}).`)
  }
  return emptyPayload()
}

/**
 * The account's blob as a payload. Null (a player who never synced) is
 * empty; anything malformed is also treated as empty and logged once.
 * Never throws: bad remote data must not take the archive screen down.
 */
export function parse(raw: string | null): SyncPayload {
  if (raw === null || raw === '') return emptyPayload()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return unreadable('not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return unreadable('not an object')
  const { v, archive, daily } = parsed as Record<string, unknown>
  if (v !== SYNC_VERSION) return unreadable(`version ${String(v)}`)
  const stamps = parseArchive(archive)
  if (!stamps) return unreadable('archive')
  if (daily === null || daily === undefined) return { archive: stamps, daily: null }
  const record = parseDailyRecord(daily)
  return record ? { archive: stamps, daily: record } : unreadable('daily record')
}

/**
 * True when the blob was written by a newer client. Its contents read as
 * empty here, so pushing over it would erase them: the caller pauses sync.
 */
export function isNewerVersion(raw: string | null): boolean {
  if (!raw) return false
  try {
    const v = (JSON.parse(raw) as { v?: unknown } | null)?.v
    return typeof v === 'number' && v > SYNC_VERSION
  } catch {
    return false
  }
}
