import { expect, test, type Page } from '@playwright/test'
import { LANGUAGES } from '../../src/data/languages.ts'
import { londonDateKey } from '../../src/engine/daily.ts'
import { LIVES, ROUNDS } from '../../src/engine/game.ts'

/** Uncaught page errors and console errors, so each test can assert there were none. */
function trackErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
  })
  return errors
}

/** Land on the start screen with these languages marked as known. */
async function openStart(page: Page, known: string[]) {
  await page.addInitScript((raw) => localStorage.setItem('gtl:known', raw), JSON.stringify(known))
  await page.goto('./')
  await expect(page.locator('.screen--start')).toBeVisible()
}

test('the spec pills read rounds, lives and the pool', async ({ page }) => {
  const errors = trackErrors(page)
  const known = ['es-ES', 'fr-FR']
  await openStart(page, known)

  const pool = LANGUAGES.length - known.length
  await expect(page.getByTestId('pill-rounds')).toHaveText(`${ROUNDS} rounds`)
  await expect(page.getByTestId('pill-lives')).toHaveText(`${LIVES} lives`)
  await expect(page.getByTestId('pill-lives').locator('svg')).toHaveCount(LIVES)
  await expect(page.getByTestId('pill-languages')).toHaveText(`${pool} languages in play`)
  // Static readouts, not controls.
  await expect(page.locator('.spec-pills button')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('the daily badge shows the en-GB month and day', async ({ page }) => {
  await openStart(page, [])
  const today = londonDateKey()
  const [y, m, d] = today.split('-').map(Number) as [number, number, number]
  const month = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(Date.UTC(y, m - 1, d))
  const badge = page.getByTestId('daily-date')
  await expect(badge).toHaveAttribute('datetime', today)
  await expect(badge).toHaveText(`${month}${d}`)
})

test('selecting Expert shows its three facts and the expert helper line', async ({ page }) => {
  const errors = trackErrors(page)
  await openStart(page, [])

  await expect(page.getByTestId('level-hint')).toHaveText('Adds the recognisable ones · longer sentences')
  const expert = page.getByTestId('level-expert')
  await expert.click()
  await expect(expert.getByRole('radio')).toBeChecked()
  await expect(expert).toHaveClass(/is-selected/)
  await expect(expert.locator('.level__fact')).toHaveText(['Look-alikes', '5 choices', 'Full speed'])
  await expect(page.getByTestId('level-hint')).toHaveText('Confusable languages only · 5 choices · no slow-down')
  expect(errors).toEqual([])
})

test('the known-languages chip counts exclusions', async ({ page }) => {
  await openStart(page, ['es-ES', 'fr-FR'])
  await expect(page.getByTestId('excluded-count')).toHaveText('2 skipped')
  await page.getByTestId('edit-known').click()
  await expect(page.getByTestId('know-languages')).toBeVisible()
})

test('the chip reads All languages with nothing excluded', async ({ page }) => {
  await openStart(page, [])
  await expect(page.getByTestId('excluded-count')).toHaveText('All languages')
})

test('the archive strip still opens the archive', async ({ page }) => {
  const errors = trackErrors(page)
  await openStart(page, [])
  await expect(page.getByTestId('archive-open')).toHaveAccessibleName('View archive')
  await page.getByTestId('archive-open').click()
  await expect(page.getByTestId('archive')).toBeVisible()
  expect(errors).toEqual([])
})

test('phone width: 2×2 cards and no horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openStart(page, [])
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(scroll).toBeLessThanOrEqual(390)
  const easy = await page.getByTestId('level-easy').boundingBox()
  const hard = await page.getByTestId('level-hard').boundingBox()
  expect(hard!.y).toBeGreaterThan(easy!.y)
  expect(Math.round(hard!.x)).toBe(Math.round(easy!.x))
})
