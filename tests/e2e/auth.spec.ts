import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { addStamp, emptyArchive, exportJson } from '../../src/engine/archive.ts'
import { londonDateKey } from '../../src/engine/daily.ts'

/**
 * The account gate on /archive. The `api` fixture (see fixtures.ts) stands in
 * for /admin/api on the static test server, so these tests exercise the real
 * client against the real endpoint contracts: signed out, signed in, the
 * local-days offer, and sign-out.
 */

function trackErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
  })
  return errors
}

/** One stamped day (today) in this browser, so "days on this device" means something. */
function seedOneDay(page: Page, languages: string[]) {
  const today = londonDateKey()
  const archive = addStamp(emptyArchive(), {
    date: today,
    score: 120,
    correct: 6,
    total: 10,
    languages: languages as never[],
    streak: 1,
  })
  return page.addInitScript((raw: string) => {
    localStorage.setItem('gtl:known', '[]')
    localStorage.setItem('lingo.archive.v1', raw)
  }, exportJson(archive))
}

test('signed out, /archive is a gate: no calendar, no stamps', async ({ page }) => {
  const errors = trackErrors(page)
  await page.addInitScript(() => localStorage.setItem('gtl:known', '[]'))
  await page.goto('./archive')

  await expect(page.getByTestId('archive-gate')).toBeVisible()
  await expect(page.getByTestId('gate-signin')).toBeVisible()
  // The record itself must not be on the page at all.
  await expect(page.getByTestId('archive')).toHaveCount(0)
  await expect(page.getByTestId('archive-streak')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('signing in from the gate lands on the archive with the account row', async ({ page, api }) => {
  const errors = trackErrors(page)
  await page.addInitScript(() => localStorage.setItem('gtl:known', '[]'))
  await page.goto('./archive')
  await expect(page.getByTestId('archive-gate')).toBeVisible()

  await page.getByTestId('gate-signin').click()

  await expect(page).toHaveURL(/\/archive$/)
  await expect(page.getByTestId('archive')).toBeVisible()
  // The account row greets by name; the email is not shown on screen.
  await expect(page.getByTestId('account-row')).toContainText('Ada Lovelace')
  expect(api.calls).toContain('GET auth_start.php')
  expect(errors).toEqual([])
})

test('local days are offered to the account, and nothing is pushed until accepted', async ({ page, api }) => {
  const errors = trackErrors(page)
  api.signIn()
  await seedOneDay(page, ['es-ES', 'fr-FR', 'de-DE'])
  await page.goto('./archive')

  await expect(page.getByTestId('sync-offer')).toBeVisible()
  await expect(page.getByTestId('sync-offer')).toContainText('1')
  // Not linked yet: the account has not been written to.
  expect(api.puts).toHaveLength(0)

  await page.getByTestId('sync-offer-accept').click()

  await expect.poll(() => api.puts.length).toBeGreaterThan(0)
  const pushed = api.lastPushed()
  const today = londonDateKey()
  expect(Object.keys(pushed?.archive.stamps ?? {})).toContain(today)
  expect(api.missingHeader).toEqual([])
  expect(errors).toEqual([])
})

test('signing out returns to the gate', async ({ page, api }) => {
  const errors = trackErrors(page)
  api.signIn()
  await page.addInitScript(() => localStorage.setItem('gtl:known', '[]'))
  await page.goto('./archive')
  await expect(page.getByTestId('account-row')).toBeVisible()

  await page.getByTestId('account-signout').click()

  await expect(page.getByTestId('archive-gate')).toBeVisible()
  await expect(page.getByTestId('archive')).toHaveCount(0)
  expect(errors).toEqual([])
})
