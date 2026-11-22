import type { Page } from '@playwright/test'
import { expect, test, type FakeApi } from './fixtures.ts'
import { LANGUAGES } from '../../src/data/languages.ts'
import { addStamp, emptyArchive, exportJson, monthSummary, type Archive } from '../../src/engine/archive.ts'
import { serialize } from '../../src/engine/syncMerge.ts'
import { londonDateKey, previousDateKey } from '../../src/engine/daily.ts'

/** Uncaught page errors and console errors, so each test can assert there were none. */
function trackErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
  })
  return errors
}

const STAMPED = 21

/** 21 consecutive days ending today, ten languages each, overlapping day to day. */
function seededArchive(today: string): Archive {
  let archive = emptyArchive()
  let date = today
  for (let i = 0; i < STAMPED; i++) {
    const languages = Array.from({ length: 10 }, (_, k) => LANGUAGES[(i * 4 + k) % LANGUAGES.length]!.code)
    archive = addStamp(archive, { date, score: 100 * (i % 10), correct: i % 11, total: 10, languages, streak: STAMPED - i })
    date = previousDateKey(date)
  }
  return archive
}

async function openArchive(page: Page, api: FakeApi, archive: Archive | null) {
  // The archive is account-only now, so every case starts signed in — with the
  // account already holding this device's days, which is the "in step" state
  // (otherwise the local-days offer, not the calendar, is the subject).
  api.signIn(archive ? { data: serialize(archive, null) } : {})
  await page.addInitScript(
    ([raw]) => {
      // Skip the known-languages picker; the archive is the subject here.
      localStorage.setItem('gtl:known', '[]')
      if (raw) localStorage.setItem('lingo.archive.v1', raw)
    },
    [archive ? exportJson(archive) : null],
  )
  await page.goto('./')
  // The archive's entry is the fixed side control, not a strip in the flow.
  await page.getByTestId('archive-open').click()
  await expect(page).toHaveURL(/\/archive$/)
  await expect(page.getByTestId('archive')).toBeVisible()
}

test('21 stamped days fill 21 cells and the headline counts them', async ({ page, api }) => {
  const errors = trackErrors(page)
  const today = londonDateKey()
  const archive = seededArchive(today)
  const [year, month, day] = today.split('-').map(Number) as [number, number, number]

  await openArchive(page, api, archive)

  await expect(page.getByTestId('archive-streak')).toHaveText(`${STAMPED}-day streak`)
  const monthName = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(Date.UTC(year, month - 1, 1))
  const { distinctLanguages } = monthSummary(archive, year, month)
  await expect(page.getByTestId('archive-languages')).toHaveText(`${distinctLanguages} languages across ${monthName}`)

  // The run may straddle two months; together they hold every stamp.
  const thisMonth = Math.min(day, STAMPED)
  await expect(page.getByTestId('archive-day')).toHaveCount(thisMonth)
  await expect(page.getByTestId('archive-next')).toBeDisabled()
  if (thisMonth < STAMPED) {
    await page.getByTestId('archive-prev').click()
    await expect(page.getByTestId('archive-day')).toHaveCount(STAMPED - thisMonth)
    await expect(page.getByTestId('archive-prev')).toBeDisabled()
  } else {
    await expect(page.getByTestId('archive-prev')).toBeDisabled()
  }

  // Each stamped cell shows at most four flags plus an overflow count.
  const first = page.getByTestId('archive-day').first()
  await expect(first.locator('.flag')).toHaveCount(4)
  await expect(first.locator('.archive-cell__more')).toHaveText('+6')
  await first.getByRole('button').click()
  await expect(page.getByTestId('archive-detail').locator('.flag')).toHaveCount(10)

  // Back returns home, where the side control is the way in again.
  await page.getByTestId('archive-back').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('archive-open')).toBeVisible()
  expect(errors).toEqual([])
})

test('the share card draws a non-blank canvas and downloads a PNG', async ({ page, api }) => {
  const errors = trackErrors(page)
  const today = londonDateKey()
  await openArchive(page, api, seededArchive(today))

  await page.getByTestId('archive-share').click()
  const card = page.getByTestId('share-card')
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-ready', 'true')

  const colours = await page.getByTestId('share-card-canvas').evaluate((el) => {
    const canvas = el as HTMLCanvasElement
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    const seen = new Set<number>()
    // Every 97th pixel is plenty to tell a drawn card from a flat fill.
    for (let i = 0; i < data.length; i += 4 * 97) seen.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!)
    return seen.size
  })
  expect(colours).toBeGreaterThan(1)
  expect(colours).toBeGreaterThan(50) // flags, not just text on a gradient

  const link = page.getByTestId('share-card-download')
  await expect(link).toHaveAttribute('download', /^lingo-archive-.*\.png$/)
  await expect(link).toHaveAttribute('download', `lingo-archive-${today}.png`)
  await expect(link).toHaveAttribute('href', /^blob:/)
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()])
  expect(download.suggestedFilename()).toBe(`lingo-archive-${today}.png`)

  await page.keyboard.press('Escape')
  await expect(card).toBeHidden()
  expect(errors).toEqual([])
})

test('an empty archive explains itself, and imports an exported file', async ({ page, api }) => {
  const errors = trackErrors(page)
  const today = londonDateKey()
  await openArchive(page, api, null)
  await expect(page.getByTestId('archive-empty')).toBeVisible()

  const input = page.getByTestId('archive-import')
  await input.setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"v":2,"stamps":{"x":1}}') })
  await expect(page.getByRole('status')).toHaveText('That file isn’t a Lingo Guess archive.')

  const file = exportJson(seededArchive(today))
  await input.setInputFiles({ name: 'archive.json', mimeType: 'application/json', buffer: Buffer.from(file) })
  await expect(page.getByTestId('archive-streak')).toHaveText(`${STAMPED}-day streak`)
  await expect(page.getByRole('status')).toHaveText(`Imported ${STAMPED} new days.`)
  expect(errors).toEqual([])
})
