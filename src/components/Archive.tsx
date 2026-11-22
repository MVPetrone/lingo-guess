import { useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from 'react'
import { LANGUAGES, type LangCode } from '../data/languages.ts'
import {
  archiveStreak,
  collectedLanguages,
  monthDates,
  monthSummary,
  type Archive as ArchiveData,
  type DayStamp,
} from '../engine/archive.ts'
import { track } from '../lib/analytics.ts'
import { archiveFileName, exportArchive, importArchive } from '../storage.ts'
import { Flag } from './Flag.tsx'
import { Icon } from './Icon.tsx'
import { ShareCard } from './ShareCard.tsx'

interface Props {
  archive: ArchiveData
  /** London date key; the calendar never offers days after it. */
  today: string
  onArchiveChange: (archive: ArchiveData) => void
  onPlayDaily: () => void
  onBack: () => void
}

/** Mini flags shown in a calendar cell before the rest collapse to `+N`. */
const CELL_FLAGS = 4
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

const byCode = new Map(LANGUAGES.map((l) => [l.code, l]))

type Month = { year: number; month: number }

function monthOf(key: string): Month {
  const [year, month] = key.split('-').map(Number) as [number, number]
  return { year, month }
}

const monthIndex = ({ year, month }: Month) => year * 12 + (month - 1)
const fromIndex = (i: number): Month => ({ year: Math.floor(i / 12), month: (i % 12) + 1 })

// Keys are London days already; formatting them in UTC keeps them that day.
const utc = (key: string) => {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d)
}
const monthName = (m: Month) =>
  new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(Date.UTC(m.year, m.month - 1, 1))
const monthTitle = (m: Month) =>
  new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    Date.UTC(m.year, m.month - 1, 1),
  )
const dayTitle = (key: string) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(utc(key))

/** Display only: a day can hear a language twice; the stamp keeps both. */
const unique = (codes: readonly LangCode[]) => [...new Set(codes)]

/**
 * The month's cells, ending with the week that holds today: whole weeks still
 * to come would only be blank rows. Future days inside today's week keep
 * their (invisible) slots so the columns stay aligned.
 */
function visibleDates(view: Month, today: string): (string | null)[] {
  const dates = monthDates(view.year, view.month)
  const at = dates.indexOf(today)
  return at < 0 ? dates : dates.slice(0, Math.ceil((at + 1) / 7) * 7)
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

type ImportState = { kind: 'idle' } | { kind: 'done'; added: number } | { kind: 'failed' }

/** The Daily Archive: a calendar of stamped days, the month's tally, and the share card. */
export function Archive({ archive, today, onArchiveChange, onPlayDaily, onBack }: Props) {
  const current = monthOf(today)
  const [view, setView] = useState<Month>(current)
  const [selected, setSelected] = useState<string>(today)
  const [sharing, setSharing] = useState(false)
  const [imported, setImported] = useState<ImportState>({ kind: 'idle' })
  const fileRef = useRef<HTMLInputElement>(null)

  const days = Object.keys(archive.stamps).length
  const streak = archiveStreak(archive, today)
  // Stable identity: the share card redraws whenever this changes.
  const collected = useMemo(() => collectedLanguages(archive), [archive])
  const summary = monthSummary(archive, view.year, view.month)
  const first = archive.firstDate ? monthOf(archive.firstDate) : current
  const canPrev = monthIndex(view) > monthIndex(first)
  const canNext = monthIndex(view) < monthIndex(current)
  const page = (step: number) => setView((v) => fromIndex(monthIndex(v) + step))

  const onExport = () => {
    const url = URL.createObjectURL(new Blob([exportArchive(archive)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = archiveFileName(today, 'json')
    a.click()
    // Revoke after the click has been handled, or some browsers cancel the download.
    setTimeout(() => URL.revokeObjectURL(url), 0)
    track('archive_export', { days })
  }

  const onImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (!file) return
    const merged = importArchive(archive, await file.text())
    if (!merged) {
      setImported({ kind: 'failed' })
      return
    }
    setImported({ kind: 'done', added: Object.keys(merged.stamps).length - days })
    onArchiveChange(merged)
    track('archive_import', { days: Object.keys(merged.stamps).length })
  }

  const empty = days === 0

  return (
    <main className="screen screen--archive" data-testid="archive">
      <header className="archive-head">
        <p className="eyebrow archive-head__eyebrow">Daily Archive</p>
        {empty ? (
          <>
            <h1 className="archive-head__title">Your archive starts today</h1>
            <p className="archive-head__lede" data-testid="archive-empty">
              Every Daily Challenge you finish stamps a square here with the languages you heard.
            </p>
          </>
        ) : (
          <>
            <h1 className="archive-head__title" data-testid="archive-streak">
              {streak}-day streak
            </h1>
            <p className="archive-head__lede" data-testid="archive-languages">
              {plural(summary.distinctLanguages, 'language')} across {monthName(view)}
            </p>
          </>
        )}
      </header>

      {empty ? (
        <button type="button" className="btn btn--signal btn--xl archive__cta" onClick={onPlayDaily} autoFocus>
          <Icon name="play" className="btn__icon" />
          Play today’s challenge
        </button>
      ) : (
        <>
          <section className="archive-month panel" aria-label="Calendar">
            <div className="archive-pager">
              <button
                type="button"
                className="archive-pager__btn"
                onClick={() => page(-1)}
                disabled={!canPrev}
                aria-label="Previous month"
                data-testid="archive-prev"
              >
                <Icon name="chevron" className="archive-pager__icon archive-pager__icon--back" />
              </button>
              <h2 className="archive-pager__title" aria-live="polite" data-testid="archive-month">
                {monthTitle(view)}
              </h2>
              <button
                type="button"
                className="archive-pager__btn"
                onClick={() => page(1)}
                disabled={!canNext}
                aria-label="Next month"
                data-testid="archive-next"
              >
                <Icon name="chevron" className="archive-pager__icon" />
              </button>
            </div>

            <ol className="archive-weekdays" aria-hidden="true">
              {WEEKDAYS.map((w) => (
                <li key={w} title={w}>
                  {w[0]}
                </li>
              ))}
            </ol>
            <ol className="archive-grid" key={`${view.year}-${view.month}`}>
              {visibleDates(view, today).map((date, i) => (
                <DayCell
                  key={date ?? `pad-${i}`}
                  date={date}
                  stamp={date ? (archive.stamps[date] ?? null) : null}
                  today={today}
                  index={i}
                  selected={date === selected}
                  onSelect={setSelected}
                />
              ))}
            </ol>
            <p className="eyebrow archive-month__tally">
              {plural(summary.daysPlayed, 'day')} played
              {summary.bestScore > 0 && ` · best ${summary.bestScore} pts`}
            </p>
          </section>

          {monthIndex(monthOf(selected)) === monthIndex(view) && (
            <DayDetail date={selected} stamp={archive.stamps[selected] ?? null} today={today} onPlayDaily={onPlayDaily} />
          )}
        </>
      )}

      <footer className="archive-foot">
        <div className="actions archive-foot__actions">
          {!empty && (
            <button type="button" className="btn btn--signal" onClick={() => setSharing(true)} data-testid="archive-share">
              <Icon name="share" className="btn__icon" />
              Share card
            </button>
          )}
          {!empty && (
            <button type="button" className="btn btn--ghost" onClick={onExport} data-testid="archive-export">
              Export
            </button>
          )}
          <input
            ref={fileRef}
            className="archive-foot__file"
            type="file"
            accept="application/json,.json"
            onChange={onImport}
            tabIndex={-1}
            aria-hidden="true"
            data-testid="archive-import"
          />
        </div>
        <p className="archive-foot__status" role="status">
          {imported.kind === 'done' &&
            (imported.added > 0 ? `Imported ${plural(imported.added, 'new day')}.` : 'Nothing new in that file.')}
          {imported.kind === 'failed' && 'That file isn’t a Lingo Guess archive.'}
        </p>
        {/* No accounts: say plainly where the record lives. Import is a quiet
            link here, not a third button — restoring is the rare case. */}
        <p className="archive-foot__note">
          <span>Stored on this device only. Export a copy to keep it if you clear your browser or change phone.</span>
          <button type="button" className="link link--quiet" onClick={() => fileRef.current?.click()}>
            Import a copy
          </button>
        </p>
        <button type="button" className="link link--quiet archive-foot__back" onClick={onBack} data-testid="archive-back">
          Back to menu
        </button>
      </footer>

      {sharing && (
        <ShareCard
          days={days}
          today={today}
          streak={streak}
          languages={collected}
          onClose={() => setSharing(false)}
        />
      )}
    </main>
  )
}

function DayCell({
  date,
  stamp,
  today,
  index,
  selected,
  onSelect,
}: {
  date: string | null
  stamp: DayStamp | null
  today: string
  index: number
  selected: boolean
  onSelect: (date: string) => void
}) {
  if (!date) return <li className="archive-cell archive-cell--pad" aria-hidden="true" />
  const day = Number(date.slice(8))
  // Future days hold their slot so the weeks stay aligned, but show nothing.
  if (date > today) return <li className="archive-cell archive-cell--future" aria-hidden="true" />
  if (!stamp && date < today) {
    return (
      <li className="archive-cell archive-cell--missed" data-state="missed">
        <span className="archive-cell__day">{day}</span>
      </li>
    )
  }

  const flags = stamp ? unique(stamp.languages) : []
  const extra = flags.length - CELL_FLAGS
  const label = stamp
    ? `${dayTitle(date)}: ${stamp.correct}/${stamp.total}, ${plural(flags.length, 'language')}`
    : `${dayTitle(date)}, today: not played yet`
  return (
    <li
      className={`archive-cell ${stamp ? 'archive-cell--played' : 'archive-cell--today'}`}
      data-state={stamp ? 'played' : 'today'}
      data-testid={stamp ? 'archive-day' : undefined}
      style={{ '--i': index } as CSSProperties}
    >
      <button
        type="button"
        className="archive-cell__btn"
        onClick={() => onSelect(date)}
        aria-pressed={selected}
        aria-label={label}
      >
        <span className="archive-cell__top" aria-hidden="true">
          <span className="archive-cell__day">{day}</span>
          {extra > 0 && <span className="archive-cell__more">+{extra}</span>}
        </span>
        {flags.length > 0 && (
          <span className="archive-cell__flags" aria-hidden="true">
            {flags.slice(0, CELL_FLAGS).map((code) => (
              <Flag key={code} code={code} className="archive-cell__flag" />
            ))}
          </span>
        )}
      </button>
    </li>
  )
}

function DayDetail({
  date,
  stamp,
  today,
  onPlayDaily,
}: {
  date: string
  stamp: DayStamp | null
  today: string
  onPlayDaily: () => void
}) {
  if (!stamp) {
    if (date !== today) return null
    return (
      <section className="archive-detail panel" aria-label="Today" data-testid="archive-detail">
        <p className="eyebrow">{dayTitle(date)}</p>
        <p className="archive-detail__lede">Today’s square is still empty.</p>
        <button type="button" className="btn btn--ghost" onClick={onPlayDaily}>
          <Icon name="play" className="btn__icon" />
          Play today’s challenge
        </button>
      </section>
    )
  }

  const flags = unique(stamp.languages)
  return (
    <section className="archive-detail panel" aria-label={dayTitle(date)} data-testid="archive-detail">
      <div className="archive-detail__head">
        <p className="eyebrow">{dayTitle(date)}</p>
        {date === today && (
          <button type="button" className="link archive-detail__link" onClick={onPlayDaily}>
            See today’s result
          </button>
        )}
      </div>
      <dl className="stats">
        <div className="stats__item">
          <dt className="eyebrow">Score</dt>
          <dd className="stats__value">{stamp.score}</dd>
        </div>
        <div className="stats__item">
          <dt className="eyebrow">Correct</dt>
          <dd className="stats__value">
            {stamp.correct}/{stamp.total}
          </dd>
        </div>
        <div className="stats__item">
          <dt className="eyebrow">Streak</dt>
          <dd className="stats__value">{stamp.streak}</dd>
        </div>
      </dl>
      {flags.length > 0 ? (
        <ul className="archive-detail__langs" aria-label="Languages heard">
          {flags.map((code) => (
            <li key={code} className="badge archive-detail__lang">
              <Flag code={code} />
              {byCode.get(code)?.name ?? code}
            </li>
          ))}
        </ul>
      ) : (
        <p className="archive-detail__lede">This day was played before the archive recorded languages.</p>
      )}
    </section>
  )
}
