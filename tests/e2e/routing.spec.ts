import { expect, test, type Page } from '@playwright/test'

/** Uncaught page errors and console errors, so each test can assert there were none. */
function trackErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
  })
  return errors
}

/** Skip the known-languages picker so home is the start screen. */
async function knowNone(page: Page) {
  await page.addInitScript(() => localStorage.setItem('gtl:known', '[]'))
}

const HOME = /127\.0\.0\.1:\d+\/$/

test('daily card → /daily, already in round 1; back → /', async ({ page }) => {
  const errors = trackErrors(page)
  await knowNone(page)
  await page.goto('./')
  await page.getByTestId('daily-card').click()

  await expect(page).toHaveURL(/\/daily$/)
  // One tap: the round is on screen, no intermediate call to action.
  await expect(page.getByTestId('round-counter')).toHaveText('1/10')
  await expect(page.getByRole('combobox')).toBeVisible()
  await expect(page.getByTestId('daily-start')).toHaveCount(0)

  await page.goBack()
  await expect(page).toHaveURL(HOME)
  await expect(page.locator('.screen--start')).toBeVisible()
  // Abandoned mid-round: nothing recorded.
  expect(await page.evaluate(() => localStorage.getItem('lingo.daily.v2'))).toBeNull()
  expect(errors).toEqual([])
})

test('a classic game lives on /play; back → /', async ({ page }) => {
  const errors = trackErrors(page)
  await knowNone(page)
  await page.goto('./')
  await page.getByRole('button', { name: /start listening/i }).click()
  await expect(page).toHaveURL(/\/play$/)
  await expect(page.getByTestId('round-counter')).toHaveText('1/10')

  await page.goBack()
  await expect(page).toHaveURL(HOME)
  await expect(page.locator('.screen--start')).toBeVisible()
  await expect(page.getByTestId('round-counter')).toHaveCount(0)

  // Forward finds no game in memory and lands home rather than on a blank /play.
  await page.goForward()
  await expect(page).toHaveURL(HOME)
  await expect(page.locator('.screen--start')).toBeVisible()
  expect(errors).toEqual([])
})

test('archive: side control → /archive, back (browser and in-UI) → /', async ({ page }) => {
  const errors = trackErrors(page)
  await knowNone(page)
  await page.goto('./')
  await page.getByTestId('archive-open').click()
  await expect(page).toHaveURL(/\/archive$/)
  await page.goBack()
  await expect(page).toHaveURL(HOME)

  await page.getByTestId('archive-open').click()
  await page.getByTestId('archive-back').click()
  await expect(page).toHaveURL(HOME)
  // The in-UI Back popped the entry, exactly like the browser's.
  await page.goForward()
  await expect(page).toHaveURL(/\/archive$/)
  expect(errors).toEqual([])
})

test('direct /archive loads in place, and its Back goes home without leaving the site', async ({ page }) => {
  const errors = trackErrors(page)
  await knowNone(page)
  await page.goto('./archive')
  await expect(page.getByTestId('archive')).toBeVisible()
  await page.reload()
  await expect(page).toHaveURL(/\/archive$/)
  await expect(page.getByTestId('archive')).toBeVisible()
  await page.getByTestId('archive-back').click()
  await expect(page).toHaveURL(HOME)
  await expect(page.locator('.screen--start')).toBeVisible()
  expect(errors).toEqual([])
})

test('direct /daily and /daily/ load the round; a reload stays on /daily', async ({ page }) => {
  const errors = trackErrors(page)
  await page.goto('./daily/')
  await expect(page).toHaveURL(/\/daily$/)
  await expect(page.getByTestId('round-counter')).toHaveText('1/10')
  await page.reload()
  await expect(page).toHaveURL(/\/daily$/)
  await expect(page.getByTestId('round-counter')).toHaveText('1/10')
  expect(errors).toEqual([])
})

test('/play with no game in memory lands on /', async ({ page }) => {
  const errors = trackErrors(page)
  await knowNone(page)
  await page.goto('./play')
  await expect(page).toHaveURL(HOME)
  await expect(page.locator('.screen--start')).toBeVisible()
  expect(errors).toEqual([])
})

test('legacy ?daily=1 becomes /daily', async ({ page }) => {
  const errors = trackErrors(page)
  await page.goto('./?daily=1')
  await expect(page).toHaveURL(/\/daily$/)
  await expect(page.getByTestId('round-counter')).toHaveText('1/10')
  expect(errors).toEqual([])
})

test('an unknown path is replaced with /', async ({ page }) => {
  const errors = trackErrors(page)
  await knowNone(page)
  const res = await page.goto('./no-such-page')
  expect(res?.status()).toBe(200)
  await expect(page).toHaveURL(HOME)
  await expect(page.locator('.screen--start')).toBeVisible()
  expect(errors).toEqual([])
})

test('a missing asset still 404s instead of serving the app', async ({ request }) => {
  const res = await request.get('./assets/no-such-file.js')
  expect(res.status()).toBe(404)
})
