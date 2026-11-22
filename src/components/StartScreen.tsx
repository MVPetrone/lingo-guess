import { useState } from 'react'
import type { Language } from '../data/languages.ts'
import type { DailyResult } from '../engine/daily.ts'
import type { Difficulty } from '../engine/game.ts'
import { DIFFICULTY_TIERS, LIVES, MIN_POOL, ROUNDS, answerTiers, optionCountFor } from '../engine/game.ts'
import { DifficultyGlyph } from './DifficultyGlyph.tsx'
import { Icon, type IconName } from './Icon.tsx'

const LEVELS: { id: Difficulty; label: string; hint: string; facts: [IconName, string][] }[] = [
  {
    id: 'easy',
    label: 'Easy',
    hint: 'Big, famous languages · short sentences',
    facts: [
      ['star', 'Famous'],
      ['short-clips', 'Short clips'],
    ],
  },
  {
    id: 'normal',
    label: 'Normal',
    hint: 'Adds the recognisable ones · longer sentences',
    facts: [
      ['plus-circle', 'Familiar'],
      ['short-clips', 'Longer clips'],
    ],
  },
  {
    id: 'hard',
    label: 'Hard',
    hint: 'Includes confusable pairs · rare words',
    facts: [
      ['look-alikes', 'Look-alikes'],
      ['diamond', 'Rare words'],
    ],
  },
  {
    id: 'expert',
    label: 'Expert',
    hint: 'Confusable languages only · 5 choices · no slow-down',
    facts: [
      ['look-alikes', 'Look-alikes'],
      ['choices', `${optionCountFor('expert')} choices`],
      ['speed', 'Full speed'],
    ],
  },
]

// Fixed to en-GB so a player in Tokyo still sees NOV, never the system locale's month.
const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' })

interface Props {
  bestScore: number | null
  /** Languages left after excluding the ones the player knows. */
  pool: readonly Language[]
  excludedCount: number
  onStart: (difficulty: Difficulty) => void
  onEditKnown: () => void
  /** Today's Daily Challenge: its date, the live streak, and the result once done. */
  daily: { date: string; streak: number; result: DailyResult | null }
  onDaily: () => void
}

/** Game parameters as three static pills; the visually hidden text spells each one out. */
function SpecPills({ languages }: { languages: number }) {
  return (
    <ul className="spec-pills">
      <li className="spec-pill" data-testid="pill-rounds">
        <Icon name="replay" className="spec-pill__icon" />
        {ROUNDS}
        <span className="sr-only"> rounds</span>
      </li>
      <li className="spec-pill" data-testid="pill-lives">
        {Array.from({ length: LIVES }, (_, i) => (
          <Icon key={i} name="heart" className="spec-pill__heart" />
        ))}
        <span className="sr-only">{LIVES} lives</span>
      </li>
      <li className="spec-pill" data-testid="pill-languages">
        <Icon name="globe" className="spec-pill__icon" />
        {languages}
        <span className="sr-only"> languages in play</span>
      </li>
    </ul>
  )
}

/** NOV over 21, from a YYYY-MM-DD key. */
function DateBadge({ date }: { date: string }) {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return (
    <time className="date-badge" dateTime={date} data-testid="daily-date">
      <span className="date-badge__month">{MONTH.format(Date.UTC(y, m - 1, d))}</span>
      <span className="date-badge__day">{d}</span>
    </time>
  )
}

/** The way into the Daily Challenge; once played it reads as done until tomorrow. */
function DailyCard({ daily, onDaily }: Pick<Props, 'daily' | 'onDaily'>) {
  const { date, streak, result } = daily
  return (
    <button
      type="button"
      className={`daily-card ${result ? 'is-done' : ''}`}
      onClick={onDaily}
      data-testid="daily-card"
    >
      <DateBadge date={date} />
      <span className="daily-card__body">
        {/* The streak rides the eyebrow line, not the meta row: on a phone the
            facts wrap there and would strand the streak on a line of its own. */}
        <span className="daily-card__head">
          <span className="eyebrow daily-card__eyebrow">Daily Challenge</span>
          {streak > 0 && <span className="daily-card__streak">{streak}-day streak</span>}
        </span>
        <span className="daily-card__meta">
          {result ? (
            <>
              <span className="daily-card__score">
                {result.correct}/{result.total} · {result.score} pts
              </span>
              <span>Back tomorrow</span>
            </>
          ) : (
            <>
              <span className="daily-card__fact">
                <Icon name="keyboard" className="daily-card__fact-icon" />
                Type it
              </span>
              <span className="daily-card__fact">
                <Icon name="users" className="daily-card__fact-icon" />
                Same for all
              </span>
            </>
          )}
        </span>
      </span>
      <Icon name={result ? 'check' : 'arrow'} className="daily-card__icon" />
    </button>
  )
}

export function StartScreen({
  bestScore,
  pool,
  excludedCount,
  onStart,
  onEditKnown,
  daily,
  onDaily,
}: Props) {
  const [difficulty, setDifficulty] = useState<Difficulty>('normal')
  const tooFew = pool.length < MIN_POOL
  const tierFallback = !tooFew && answerTiers(pool, difficulty) !== DIFFICULTY_TIERS[difficulty]

  return (
    <main className="screen screen--start">
      <div className="ambient-slot" aria-hidden="true" />

      <header className="hero">
        <img
          className="hero__mark"
          src={`${import.meta.env.BASE_URL}brand/mark.svg`}
          alt=""
          aria-hidden="true"
          width="72"
          height="72"
        />
        <h1 className="hero__title">Lingo Guess</h1>
        <p className="hero__lede">Hear one sentence. Name the language.</p>
        <SpecPills languages={pool.length} />
      </header>

      <DailyCard daily={daily} onDaily={onDaily} />

      <fieldset className="levels">
        <legend className="eyebrow levels__legend">Difficulty</legend>
        <div className="levels__grid">
          {LEVELS.map((level) => (
            <label
              key={level.id}
              className={`level ${difficulty === level.id ? 'is-selected' : ''}`}
              data-testid={`level-${level.id}`}
            >
              <input
                className="control-input"
                type="radio"
                name="difficulty"
                value={level.id}
                checked={difficulty === level.id}
                onChange={() => setDifficulty(level.id)}
              />
              <DifficultyGlyph level={level.id} />
              <span className="level__label">{level.label}</span>
              <span className="level__facts">
                {level.facts.map(([icon, text]) => (
                  <span key={text} className="level__fact">
                    <Icon name={icon} className="level__fact-icon" />
                    {text}
                  </span>
                ))}
              </span>
            </label>
          ))}
        </div>
        <p className="levels__hint" data-testid="level-hint">
          {LEVELS.find((l) => l.id === difficulty)?.hint}
        </p>
      </fieldset>

      {difficulty === 'expert' && !tooFew && (
        <p className="notice" data-testid="expert-note">
          <span className="notice__tag">Expert pool</span>
          Expert only asks about the {pool.filter((l) => l.tier === 3).length} confusable languages you don’t know. Wrong
          choices come from the same language family wherever it has enough members.
        </p>
      )}
      {tierFallback && (
        <p className="notice" data-testid="tier-fallback">
          <span className="notice__tag">Fallback</span>
          You know all of this level’s usual languages, so it draws from the nearest harder ones instead.
        </p>
      )}

      <div className="start__go">
        {tooFew && (
          <p className="notice notice--warn" id="pool-guard" role="alert" data-testid="pool-guard">
            <span className="notice__tag">Pool too small</span>
            A game needs at least {MIN_POOL} languages you don’t know — only {pool.length} are left. Untick a few in
            “Languages I know”.
          </p>
        )}
        {/* This click is the user gesture that unlocks audio playback. */}
        <button
          type="button"
          className="btn btn--signal btn--xl start__cta"
          onClick={() => onStart(difficulty)}
          disabled={tooFew}
          aria-describedby={tooFew ? 'pool-guard' : undefined}
        >
          <span className="start__cta-disc">
            <Icon name="play" className="btn__icon" />
          </span>
          Start listening
        </button>
      </div>

      <footer className="start__foot">
        <div className="start__foot-row">
          <button type="button" className="known-pill" onClick={onEditKnown} data-testid="edit-known">
            <Icon name="check-circle" className="known-pill__icon" />
            Languages I know
            <span className="known-pill__chip" data-testid="excluded-count">
              {excludedCount === 0 ? 'All languages' : `${excludedCount} skipped`}
            </span>
          </button>
          {bestScore !== null && (
            <p className="start__best">
              <Icon name="trophy" className="start__best-icon" />
              <span className="sr-only">Best score: </span>
              <span className="readout__value">{bestScore}</span>
            </p>
          )}
        </div>
        <p className="eyebrow start__keys">
          <Icon name="speaker" className="start__keys-icon" />
          Sound on
          <span className="touch-only-hide">
            {' · '}
            <kbd>1</kbd>–<kbd>{optionCountFor(difficulty)}</kbd> answer · <kbd>R</kbd> replay
          </span>
          <span className="touch-only">{' · tap the orb to replay'}</span>
        </p>
      </footer>
    </main>
  )
}
