import { afterEach, describe, expect, it, vi } from 'vitest'
import { LANGUAGES, type LangCode } from '../../src/data/languages.ts'
import { addStamp, emptyArchive, type Archive, type DayStamp } from '../../src/engine/archive.ts'
import { previousDateKey, recordDailyResult, type DailyRecord } from '../../src/engine/daily.ts'
import {
  SYNC_VERSION,
  emptyPayload,
  isNewerVersion,
  localOnlyDays,
  mergeAll,
  mergeArchives,
  mergeDaily,
  parse,
  serialize,
} from '../../src/engine/syncMerge.ts'

const codes = (n: number, offset = 0): LangCode[] => Array.from({ length: n }, (_, i) => LANGUAGES[(i + offset) % LANGUAGES.length]!.code)

function stamp(date: string, score: number, extra: Partial<DayStamp> = {}): DayStamp {
  return { date, score, correct: Math.min(10, Math.round(score / 100)), total: 10, languages: codes(10), streak: 1, ...extra }
}

function archiveOf(...stamps: DayStamp[]): Archive {
  return stamps.reduce(addStamp, emptyArchive())
}

/** `n` consecutive days ending on `last`. */
function days(last: string, n: number): string[] {
  const out: string[] = []
  for (let d = last, i = 0; i < n; i++, d = previousDateKey(d)) out.unshift(d)
  return out
}

function recordOf(dates: string[], score = 500): DailyRecord {
  return dates.reduce<DailyRecord | null>(
    (rec, d) => recordDailyResult(rec, d, { score, correct: 5, total: 10, languages: codes(10) }),
    null,
  ) as DailyRecord
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('mergeArchives', () => {
  const a = archiveOf(stamp('2026-11-01', 300), stamp('2026-11-02', 900), stamp('2026-11-05', 100))
  const b = archiveOf(stamp('2026-11-02', 400), stamp('2026-11-03', 700), stamp('2026-11-05', 100, { streak: 4 }))

  it('is commutative', () => {
    expect(mergeArchives(a, b)).toEqual(mergeArchives(b, a))
    expect(JSON.stringify(mergeArchives(a, b))).toBe(JSON.stringify(mergeArchives(b, a)))
  })

  it('is idempotent and associative', () => {
    const c = archiveOf(stamp('2026-11-02', 950), stamp('2026-10-30', 10))
    expect(mergeArchives(a, a)).toEqual(a)
    expect(mergeArchives(mergeArchives(a, b), c)).toEqual(mergeArchives(a, mergeArchives(b, c)))
  })

  it('keeps the higher score for a day both sides hold', () => {
    expect(mergeArchives(a, b).stamps['2026-11-02']!.score).toBe(900)
    expect(mergeArchives(b, a).stamps['2026-11-02']!.score).toBe(900)
  })

  it('breaks a score tie deterministically (longer streak wins here)', () => {
    expect(mergeArchives(a, b).stamps['2026-11-05']!.streak).toBe(4)
    expect(mergeArchives(b, a).stamps['2026-11-05']!.streak).toBe(4)
  })

  it('never drops a local day, whatever the remote holds', () => {
    const merged = mergeArchives(a, emptyArchive())
    expect(merged).toEqual(a)
    for (const date of Object.keys(a.stamps)) expect(mergeArchives(a, b).stamps[date]).toBeDefined()
    expect(Object.keys(mergeArchives(a, b).stamps)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-05'])
  })

  it('recomputes firstDate and keeps keys in date order', () => {
    const merged = mergeArchives(b, archiveOf(stamp('2026-10-01', 1)))
    expect(merged.firstDate).toBe('2026-10-01')
    expect(Object.keys(merged.stamps)).toEqual([...Object.keys(merged.stamps)].sort())
  })

  it('counts local-only days for the import offer', () => {
    expect(localOnlyDays(a, b)).toEqual(['2026-11-01'])
    expect(localOnlyDays(a, emptyArchive())).toHaveLength(3)
    expect(localOnlyDays(emptyArchive(), b)).toEqual([])
  })
})

describe('mergeDaily', () => {
  it('unions results and is commutative', () => {
    const a = recordOf(['2026-11-01', '2026-11-02'])
    const b = recordOf(['2026-11-04'])
    const ab = mergeDaily(a, b)
    expect(ab).toEqual(mergeDaily(b, a))
    expect(Object.keys(ab!.results)).toEqual(['2026-11-01', '2026-11-02', '2026-11-04'])
  })

  it('keeps the better result for a day on both sides, with its languages', () => {
    const a = recordOf(['2026-11-01'], 200)
    const b = recordOf(['2026-11-01'], 800)
    expect(mergeDaily(a, b)!.results['2026-11-01']!.score).toBe(800)
    expect(mergeDaily(b, a)!.results['2026-11-01']!.score).toBe(800)
    // The winner lacked languages (a v1 day): the other side's are kept.
    const bare = { ...b, languages: {} }
    expect(mergeDaily(a, bare)!.languages['2026-11-01']).toEqual(codes(10))
    expect(mergeDaily(bare, a)!.languages['2026-11-01']).toEqual(codes(10))
  })

  it('recomputes lastDate and streak across both devices', () => {
    // Phone played the 1st-3rd, laptop the 4th-5th: one five-day streak.
    const phone = recordOf(days('2026-11-03', 3))
    const laptop = recordOf(days('2026-11-05', 2))
    expect(laptop.streak).toBe(2)
    const merged = mergeDaily(phone, laptop)!
    expect(merged.lastDate).toBe('2026-11-05')
    expect(merged.streak).toBe(5)
    expect(merged.best).toBe(5)
    expect(mergeDaily(laptop, phone)).toEqual(merged)
  })

  it('a gap restarts the streak, and best never goes down', () => {
    const old = { ...recordOf(days('2026-10-10', 3)), best: 12 }
    const recent = recordOf(['2026-11-05'])
    const merged = mergeDaily(old, recent)!
    expect(merged.streak).toBe(1)
    expect(merged.best).toBe(12)
  })

  it('counts archive stamps without a kept result toward the streak', () => {
    const rec = recordOf(['2026-11-05'])
    const archive = archiveOf(...days('2026-11-04', 3).map((d) => stamp(d, 100)))
    expect(mergeDaily(rec, null, archive)!.streak).toBe(4)
    expect(mergeDaily(null, rec, archive)!.streak).toBe(4)
  })

  it('honours a record streak longer than the results it kept', () => {
    const rec = { ...recordOf(['2026-11-05']), streak: 70, best: 70 }
    expect(mergeDaily(rec, recordOf(['2026-11-01']))!.streak).toBe(70)
  })

  it('null and null stays null', () => {
    expect(mergeDaily(null, null)).toBeNull()
  })
})

describe('mergeAll', () => {
  const local = { archive: archiveOf(...days('2026-11-03', 3).map((d) => stamp(d, 300))), daily: recordOf(days('2026-11-03', 3), 300) }
  const remote = { archive: archiveOf(...days('2026-11-05', 3).map((d) => stamp(d, 600))), daily: recordOf(days('2026-11-05', 3), 600) }

  it('is commutative for the whole payload', () => {
    const wire = (p: { archive: Archive; daily: DailyRecord | null }) => serialize(p.archive, p.daily)
    expect(wire(mergeAll(local, remote))).toBe(wire(mergeAll(remote, local)))
  })

  it('keeps every local day, the higher score on overlap, and one recomputed streak', () => {
    const merged = mergeAll(local, remote)
    expect(Object.keys(merged.archive.stamps)).toEqual(days('2026-11-05', 5))
    expect(merged.archive.stamps['2026-11-03']!.score).toBe(600)
    expect(merged.daily!.streak).toBe(5)
  })

  it('merging with an empty account changes nothing', () => {
    expect(mergeAll(local, emptyPayload())).toEqual(local)
  })
})

describe('serialize / parse', () => {
  const archive = archiveOf(stamp('2026-11-01', 300), stamp('2026-11-02', 900))
  const daily = recordOf(['2026-11-01', '2026-11-02'])

  it('round-trips with a version field', () => {
    const raw = serialize(archive, daily)
    expect(JSON.parse(raw).v).toBe(SYNC_VERSION)
    expect(parse(raw)).toEqual({ archive, daily })
    expect(parse(serialize(archive, null))).toEqual({ archive, daily: null })
  })

  it('reads a player who never synced as empty, without a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parse(null)).toEqual(emptyPayload())
    expect(parse('')).toEqual(emptyPayload())
    expect(warn).not.toHaveBeenCalled()
  })

  it('treats malformed remote payloads as empty, never throws, and logs once', async () => {
    vi.resetModules()
    const fresh = await import('../../src/engine/syncMerge.ts')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bad = [
      '{not json',
      '[]',
      'null',
      '"a string"',
      JSON.stringify({ archive: { v: 2, stamps: {} } }),
      JSON.stringify({ v: SYNC_VERSION, archive: { v: 2, stamps: { 'not-a-date': {} } }, daily: null }),
      JSON.stringify({ v: SYNC_VERSION, archive: { v: 2, stamps: {} }, daily: { lastDate: 'nope' } }),
      JSON.stringify({ v: SYNC_VERSION, archive: null, daily: null }),
      JSON.stringify({ v: SYNC_VERSION + 1, archive: { v: 2, stamps: {} }, daily: null }),
    ]
    for (const raw of bad) {
      expect(() => fresh.parse(raw)).not.toThrow()
      expect(fresh.parse(raw)).toEqual(fresh.emptyPayload())
    }
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('flags a payload written by a newer client', () => {
    expect(isNewerVersion(JSON.stringify({ v: SYNC_VERSION + 1 }))).toBe(true)
    expect(isNewerVersion(serialize(archive, daily))).toBe(false)
    expect(isNewerVersion(null)).toBe(false)
    expect(isNewerVersion('{garbage')).toBe(false)
  })
})
