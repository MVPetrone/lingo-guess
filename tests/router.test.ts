import { describe, expect, it } from 'vitest'
import { parseRoute, pathOf, type Route } from '../src/router.ts'

describe('parseRoute', () => {
  const table: [string, Route | null][] = [
    ['/', { name: 'home' }],
    ['/daily', { name: 'daily' }],
    ['/archive', { name: 'archive' }],
    ['/play', { name: 'play' }],
    // A trailing slash is the same page, not a mismatch.
    ['/daily/', { name: 'daily' }],
    ['/archive//', { name: 'archive' }],
    ['', { name: 'home' }],
    // Unknown: the caller replaces the URL with '/'.
    ['/nope', null],
    ['/daily/extra', null],
    ['/DAILY', null],
    ['/index.html', null],
  ]

  it.each(table)('%j → %j', (path, route) => {
    expect(parseRoute(path)).toEqual(route)
  })
})

describe('pathOf', () => {
  it('round-trips every route', () => {
    for (const name of ['home', 'daily', 'archive', 'play'] as const) {
      expect(parseRoute(pathOf({ name }))).toEqual({ name })
    }
  })
})
