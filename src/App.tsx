import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { Archive } from './components/Archive.tsx'
import { DailyChallenge } from './components/DailyChallenge.tsx'
import { EndScreen } from './components/EndScreen.tsx'
import { HUD } from './components/HUD.tsx'
import { KnowLanguages } from './components/KnowLanguages.tsx'
import { Reveal } from './components/Reveal.tsx'
import { Round } from './components/Round.tsx'
import { SideRail } from './components/SideRail.tsx'
import { StartScreen } from './components/StartScreen.tsx'
import { LANGUAGES, type LangCode, type Language } from './data/languages.ts'
import {
  SLOW_RATE,
  allowsSlow,
  clipKey,
  guess,
  initialState,
  isOver,
  nextRound,
  MIN_POOL,
  type Difficulty,
  type GameState,
} from './engine/game.ts'
import { addStamp, stampFromDaily } from './engine/archive.ts'
import { currentStreak, londonDateKey, type DailyRecord } from './engine/daily.ts'
import { seedFromString } from './engine/rng.ts'
import { useAudio } from './hooks/useAudio.ts'
import { track, trackPageview } from './lib/analytics.ts'
import { AmbientField, ScreenTransition } from './motion/index.ts'
import { backOrHome, navigate, useRoute } from './router.ts'
import {
  appendHeard,
  loadArchive,
  loadBestScore,
  loadDaily,
  loadHeard,
  loadKnown,
  saveArchive,
  saveBestScore,
  saveHeard,
  saveKnown,
} from './storage.ts'

type AppState = { screen: 'start' } | { screen: 'game'; game: GameState }

type Action =
  | { type: 'start'; seed: number; difficulty: Difficulty; pool: readonly Language[]; heard: readonly string[] }
  | { type: 'guess'; index: number | null }
  | { type: 'next' }
  | { type: 'menu' }

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'start':
      return { screen: 'game', game: initialState(action.seed, action.difficulty, action.pool, action.heard) }
    case 'guess':
      return state.screen === 'game' ? { ...state, game: guess(state.game, action.index) } : state
    case 'next':
      return state.screen === 'game' ? { ...state, game: nextRound(state.game) } : state
    case 'menu':
      return { screen: 'start' }
  }
}

/** `?seed=abc` makes the first game reproducible (handy for tests and sharing). */
function firstSeed(): number | null {
  const param = new URLSearchParams(window.location.search).get('seed')
  return param ? seedFromString(param) : null
}

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? Date.now() >>> 0
}

const ROSTER = new Set<string>(LANGUAGES.map((l) => l.code))

/** The saved known-languages choice, or null if the player was never asked. */
function initialKnown(): LangCode[] | null {
  const saved = loadKnown()
  return saved === null ? null : saved.filter((c): c is LangCode => ROSTER.has(c))
}

function clipUrl(code: string, voiceIndex: number, sentenceId: string): string {
  return `${import.meta.env.BASE_URL}audio/${code}/${voiceIndex}/${sentenceId}.mp3`
}

export default function App() {
  const route = useRoute()
  const [state, dispatch] = useReducer(reducer, { screen: 'start' })
  const [slow, setSlow] = useState(false)
  const [urlSeed, setUrlSeed] = useState(firstSeed)
  const [bestScore, setBestScore] = useState(loadBestScore)
  const [isNewBest, setIsNewBest] = useState(false)
  // Clips heard in earlier games, so replays do not repeat them. Kept in
  // memory too, so it still works for this session if storage is disabled.
  const [heard, setHeard] = useState(loadHeard)
  // Languages the player knows are excluded from every game (answer and
  // distractors). null = not asked yet, so the picker is shown first.
  const [known, setKnown] = useState(initialKnown)
  const [editingKnown, setEditingKnown] = useState(false)
  const [dailyRecord, setDailyRecord] = useState(loadDaily)
  // Built from the daily record on first load, then stamped on each completed day.
  const [archive, setArchive] = useState(() => loadArchive(dailyRecord))
  const pool = LANGUAGES.filter((l) => !known?.includes(l.code))

  // The game only exists on /play: leaving the route (browser back) silences
  // it on the very next render, before the effect below drops it.
  const game = route.name === 'play' && state.screen === 'game' ? state.game : null

  // /play with nothing in memory (a reload, a forward after back) goes home;
  // any other route discards a game left behind.
  useEffect(() => {
    if (route.name === 'play' && state.screen !== 'game') navigate({ name: 'home' }, { replace: true })
    if (route.name !== 'play' && state.screen === 'game') dispatch({ type: 'menu' })
  }, [route.name, state.screen])

  // One key per screen type: a change remounts the frame and plays the
  // enter transition. The ambient field and the side rail live outside it
  // because a transform on the wrapper would trap position: fixed.
  const screenKey = game
    ? game.phase
    : route.name === 'archive'
      ? 'archive'
      : known === null || editingKnown
        ? 'know'
        : 'start'
  // `fixed` comes before the screen so it is the first tab stop, like a header.
  const frame = (screen: ReactNode, fixed?: ReactNode) => (
    <>
      <AmbientField intensity={0.5} />
      {fixed}
      <ScreenTransition screenKey={screenKey}>{screen}</ScreenTransition>
    </>
  )
  const src =
    game && game.phase !== 'over'
      ? clipUrl(game.round.language.code, game.round.voiceIndex, game.round.sentenceId)
      : null
  const audio = useAudio(src)
  const { setRate } = audio

  // Expert has no slow toggle. The preference is kept for other difficulties but
  // must not leak into an expert run: it would both change the rate and leave a
  // hidden toggle in a checked state.
  const slowAllowed = game ? allowsSlow(game.difficulty) : true
  const slowActive = slowAllowed && slow

  useEffect(() => {
    setRate(slowActive ? SLOW_RATE : 1)
  }, [slowActive, setRate])

  // One pageview per route; the collector filters crawlers and dedupes by id.
  useEffect(() => {
    trackPageview()
  }, [route.name])

  // Round timing for the "how long does a guess take" panel.
  const roundStartedAt = useRef(0)
  useEffect(() => {
    roundStartedAt.current = performance.now()
  }, [game?.roundNumber, game?.phase])

  // Report each answered round exactly once, when the reveal appears.
  const reportedRound = useRef(-1)
  useEffect(() => {
    if (!game || game.phase !== 'reveal' || !game.lastResult) return
    if (reportedRound.current === game.roundNumber) return
    reportedRound.current = game.roundNumber
    track('round', {
      lang: game.round.language.code,
      difficulty: game.difficulty,
      ok: game.lastResult.correct,
      ms: Math.round(performance.now() - roundStartedAt.current),
    })
  }, [game])

  // A finished game is reported once, on the over screen.
  const reportedGame = useRef<GameState | null>(null)
  useEffect(() => {
    if (!game || game.phase !== 'over' || reportedGame.current === game) return
    reportedGame.current = game
    track('game_over', { score: game.score, difficulty: game.difficulty })
  }, [game])

  /** `replace` when arriving from another sub-route, so back still means home. */
  const start = (difficulty: Difficulty, opts: { replace?: boolean } = {}) => {
    track('game_start', { difficulty })
    // A ?seed= game ignores the memory so the seed alone determines it.
    dispatch({
      type: 'start',
      seed: urlSeed ?? randomSeed(),
      difficulty,
      pool,
      heard: urlSeed === null ? heard : [],
    })
    setUrlSeed(null)
    navigate({ name: 'play' }, opts)
  }

  const answer = (index: number | null) => {
    if (game && game.phase === 'round') {
      const { round } = game
      const next = appendHeard(heard, clipKey(round.language.code, round.voiceIndex, round.sentenceId))
      saveHeard(next)
      setHeard(next)
    }
    dispatch({ type: 'guess', index })
  }

  const next = () => {
    // Leaving the final reveal ends the game: record the best score here, in
    // the event handler, so the reducer stays pure.
    if (game && game.phase === 'reveal' && isOver(game)) {
      const isNew = game.score > 0 && game.score > (bestScore ?? 0)
      if (isNew) {
        saveBestScore(game.score)
        setBestScore(game.score)
      }
      setIsNewBest(isNew)
    }
    dispatch({ type: 'next' })
  }

  const saveKnownLanguages = (codes: LangCode[]) => {
    saveKnown(codes)
    setKnown(codes)
    setEditingKnown(false)
  }

  // Completing a day stamps the archive. addStamp ignores a date already
  // stamped, so a second finish (or a stale tab) never rewrites the day.
  const recordDaily = (record: DailyRecord, date: string) => {
    setDailyRecord(record)
    const streak = record.lastDate === date ? record.streak : 1
    const next = addStamp(archive, stampFromDaily(date, record, record.languages[date] ?? [], streak))
    if (next !== archive) {
      saveArchive(next)
      setArchive(next)
    }
  }

  // Moves between sub-routes replace the entry, so back from any of them is home.
  // The daily is the same for everyone, so it skips the known-languages
  // picker; a shared link plays straight away.
  if (route.name === 'daily') {
    return (
      <DailyChallenge
        record={dailyRecord}
        onRecord={recordDaily}
        onBack={backOrHome}
        onArchive={() => navigate({ name: 'archive' }, { replace: true })}
        onPlayNormal={() => {
          if (known !== null && pool.length >= MIN_POOL) start('normal', { replace: true })
          else navigate({ name: 'home' }, { replace: true })
        }}
      />
    )
  }

  if (route.name === 'archive') {
    return frame(
      <Archive
        archive={archive}
        today={londonDateKey()}
        onArchiveChange={setArchive}
        onPlayDaily={() => navigate({ name: 'daily' }, { replace: true })}
        onBack={backOrHome}
      />,
    )
  }

  if (!game && (known === null || editingKnown)) {
    return frame(
      <KnowLanguages
        initial={known ?? []}
        firstVisit={known === null}
        onSave={saveKnownLanguages}
        onCancel={known === null ? undefined : () => setEditingKnown(false)}
      />,
    )
  }

  if (!game) {
    const today = londonDateKey()
    return frame(
      <StartScreen
        bestScore={bestScore}
        pool={pool}
        excludedCount={LANGUAGES.length - pool.length}
        onStart={start}
        onEditKnown={() => setEditingKnown(true)}
        daily={{
          date: today,
          streak: currentStreak(dailyRecord, today),
          result: dailyRecord?.results[today] ?? null,
        }}
        onDaily={() => navigate({ name: 'daily' })}
      />,
      <SideRail onArchive={() => navigate({ name: 'archive' })} />,
    )
  }

  if (game.phase === 'over') {
    return frame(
      <EndScreen
        game={game}
        bestScore={bestScore}
        isNewBest={isNewBest}
        shareUrl={window.location.origin + import.meta.env.BASE_URL}
        onPlayAgain={() => start(game.difficulty)}
        onMenu={backOrHome}
      />,
    )
  }

  return frame(
    <div className="game">
      <HUD roundNumber={game.roundNumber} score={game.score} streak={game.streak} lives={game.lives} />
      {game.phase === 'round' ? (
        <Round
          round={game.round}
          audio={audio}
          slow={slowActive}
          allowSlow={slowAllowed}
          onToggleSlow={() => setSlow((s) => !s)}
          onGuess={answer}
          onSkip={() => answer(null)}
        />
      ) : (
        game.lastResult && (
          <Reveal
            round={game.round}
            result={game.lastResult}
            isFinal={isOver(game)}
            onReplay={audio.replay}
            onNext={next}
          />
        )
      )}
    </div>,
  )
}
