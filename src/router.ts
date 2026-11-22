import { useSyncExternalStore } from 'react'

/**
 * Five paths, no router library. Forward moves push, corrections replace, and
 * every in-app entry is tagged in history.state so "back" can tell a page we
 * pushed from one the visitor arrived on from elsewhere.
 */
export type Route = { name: 'home' } | { name: 'daily' } | { name: 'archive' } | { name: 'play' }

const PATHS: Record<Route['name'], string> = {
  home: '/',
  daily: '/daily',
  archive: '/archive',
  play: '/play',
}

const BY_PATH = new Map(Object.entries(PATHS).map(([name, path]) => [path, { name } as Route]))

/** null = unknown path; the caller replaces it with '/'. A trailing slash is ignored. */
export function parseRoute(pathname: string): Route | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  return BY_PATH.get(path || '/') ?? null
}

export function pathOf(route: Route): string {
  return PATHS[route.name]
}

/** Marks an entry this app pushed, so the entry before it is ours too. */
type HistoryState = { lingo: true } | null

function pushedByUs(): boolean {
  return (window.history.state as HistoryState)?.lingo === true
}

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const url = pathOf(route) + window.location.search + window.location.hash
  if (opts.replace) {
    // A correction keeps the entry's tag: it is still the same step in history.
    window.history.replaceState(window.history.state, '', url)
  } else {
    if (window.location.pathname === pathOf(route)) return
    window.history.pushState({ lingo: true } satisfies HistoryState, '', pathOf(route))
  }
  notify()
}

/**
 * Behaves like the browser's back button when the previous entry is ours;
 * on a page opened directly (a shared /daily link) it goes home instead of
 * leaving the site.
 */
export function backOrHome(): void {
  if (window.history.length > 1 && pushedByUs()) window.history.back()
  else navigate({ name: 'home' }, { replace: true })
}

/**
 * Canonicalises the address bar once, before the first render: legacy
 * `?daily=1` becomes /daily, `/daily/` becomes /daily, unknown paths become /.
 */
export function normalizeLocation(): void {
  const url = new URL(window.location.href)
  let route = parseRoute(url.pathname) ?? { name: 'home' }
  if (url.searchParams.get('daily') === '1') {
    url.searchParams.delete('daily')
    route = { name: 'daily' }
  }
  url.pathname = pathOf(route)
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) window.addEventListener('popstate', notify)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('popstate', notify)
  }
}

const getPath = () => window.location.pathname

/** The current route, re-rendering on navigate() and on the browser's back/forward. */
export function useRoute(): Route {
  const path = useSyncExternalStore(subscribe, getPath)
  return parseRoute(path) ?? { name: 'home' }
}
