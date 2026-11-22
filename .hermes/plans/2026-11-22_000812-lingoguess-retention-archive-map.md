# Lingo Guess — Daily Archive, Flag Wall & World Map Implementation Plan

**Goal:** Turn the Daily Challenge streak into a permanent, collectible record (calendar of
language-stamped days), give it a shareable "wall of flags" card, and add a knowledge-coverage
world map with a skippable post-game motion reveal.

**Architecture:** All new state stays client-side in `localStorage` (no accounts exist yet), behind
a single new storage module so a future server-side sync swaps one layer. Map rendering is a
committed dot-matrix land mask (no new npm deps), aggregated through a new `region` field on
`Language`. The post-game animation is a new motion-system component following `MOTION.md`
(tokens only, transform/opacity, reduced-motion still frame, skippable input).

**Tech stack:** React 19 + TS + Vite 8, vitest, Playwright. No new dependencies.

---

## Recon — what the repo actually has (facts, verified)

| Fact | Evidence |
| --- | --- |
| 72 languages, each with `code, name, nativeName, flag, family, tier, voice, fact` | `src/data/languages.ts:95-173` |
| Every language maps to an ISO-2 flag (`FLAG_ISO`), flags already ship as SVGs | `src/data/flags.ts`, `public/flags/*.svg` |
| **No** region/continent/geo field anywhere | grep `region` in `src/data` → 0 hits |
| Daily record is `{ lastDate, streak, best, results }`, `results[date] = { score, correct, total, grid? }` | `src/engine/daily.ts:200-216` |
| **Languages heard on a given day are NOT stored** — only the emoji row | `daily.ts:218-220` (`resultOf`) |
| Results are capped at 60 days | `DAILY_RESULTS_CAP = 60`, `daily.ts:14` |
| Daily record persisted under `lingo.daily.v1` | `src/storage.ts:82` |
| Streak = consecutive completed London days, gap resets to 1, `currentStreak` returns 0 if stale | `daily.ts:227-247` |
| No per-language accuracy anywhere; only `gtl:heard` (clip keys, cap 400) and `gtl:bestScore` | `src/storage.ts` |
| Share today is **text only** (grid + URL, clipboard) | `src/share.ts` |
| Screens are a `useReducer` state machine, no router; daily is a boolean flag `?daily=1` | `src/App.tsx:38-113` |
| Motion system: tokens from CSS vars, `useReducedMotion`, canvas at ≤30fps, `MOTION.md` rules | `src/motion/*` |
| Existing canvas precedent: `dotField.ts` + `ambientRenderer.ts` (dot fields, DPR cap 2) | `src/motion/*` |
| Admin analytics has `vid`/`sid` but no retention cohort metric | `server/admin/api/stats.php` |

### Product constraint that must be stated in the UI

There are no accounts. The archive is **device-local**: clearing site data, private mode, or a new
phone erases it. Mitigation in wave 1: an **Export** action (JSON download + import) and the share
card as the visible artefact. Do not promise cross-device persistence anywhere in copy.

---

## Data model changes

### `src/data/languages.ts` — add `region`

```ts
export type Region =
  | 'north-america' | 'latin-america' | 'west-europe' | 'north-europe'
  | 'central-europe' | 'east-europe' | 'middle-east' | 'north-africa'
  | 'west-africa' | 'east-africa' | 'south-asia' | 'east-asia'
  | 'southeast-asia' | 'oceania'

export interface Language { /* … existing … */ region: Region }
```

Assignment rules (all 72 rows, one edit each):
- `en-US` north-america; `pt-BR` latin-america; `es-ES, fr-FR, it-IT, ca-ES, gl-ES, cy-GB, ga-IE,
  mt-MT` west-europe; `nl-NL, sv-SE, da-DK, no-NO, fi-FI, is-IS, et-EE, lv-LV, lt-LT` north-europe;
  `de-DE, pl-PL, cs-CZ, sk-SK, hu-HU, sl-SI, hr-HR, bs-BA, sr-RS, ro-RO, bg-BG, mk-MK, sq-AL, el-GR`
  central-europe; `ru-RU, uk-UA, ka-GE, az-AZ, kk-KZ` east-europe; `tr-TR, ar-EG, he-IL, fa-IR,
  ur-PK, ps-AF` middle-east; `so-SO, am-ET, sw-KE, zu-ZA, af-ZA` east-africa; `hi-IN, bn-BD, ta-IN,
  te-IN, ne-NP, si-LK, uz-UZ` south-asia; `zh-CN, zh-TW, zh-HK, ja-JP, ko-KR, mn-MN` east-asia;
  `th-TH, vi-VN, id-ID, ms-MY, fil-PH, km-KH, lo-LA, my-MM, jv-ID, su-ID` southeast-asia.
  (`north-africa`, `west-africa`, `oceania` exist in the type for the map but currently hold no
  language — the map must render them as "no data", never as "failed".)

Add `src/data/regions.ts` with the display metadata:

```ts
export const REGIONS: { id: Region; label: string; anchor: [number, number] }[] = [
  { id: 'west-europe', label: 'Western Europe', anchor: [48, 2] }, // lat, lon in the mask's projection
  …
]
```

### `src/engine/archive.ts` (new, pure, unit-tested)

```ts
export interface DayStamp {
  date: string              // YYYY-MM-DD, London
  score: number
  correct: number
  total: number
  languages: LangCode[]     // in round order, deduped for display only
  streak: number             // streak value on that day
}

export interface Archive {
  v: 2
  stamps: Record<string, DayStamp>
  firstDate: string
}

export function stampFromDaily(date: string, record: DailyRecord, languages: LangCode[], streak: number): DayStamp
export function addStamp(archive: Archive, stamp: DayStamp): Archive        // idempotent per date
export function monthGrid(archive: Archive, year: number, month: number): (DayStamp | null)[] // Mon-first, padded
export function monthSummary(archive: Archive, year: number, month: number): {
  daysPlayed: number; distinctLanguages: number; languages: LangCode[]; bestScore: number
}
export function archiveStreak(archive: Archive, today: string): number      // recomputed from stamps, not trusted from daily record
export function exportJson(archive: Archive): string
export function importJson(raw: string): Archive | null                     // validates every stamp
```

Rules:
- `monthSummary().distinctLanguages` powers the headline "**41 languages across November**".
- One stamp per date; re-finishing the same day replaces nothing (matches `recordDailyResult`).
- Never infer a streak from `lastDate` alone — recompute by walking back day by day.
- Import validation mirrors `loadDaily`'s defensive parse style (reject, do not throw).

### `src/engine/mastery.ts` (new)

```ts
export interface Mastery { attempts: number; correct: number; lastSeen: string }
export type MasteryBook = Record<LangCode, Mastery>

export function recordAttempt(book: MasteryBook, code: LangCode, correct: boolean, date: string): MasteryBook
export function regionScore(book: MasteryBook, region: Region): { attempts: number; accuracy: number; langsSeen: number; langsKnown: number } | null
```

- `null` = no attempts in that region → render "unexplored", not 0%.
- Region intensity = `accuracy × coverage`, where `coverage = langsSeen / langsInRegion`. This is
  what makes "least knowledgeable regions" legible: unseen reads dark, seen-but-wrong reads red.
- Wire `recordAttempt` in `App.tsx` at the existing reveal-time effect (`App.tsx:161`) so both
  classic and daily feed it, one call per answered round, guarded by `reportedRound`.

### `src/storage.ts` — new keys + migration

| Key | Shape | Notes |
| --- | --- | --- |
| `lingo.daily.v1` | existing | **read-only legacy**, migrated then kept |
| `lingo.daily.v2` | `{ lastDate, streak, best, results, languages: Record<date, LangCode[]> }` | daily record gains per-day languages |
| `lingo.archive.v1` | `Archive` | built from v2 on first load if absent |
| `lingo.mastery.v1` | `MasteryBook` | new |
| `gtl:bestScore`, `gtl:heard`, `gtl:known` | unchanged | untouched |

- `loadDaily` reads v2, falls back to v1 and migrates (`languages: {}`), saves v2, then builds the
  archive from existing results (dates with no language data get `languages: []` and render as a
  plain stamped square — never as empty).
- Cap: raise `DAILY_RESULTS_CAP` 60 → **400** (≈13 months) and cap archive stamps at 800 as a
  safety valve. "Never resets" means growth must not be unbounded.
- Every accessor wrapped in try/catch like the existing ones.

---

## Wave 1 — Archive screen + share card (ship first)

### New components

**`src/components/Archive.tsx`** — full screen, entered from `StartScreen` ("Your archive →")
and from the daily end screen ("See your archive").

Layout (mobile-first, one column, max-width 520 px):
1. Headline: `N-day streak` + `M languages across <Month>` (from `monthSummary`).
2. Month pager: `‹ November 2026 ›` — arrow buttons, no swipe needed; future months disabled.
3. Calendar grid, Monday-first, 7 columns. Each cell:
   - played → surface tile with day number, and up to **4** mini flags (18 px) + `+6` overflow;
     tile gets a subtle stamp settle animation on first reveal.
   - today, unplayed → pulsing ring (CSS only, respects reduced motion).
   - unplayed past → empty cell with 1 px inset border.
   - future → invisible.
4. Selected-day detail (inline, below grid): score, `correct/total`, streak that day, all 10 flags,
   and `Play` / `Replay` deep link for today.
5. Footer actions: **Share card** · **Export** · **Import** (file input, hidden) · `Back`.
6. Empty state (no stamps): one sentence + "Play today's challenge".

Styles: `src/styles/screen-archive.css`, tokens only, reuse `.eyebrow`, `.badge`, `--r-*`.

**`src/components/ShareCard.tsx`** (modal) — canvas render, no deps.

- 1080 × 1350 portrait. Composition: top = streak number + "day streak"; middle = wall of **all
  distinct flags ever collected**, 8 per row, newest last, gaps = empty slots; bottom =
  `<M> languages · <days> days · lingoguess.com`.
- Flags are drawn by `await`-ing `Image()` on `flagSrc(code)`; `crossOrigin` not needed (same
  origin). Compose on an offscreen canvas, then `toBlob('image/png')`.
- Actions: **Download PNG** (`<a download>`), **Share** via `navigator.share({ files })` when
  `navigator.canShare({ files })`, else fall back to download + `copyText(shareText)`.
- Preview in the modal at ≤ 320 px wide so it fits a phone without scrolling the action buttons
  off-screen. `aria-label` on the canvas ("Your Lingo Guess archive card").
- Font: system stack via `ctx.font = '700 44px system-ui, …'` — do **not** rely on the app's
  custom font having loaded in canvas.

**`src/components/StartScreen.tsx`** — add an archive strip: streak, language count, and a
"View archive" button. Keep the existing daily card intact.

### Tests

- `tests/engine/archive.test.ts`: stamp idempotency; streak recomputation across a gap; month grid
  padding for a month starting Sunday and one starting Monday; distinct-language counting; summary
  for an empty month; import rejects malformed JSON / bad dates / unknown codes; export→import
  round-trip equality.
- `tests/engine/mastery.test.ts`: accuracy math; `null` for unseen region; coverage denominator
  excludes languages the player marked as known (they are still map-able, just not "to learn").
- `tests/e2e/archive.spec.ts` (Playwright, against `dist/` via `serve-dist.mjs`):
  seed localStorage with 21 stamps → archive shows 21 filled cells and the month headline;
  open share card → canvas is non-blank (sample pixels, assert >1 distinct colour), download link
  has `download="lingo-archive-*.png"`.

### Gates

```
npx tsc -b            # root tsconfig is a solution-style {files: [], references: []} — tsc --noEmit checks nothing
npm run test          # vitest: engine suites green
npm run e2e           # archive spec green
npm run lint
```
Verification beyond tests: `npm run build`, serve `dist/`, screenshot the archive at 390×844 and
1440×900, and *look* at both.

---

## Wave 2 — Iconography pass on the start screen

**Source of truth:** `.hermes/plans/start-redesign-2026-11-22.jpg` (the user's redesign, 690×840).
Read the image before coding; the table below is the transcription, the image wins on spacing.

**Goal:** the start screen carries its meaning in icons rather than prose. Three text lines
("10 rounds · 3 lives · 70 languages", the difficulty hint paragraph, "2 languages you know are left
out") become icon-led rows, and each difficulty card gets a waveform that encodes how dense its
clips are. This lands **after** wave 1 because it rewrites `StartScreen.tsx`, which wave 1 edits.

### Layout target (top → bottom)

| Region | Spec |
| --- | --- |
| Hero | unchanged: aperture mark 72 px + `Lingo Guess` + "Hear one sentence. Name the language." |
| **HUD pill row** (new, replaces the `hero__spec` text line) | 3 pills, 32 px tall, `--r-pill`, 1 px `--fog-*` border, 11 px tabular numerals, icon 14 px, gap 6 px: `[↻ 10]` rounds · `[♥♥♥]` lives · `[🌐 70]` languages in pool |
| Daily card | same button, restyled: 44×44 date badge (month caps 10 px over day 20 px, teal tint, `--r-2`; month from `Intl.DateTimeFormat('en-GB', { month: 'short' })` — never the system locale, a player in Tokyo must still see `NOV`); eyebrow `DAILY CHALLENGE` in teal; meta row `⌨ Type it · 👥 Same for all`; right-hand arrow (or check when done); score + streak appear in the meta row only when they exist |
| `DIFFICULTY` legend | unchanged eyebrow, letterspaced |
| Difficulty cards | 4 across ≥ 640 px, 2×2 below; each gets a new `DifficultyGlyph` (waveform bars) replacing `TierGlyph`, the name, then 2–3 icon meta rows (below), helper line moves out of the card |
| Helper line | one grey line under the grid, per selected level (existing `LEVELS[].hint`) |
| CTA | amber pill, play glyph inside a 36 px black circle at left, glow behind the pill via a blurred pseudo-element (**not** `box-shadow` on the surface — MOTION.md rule) |
| Divider | 1 px `--fog-*` rule |
| Footer left | pill: teal `check-circle` + "Languages I know" + nested chip `N skipped` (only when N > 0, else `All languages`); whole pill opens the known-languages picker |
| Footer right | `trophy` + best score (only when `bestScore !== null`) |
| Keys row | `speaker` + "Sound on" · `kbd 1`–`kbd 4` answer · `kbd R` replay (keep the touch-only variant) |

### Per-card meta rows (transcribe exactly)

| Level | Glyph bars | Meta row 1 | Meta row 2 | Meta row 3 |
| --- | --- | --- | --- | --- |
| Easy | 3 bars | `star` Famous | `short-clips` Short clips | — |
| Normal | 6 bars | `plus-circle` + Familiar | `short-clips` Longer clips | — |
| Hard | 9 bars | `look-alikes` Look-alikes | `diamond` Rare words | — |
| Expert | 12 bars | `look-alikes` Look-alikes | `choices` 5 choices | `speed` Full speed |

`DifficultyGlyph`: `bars: number` (3/6/9/12), heights from a fixed per-level array so the four read
as progressively denser speech; `currentColor`, `aria-hidden`, 24 px tall. It is decorative — the
card's text already names the level.

### Icons to add to `src/components/Icon.tsx`

Existing set is `play, replay, arrow, check, cross, dash, chevron, search, share, aperture, warn`.
Add: `heart`, `globe`, `keyboard`, `users`, `star`, `short-clips` (double dash), `plus-circle`,
`look-alikes` (two offset squares), `diamond`, `choices` (bulleted lines), `speed` (two chevrons),
`check-circle`, `trophy`, `speaker`, `calendar` (archive entry). Keep the hand-drawn 24×24 stroke
style, `strokeWidth 2`, no fills except `heart`/`play`.

**Do not use emoji for hearts, flags or the globe.** Windows renders `❤️` and `🔥` inconsistently and
the repo already ships SVG flags for exactly this reason.

### The one conflict with wave 1, and the resolution

The redesign has no archive entry, but wave 1 adds `ArchiveStrip` under the daily card. **Keep the
strip** — it is the "41 languages collected" brag line and the product's core hook — and restyle it
to match the new language: calendar icon, pill surface, same single line, `View archive` as a ghost
button with the arrow. **Do not** add a fourth HUD pill: the pill row is game parameters, the strip
is progress.

### Accessibility and tests

- Pills are static information, not buttons: `<ul>`/`<p>` with a visually-hidden expansion
  ("10 rounds", "3 lives", "70 languages in play"). Hearts get `aria-hidden` and the list item
  carries the text.
- The difficulty cards stay `<label>`+radio; keep `:has(.control-input:focus-visible)` focus ring
  and the `is-selected` state, now teal border + tint.
- `tests/e2e/start.spec.ts` (new): each pill's text matches `ROUNDS`/`LIVES`/`pool.length`; selecting
  Expert shows three meta rows and the helper line switches to the expert string; footer chip reads
  `2 skipped` when two languages are excluded and `All languages` at zero; archive strip still opens
  the archive (regression guard for wave 1).
- Visual check at 390×844 (2×2 cards, no horizontal scroll) and 1440×900 (4 across).

---

## Wave 3 — Google sign-in & sync (optional, opt-in after play)

**Product rule:** the game must stay fully playable signed out, forever. Sign-in is recommended
*after* there is something to lose — never a gate, never a modal on arrival.

### The nudge (client)

- **First impression:** on the Daily end screen, immediately after the first completed daily only,
  a quiet inline card under the score: `Keep this streak — save your archive` + `Sign in with
  Google` + `Not now`. Not a modal, no backdrop, does not block the end screen's own buttons.
- **Repeat impressions:** the signed-out strip in `Archive` ("Stored on this device only — sign in
  to keep it") — persistent but one line tall.
- **Suppression:** at most one nudge per session; after **2 dismissals** suppress for 30 days
  (`lingo.nudge.v1 = { dismissed: n, until: ISO }`); never shown when signed in. A successful
  sign-in clears it.
- Copy never claims security it does not have: "keep it if you change phone", not "backed up".

### Auth flow — OAuth 2.0 authorization-code + PKCE, server-side exchange

Chosen over Google Identity Services on purpose: GIS loads `accounts.google.com/gsi/client`, a
third-party script on a site whose whole privacy posture is "no third-party scripts, no cookies".
The redirect flow keeps that claim honest — no Google JS in the page, a plain link to Google, a
session cookie only for people who opt in.

```
GET  /admin/api/auth_start.php    → sets HttpOnly state+verifier cookie (5 min), 302 to Google
GET  /admin/api/auth_callback.php → verifies state, exchanges code (client secret, server-side),
                                    verifies id_token (iss/aud/exp/email_verified), upserts player,
                                    sets `lingo_sess` (HttpOnly, Secure, SameSite=Lax, Path=/,
                                    90-day rolling), 302 back to /?signed_in=1
GET  /admin/api/me.php            → { signed_in, name, picture, data_updated_at } or {signed_in:false}
GET  /admin/api/sync.php          → { data, updated_at }  (404-free: empty data for new player)
PUT  /admin/api/sync.php          → body { data, base_updated_at } → 200 {updated_at} | 409 {data, updated_at}
DELETE /admin/api/account.php     → hard-deletes the player row, clears cookie
POST /admin/api/auth_logout.php   → clears cookie
```

Rules:
- `sync.php` requires a valid session **and** `X-Lingo-Client: 1` on PUT (SameSite=Lax is not CSRF
  protection on its own); reuses the existing Origin check and `rate_limit()`.
- Payload is **one opaque versioned JSON blob** (`{v, archive, mastery, daily}`) in
  `players.data_json`, max 256 KB. Server never parses game state, so waves 3–4 need no migration.
- `base_updated_at` gives last-write-wins with a conflict reply; the client merges (union stamps by
  date preferring the higher score, sum mastery attempts/corrects, union daily results, recompute
  streak from stamps) and retries **once**. A second 409 shows "sync paused, your data is safe
  locally" and stops — no data loss path.
- Sync triggers: on sign-in (merge+push), after each completed daily, after each completed game
  (debounced 5 s), and on `visibilitychange → hidden`. Failures are silent except the archive strip
  showing "not synced since <time>".

### Server

`server/admin/lib/db.php` — new table:

```sql
CREATE TABLE IF NOT EXISTS players (
  id               INTEGER PRIMARY KEY,
  google_sub       TEXT NOT NULL UNIQUE,
  email            TEXT NOT NULL,
  name             TEXT,
  picture          TEXT,
  created_at       INTEGER NOT NULL,
  last_login       INTEGER,
  data_json        TEXT,
  data_updated_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_players_email ON players(email);
```

`config.php` gains `google_client_id` / `google_client_secret` (written by `install_admin.py`,
never committed, `.htaccess` already blocks non-PHP files in `/admin`). Google's JWKS fetched once
per 24 h into `STORAGE/jwks.json` via curl with a 5 s timeout; if the fetch fails, verification
fails closed (500 `auth_unavailable`) rather than trusting an unchecked token.

`bootstrap.php` CSP: `form-action` must allow `https://accounts.google.com`; `connect-src 'self'`
unchanged (no GIS). No new third-party script is added anywhere.

### Privacy / compliance work in this wave (non-negotiable)

- `server/README.md` currently says "no cookies, no third-party scripts". Amend to: *no cookies or
  third-party scripts unless you sign in with Google; then one first-party session cookie and a
  redirect to Google at sign-in*.
- Add `/privacy` static page: what is stored (Google sub, email, name, picture, archive JSON), why,
  where (Hostinger, EU), how to delete (one button in Archive → account delete), and that gameplay
  works without an account.
- Account deletion is a hard `DELETE` (no soft delete) plus cookie clear; the client then wipes the
  sync markers but keeps the local archive, telling the player plainly that it is now device-only.
- `install_admin.py` prints the redirect URI to register: `https://lingoguess.com/admin/api/auth_callback.php`
  (and `http://localhost:8099/admin/api/auth_callback.php` for local dev).

### Tests

- `tests/security/test_accounts.py` (new, extends the existing live suite): `/admin/api/me.php`
  returns `signed_in:false` without a cookie; `sync.php` PUT without the client header → 403;
  PUT with a forged/expired session → 401; oversized payload → 413; `account.php` DELETE without
  session → 401; after a seeded session, delete removes the row (verified by a second `me.php`).
- `tests/engine/sync.test.ts`: merge is commutative and idempotent (property-ish: merge(a,b) ==
  merge(b,a) for stamps/mastery sums); conflict retry yields one server push.
- E2E: signed-out daily completion shows the nudge once; `Not now` twice → suppressed (assert the
  `lingo.nudge.v1` value); signing in via a stubbed `/admin/api/me.php` shows the signed-in strip and
  hides the nudge.

### Blocker only the user can clear

Google Cloud Console → APIs & Services → OAuth consent screen (External; add his own Google account
as a test user while in Testing) → Credentials → Create credentials → OAuth client ID → **Web
application** → Authorised redirect URIs: the two above. Then hand over the **client ID** and
**client secret**. These are server-side credentials; he should not paste them in chat if he'd
rather not — the alternative is he writes them into `/root/.lingo-google` on this box and the
implementer reads the file.

---

## Wave 4 — World map (knowledge coverage)

### Map data — no new deps

`src/data/worldMask.ts`: a committed dot-matrix land mask, ~110 × 54 cells, one string per row with
`.`, `#`, and nothing else; plus `MASK_LON0/LAT0/DLON/DLAT` for cell → lat/lon. Generate it once
offline from a public-domain coastline (Natural Earth 110m via a throwaway script in
`scripts/make_world_mask.mjs`) and commit the **output only** — the build must not need network.

Each cell gets a region by nearest `REGIONS.anchor` (haversine on cell centre, computed once at
module load, memoised). No ocean cells are rendered at all.

**`src/motion/WorldMap.tsx`** — canvas, DPR cap 2, ≤30 fps, draws:
- land cells as 1.6 px dots at `--fog-400` 12% (unexplored),
- cells belonging to a region with data tinted by `regionScore`: red (`--signal-*` low accuracy) →
  amber → cyan (high), opacity by coverage,
- the player's best languages as brighter flags/pips at their region anchor.

Props: `book: MasteryBook`, `onSelectRegion?`, `animate?: boolean`, `reduced: boolean`.

**`src/components/KnowledgeMap.tsx`** — screen wrapper: map + region legend list, sorted
least→most knowledgeable, each row `flag, language count, accuracy bar`. Tapping a region filters
the list to that region's languages. Reachable from StartScreen ("Your map") and the archive footer.

### Wiring

- `recordAttempt` in `App.tsx` (see above).
- Region aggregation is O(72) — compute with `useMemo`, no state.

### Tests

- `tests/engine/regions.test.ts`: every `LANGUAGES` row has a `region`; every region id in
  `REGIONS` exists; no language assigned to a region without an anchor; region counts sum to 72.
- `tests/engine/mastery.test.ts` additions: region intensity monotonic in accuracy and coverage.
- E2E: seed a mastery book → map canvas non-blank; legend shows "unexplored" for a region with no
  attempts.

---

## Wave 5 — Post-game motion reveal

**`src/motion/MapReveal.tsx`** — full-bleed overlay, ~5.5 s (daily) / 3 s (classic), six beats:

1. **0.0–0.6 s** — dots converge from the ambient field into the land mask (stagger by distance
   from centre; `--ease-settle`).
2. **0.6–1.4 s** — coastline resolves; region anchors fade in.
3. **1.4–3.0 s** — regions ignite in ascending mastery order, a soft ripple each.
4. **3.0–3.8 s** — this run's languages fly in as flag chips and snap to their region; correct
   answers land bright, misses land red then settle to dim.
5. **3.8–4.8 s** — counter rolls: `+N languages`, new streak, `M / 72 collected`.
6. **4.8–5.5 s** — everything settles, "Tap to continue" appears (last 1.2 s only, so it does not
   invite a skip before the payload is seen).

Rules:
- Skippable at any moment by click, tap, `Enter`, `Space`, or `Escape` → immediate final frame, no
  exit animation (MOTION.md: input is never gated).
- `prefers-reduced-motion` → render the final frame for 1.2 s with no movement, then auto-dismiss;
  skip label always present.
- Never block the game: the overlay is a sibling of the screen, `position: fixed`, outside
  `ScreenTransition`'s transformed wrapper.
- Runs after the **EndScreen mounts**, not instead of it (state stays `over`), so a skip lands the
  player on the normal end screen.
- One per completed game; a `lingo.motionSeen` flag suppresses repeat plays within the same
  session only (keeps the promise of "after every game" while not annoying during replays).
- Analytics: `map_reveal` with `{ skipped: true|false, ms }` and `map_reveal_done`.

### Tests

- Vitest (motion root): timeline returns the expected beat at t=0/2/4/6; skipping yields the final
  frame state; reduced motion yields final frame at t=0.
- E2E: finish a seeded game → overlay appears → click → EndScreen visible within 300 ms; console
  clean; second game in the same session does not re-show.

---

## Files likely to change

| File | Change |
| --- | --- |
| `src/data/languages.ts` | add `region` to every row + `Region` type |
| `src/data/regions.ts` | **new** display metadata + anchors |
| `src/data/worldMask.ts` | **new** committed dot mask (wave 2) |
| `scripts/make_world_mask.mjs` | **new** offline generator (wave 2, not shipped) |
| `src/engine/archive.ts` | **new** stamps, grids, summaries, export/import |
| `src/engine/mastery.ts` | **new** per-language book, region scores |
| `src/engine/daily.ts` | `DAILY_RESULTS_CAP` 60→400; return languages in `resultOf` |
| `src/storage.ts` | v2 migration, archive + mastery keys, export/import |
| `src/App.tsx` | archive/map screen flags, `recordAttempt` wiring, reveal mount |
| `src/components/Archive.tsx`, `ShareCard.tsx`, `KnowledgeMap.tsx` | **new** (wave 1 / wave 4) |
| `src/components/Icon.tsx` | +15 hand-drawn icons (wave 2) |
| `src/components/DifficultyGlyph.tsx` | **new** waveform-per-tier glyph (wave 2) |
| `src/styles/screen-start.css` | pill row, date badge, card meta rows, CTA glow, footer pills (wave 2) |
| `tests/e2e/start.spec.ts` | **new** iconography + archive-strip regression (wave 2) |
| `src/components/SignInNudge.tsx`, `AccountStrip.tsx` | **new** (wave 3) |
| `src/engine/sync.ts` | **new** merge + push/pull client (wave 3) |
| `server/admin/api/auth_start.php`, `auth_callback.php`, `auth_logout.php`, `me.php`, `sync.php`, `account.php` | **new** (wave 3) |
| `server/admin/lib/db.php` | `players` table (wave 3) |
| `server/admin/lib/google.php` | **new** token exchange + JWKS verify (wave 3) |
| `server/admin/lib/bootstrap.php` | CSP `form-action` for Google (wave 3) |
| `/root/install_admin.py` | write Google client keys, print redirect URI (wave 3) |
| `public/privacy/index.html` or SPA route | **new** privacy page (wave 3) |
| `src/components/StartScreen.tsx` | archive/map entry points; **wave 2 rewrites it** |
| `src/components/DailyChallenge.tsx` | pass languages into the record; archive CTA on end |
| `src/motion/WorldMap.tsx`, `MapReveal.tsx`, `index.ts` | **new** + export |
| `src/motion/MOTION.md` | document the two new components' mounting rules |
| `src/styles/screen-archive.css`, `screen-map.css`, `map-reveal.css` | **new**; `index.css` imports |
| `tests/engine/archive.test.ts`, `mastery.test.ts`, `regions.test.ts` | **new** |
| `tests/e2e/archive.spec.ts`, `map-reveal.spec.ts` | **new** |
| `README.md`, `VERIFICATION.md` | modes + observed results |

---

## Risks & trade-offs

1. **Device-local archive is the whole product, and it is fragile.** No accounts, no sync. Commit
   to Export/Import in wave 1 and say so in the UI. Server sync is a separate, larger wave.
2. **"Never resets" vs storage limits.** 400-day cap is ~13 months; localStorage ~5 MB is ample for
   ~800 stamps (~150 KB). Say "never resets" in copy only if the cap is not user-visible.
3. **Dot-matrix map ≠ geography.** Stylised, on-brand, cheap; it cannot support "zoom to a country".
   If country-level detail is wanted later, that is a d3-geo swap (one component).
4. **Canvas text and flags on iOS.** Flag SVGs are same-origin so `drawImage` will not taint the
   canvas; verify a real PNG download on a phone before claiming it works.
5. **Motion reveal on every game may feel long on the 5th replay.** Session-only suppression is the
   compromise; watch the `skipped` analytics before making it permanent.
6. **Streak correctness across time zones/DST.** All date maths already goes through
   `londonDateKey`/`previousDateKey` (UTC-based). New code must not use `new Date().getDate()`.

## Assumptions

- Archive stamps come from **daily only**; classic runs feed the mastery map but never stamp.
- Mastery counts every answered round in both modes, including skips as attempts (incorrect).
- Signed-out play is permanent and complete; the account only adds cross-device persistence.
- New npm packages: none. New PHP dependencies: none (PDO, curl, openssl only).
- Wave 1 has no auth dependency and ships immediately; wave 2 (icons) is UI-only and also unblocked;
  wave 3 needs the Google client credentials before it can be tested end-to-end on the live domain.
- Wave 1 ships to `lingoguess.com`; waves 2–5 ship when the user says so.
