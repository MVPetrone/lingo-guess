import { afterEach, describe, expect, it } from 'vitest'
import type { LangCode } from '../../src/data/languages.ts'
import { LANGUAGES } from '../../src/data/languages.ts'
import { REGIONS } from '../../src/data/regions.ts'
import {
  ARCHIVE_CAP,
  addStamp,
  archiveStreak,
  collectedLanguages,
  emptyArchive,
  exportJson,
  importJson,
  isDateKey,
  mergeArchives,
  monthDates,
  monthGrid,
  monthSummary,
  stampFromDaily,
  type Archive,
  type DayStamp,
} from '../../src/engine/archive.ts'
import { previousDateKey, recordDailyResult } from '../../src/engine/daily.ts'
import { backfillArchive, importArchive, loadArchive } from '../../src/storage.ts'

const stamp = (date: string, languages: LangCode[] = ['es-ES'], extra: Partial<DayStamp> = {}): DayStamp => ({
  date,
  score: 500,
  correct: 5,
  total: 10,
  languages,
  streak: 1,
  ...extra,
})

const archiveOf = (...stamps: DayStamp[]): Archive => stamps.reduce(addStamp, emptyArchive())

describe('regions', () => {
  it('gives every language a region that has display metadata', () => {
    const ids = new Set(REGIONS.map((r) => r.id))
    for (const l of LANGUAGES) expect(ids.has(l.region), l.code).toBe(true)
    expect(LANGUAGES).toHaveLength(72)
  })

  it('follows the plan’s assignment for a few spot checks', () => {
    const region = (code: LangCode) => LANGUAGES.find((l) => l.code === code)?.region
    expect(region('en-US')).toBe('north-america')
    expect(region('pt-BR')).toBe('latin-america')
    expect(region('mt-MT')).toBe('west-europe')
    expect(region('lt-LT')).toBe('north-europe')
    expect(region('el-GR')).toBe('central-europe')
    expect(region('kk-KZ')).toBe('east-europe')
    expect(region('ps-AF')).toBe('middle-east')
    expect(region('af-ZA')).toBe('east-africa')
    expect(region('uz-UZ')).toBe('south-asia')
    expect(region('mn-MN')).toBe('east-asia')
    expect(region('su-ID')).toBe('southeast-asia')
  })
})

describe('stamps', () => {
  it('builds a stamp from the daily record', () => {
    const rec = recordDailyResult(null, '2026-11-21', { score: 700, correct: 7, total: 10, languages: ['fr-FR'] })
    expect(stampFromDaily('2026-11-21', rec, ['fr-FR', 'de-DE'], 3)).toEqual({
      date: '2026-11-21',
      score: 700,
      correct: 7,
      total: 10,
      languages: ['fr-FR', 'de-DE'],
      streak: 3,
    })
  })

  it('is idempotent per date: the first stamp of a day stands', () => {
    const a = addStamp(emptyArchive(), stamp('2026-11-21'))
    const again = addStamp(a, stamp('2026-11-21', ['ja-JP'], { score: 999 }))
    expect(again).toBe(a)
    expect(a.stamps['2026-11-21']?.score).toBe(500)
    expect(Object.keys(a.stamps)).toHaveLength(1)
  })

  it('tracks the earliest day and keeps stamps sorted', () => {
    const a = archiveOf(stamp('2026-11-21'), stamp('2026-10-03'), stamp('2026-11-01'))
    expect(a.firstDate).toBe('2026-10-03')
    expect(Object.keys(a.stamps)).toEqual(['2026-10-03', '2026-11-01', '2026-11-21'])
  })

  it('caps the archive, dropping the oldest days', () => {
    let a = emptyArchive()
    let day = '2028-12-31'
    for (let i = 0; i < ARCHIVE_CAP + 5; i++) {
      a = addStamp(a, stamp(day))
      day = previousDateKey(day)
    }
    expect(Object.keys(a.stamps)).toHaveLength(ARCHIVE_CAP)
    expect(a.stamps['2028-12-31']).toBeDefined()
    expect(a.firstDate).toBe(Object.keys(a.stamps).sort()[0])
  })
})

describe('streak from stamps', () => {
  it('counts back from today, or from yesterday while today is unplayed', () => {
    const a = archiveOf(stamp('2026-11-19'), stamp('2026-11-20'), stamp('2026-11-21'))
    expect(archiveStreak(a, '2026-11-21')).toBe(3)
    expect(archiveStreak(a, '2026-11-22')).toBe(3)
    expect(archiveStreak(a, '2026-11-23')).toBe(0)
  })

  it('stops at a gap', () => {
    const a = archiveOf(stamp('2026-11-15'), stamp('2026-11-16'), stamp('2026-11-18'), stamp('2026-11-19'))
    expect(archiveStreak(a, '2026-11-19')).toBe(2)
    expect(archiveStreak(a, '2026-11-16')).toBe(2)
    expect(archiveStreak(a, '2026-11-17')).toBe(2)
  })

  it('crosses month and year boundaries', () => {
    const a = archiveOf(stamp('2026-12-30'), stamp('2026-12-31'), stamp('2027-01-01'))
    expect(archiveStreak(a, '2027-01-01')).toBe(3)
  })

  it('is 0 for an empty archive', () => {
    expect(archiveStreak(emptyArchive(), '2026-11-22')).toBe(0)
  })
})

describe('month grid', () => {
  it('pads a month that starts on Sunday (November 2026) Monday-first', () => {
    const dates = monthDates(2026, 11)
    expect(dates.slice(0, 6)).toEqual([null, null, null, null, null, null])
    expect(dates[6]).toBe('2026-11-01')
    expect(dates.filter(Boolean)).toHaveLength(30)
    expect(dates[35]).toBe('2026-11-30') // Monday, alone on the sixth row
    expect(dates.slice(-6)).toEqual([null, null, null, null, null, null])
    expect(dates).toHaveLength(42)
  })

  it('needs no leading padding for a month that starts on Monday (June 2026)', () => {
    const dates = monthDates(2026, 6)
    expect(dates[0]).toBe('2026-06-01')
    expect(dates.at(29)).toBe('2026-06-30')
    expect(dates).toHaveLength(35)
    expect(dates.slice(30)).toEqual([null, null, null, null, null])
  })

  it('fits February 2026 (starts Sunday, 28 days) and a leap February', () => {
    expect(monthDates(2026, 2)).toHaveLength(35)
    expect(monthDates(2028, 2).filter(Boolean)).toHaveLength(29)
  })

  it('places stamps on their days and nulls elsewhere', () => {
    const a = archiveOf(stamp('2026-11-01'), stamp('2026-11-30'), stamp('2026-10-31'))
    const grid = monthGrid(a, 2026, 11)
    expect(grid).toHaveLength(42)
    expect(grid[6]?.date).toBe('2026-11-01')
    expect(grid[35]?.date).toBe('2026-11-30')
    expect(grid.filter(Boolean)).toHaveLength(2)
  })
})

describe('month summary', () => {
  it('counts distinct languages across the month, first heard first', () => {
    const a = archiveOf(
      stamp('2026-11-02', ['fr-FR', 'de-DE', 'fr-FR'], { score: 300 }),
      stamp('2026-11-01', ['es-ES', 'fr-FR'], { score: 900 }),
      stamp('2026-11-03', ['ja-JP', 'es-ES'], { score: 100 }),
      stamp('2026-10-31', ['ko-KR']),
    )
    expect(monthSummary(a, 2026, 11)).toEqual({
      daysPlayed: 3,
      distinctLanguages: 4,
      languages: ['es-ES', 'fr-FR', 'de-DE', 'ja-JP'],
      bestScore: 900,
    })
    expect(collectedLanguages(a)).toEqual(['ko-KR', 'es-ES', 'fr-FR', 'de-DE', 'ja-JP'])
  })

  it('is all zeros for an empty month', () => {
    const a = archiveOf(stamp('2026-11-01'))
    expect(monthSummary(a, 2026, 9)).toEqual({ daysPlayed: 0, distinctLanguages: 0, languages: [], bestScore: 0 })
    expect(monthSummary(emptyArchive(), 2026, 11).daysPlayed).toBe(0)
  })

  it('counts a day without recorded languages as played', () => {
    const a = archiveOf(stamp('2026-11-01', []))
    expect(monthSummary(a, 2026, 11)).toMatchObject({ daysPlayed: 1, distinctLanguages: 0 })
  })
})

describe('export / import', () => {
  const full = archiveOf(
    stamp('2026-11-20', ['es-ES', 'fr-FR'], { streak: 1 }),
    stamp('2026-11-21', ['ja-JP'], { streak: 2, score: 0, correct: 0 }),
    stamp('2026-10-01', [], { streak: 1 }),
  )

  it('round-trips exactly', () => {
    expect(importJson(exportJson(full))).toEqual(full)
    expect(importJson(exportJson(emptyArchive()))).toEqual(emptyArchive())
  })

  it('rejects malformed input instead of throwing', () => {
    const good = JSON.parse(exportJson(full)) as { stamps: Record<string, Record<string, unknown>> }
    const variant = (edit: (o: typeof good) => void) => {
      const o = structuredClone(good)
      edit(o)
      return JSON.stringify(o)
    }
    const bad = [
      '',
      '{nope',
      'null',
      '[]',
      '42',
      '{"v":1,"stamps":{}}',
      '{"v":2}',
      '{"v":2,"stamps":[]}',
      variant((o) => (o.stamps['2026-02-30'] = { ...o.stamps['2026-11-20'], date: '2026-02-30' })),
      variant((o) => (o.stamps['2026-11-20'] = { ...o.stamps['2026-11-20'], date: '2026-11-19' })),
      variant((o) => (o.stamps['2026-11-20'] = { ...o.stamps['2026-11-20'], languages: ['es-ES', 'xx-XX'] })),
      variant((o) => (o.stamps['2026-11-20'] = { ...o.stamps['2026-11-20'], languages: 'es-ES' })),
      variant((o) => (o.stamps['2026-11-20'] = { ...o.stamps['2026-11-20'], score: -1 })),
      variant((o) => (o.stamps['2026-11-20'] = { ...o.stamps['2026-11-20'], score: '500' })),
      variant((o) => (o.stamps['2026-11-20'] = { ...o.stamps['2026-11-20'], correct: 11 })),
      variant((o) => (o.stamps['2026-11-20'] = { ...o.stamps['2026-11-20'], streak: null })),
      variant((o) => (o.stamps['2026-11-20'] = null as unknown as Record<string, unknown>)),
    ]
    for (const raw of bad) {
      expect(() => importJson(raw)).not.toThrow()
      expect(importJson(raw), raw).toBeNull()
    }
  })

  it('recomputes firstDate rather than trusting the file', () => {
    const raw = JSON.stringify({ ...JSON.parse(exportJson(full)), firstDate: '1999-01-01' })
    expect(importJson(raw)?.firstDate).toBe('2026-10-01')
  })

  it('validates real calendar days', () => {
    expect(isDateKey('2028-02-29')).toBe(true)
    expect(isDateKey('2026-02-29')).toBe(false)
    expect(isDateKey('2026-1-01')).toBe(false)
  })

  it('merges without overwriting days already on the device', () => {
    const here = archiveOf(stamp('2026-11-21', ['de-DE'], { score: 1 }))
    const merged = mergeArchives(here, full)
    expect(Object.keys(merged.stamps)).toEqual(['2026-10-01', '2026-11-20', '2026-11-21'])
    expect(merged.stamps['2026-11-21']?.score).toBe(1)
  })
})

describe('archive storage', () => {
  function fakeStorage(store: Map<string, string> | 'throws') {
    const deny = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    const localStorage =
      store === 'throws'
        ? { getItem: deny, setItem: deny }
        : { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    Object.defineProperty(globalThis, 'window', { value: { localStorage }, configurable: true })
  }

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window')
  })

  it('builds the archive from existing daily results on first load', () => {
    let rec = recordDailyResult(null, '2026-11-19', { score: 1, correct: 1, total: 10 })
    rec = recordDailyResult(rec, '2026-11-20', { score: 2, correct: 2, total: 10, languages: ['es-ES'] })
    rec = recordDailyResult(rec, '2026-11-21', { score: 3, correct: 3, total: 10, languages: ['fr-FR'] })
    const store = new Map<string, string>()
    fakeStorage(store)
    const a = loadArchive(rec)
    expect(Object.keys(a.stamps)).toEqual(['2026-11-19', '2026-11-20', '2026-11-21'])
    // A pre-v2 day has no languages but is still a stamped square.
    expect(a.stamps['2026-11-19']).toEqual({ date: '2026-11-19', score: 1, correct: 1, total: 10, languages: [], streak: 1 })
    expect(a.stamps['2026-11-21']).toMatchObject({ languages: ['fr-FR'], streak: 3 })
    expect(importJson(store.get('lingo.archive.v1') ?? '')).toEqual(a)
  })

  it('honours the record’s longer streak where older results were capped away', () => {
    const rec = { lastDate: '2026-11-21', streak: 90, best: 90, results: { '2026-11-20': { score: 1, correct: 1, total: 10 }, '2026-11-21': { score: 1, correct: 1, total: 10 } }, languages: {} }
    const a = backfillArchive(emptyArchive(), rec)
    expect(a.stamps['2026-11-21']?.streak).toBe(90)
    expect(a.stamps['2026-11-20']?.streak).toBe(89)
  })

  it('treats a corrupt stored archive as empty and survives storage errors', () => {
    fakeStorage(new Map([['lingo.archive.v1', '{nope']]))
    expect(loadArchive(null)).toEqual(emptyArchive())
    fakeStorage('throws')
    expect(loadArchive(null)).toEqual(emptyArchive())
    expect(importArchive(emptyArchive(), exportJson(archiveOf(stamp('2026-11-21'))))).not.toBeNull()
  })

  it('imports by merging, and writes nothing for a bad file', () => {
    const store = new Map<string, string>()
    fakeStorage(store)
    expect(importArchive(emptyArchive(), '{"v":2,"stamps":{"x":{}}}')).toBeNull()
    expect(store.has('lingo.archive.v1')).toBe(false)
    const merged = importArchive(archiveOf(stamp('2026-11-22')), exportJson(archiveOf(stamp('2026-11-21'))))
    expect(Object.keys(merged?.stamps ?? {})).toEqual(['2026-11-21', '2026-11-22'])
    expect(importJson(store.get('lingo.archive.v1') ?? '')).toEqual(merged)
  })
})
