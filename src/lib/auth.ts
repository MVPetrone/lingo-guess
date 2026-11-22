/**
 * The game's side of Google sign-in and account sync.
 *
 * Everything is a same-origin fetch to /admin/api with the session cookie;
 * writes carry `X-Lingo-Client: 1`, which the server requires (a cross-site
 * page cannot set it without a CORS preflight the server never approves).
 * No Google script is loaded: signing in is a plain navigation.
 */

const API = '/admin/api'
const WRITE_HEADERS = { 'X-Lingo-Client': '1' }
/** keepalive bodies are capped at 64 KB by browsers; larger pushes go without it. */
const KEEPALIVE_MAX = 60_000

export type Me =
  | { signedIn: false }
  | { signedIn: true; name: string | null; picture: string | null; email: string; dataUpdatedAt: number }

/** Who is signed in; null when that cannot be told (offline, no backend on this host). */
export async function getMe(): Promise<Me | null> {
  try {
    const res = await fetch(`${API}/me.php`, { credentials: 'same-origin', cache: 'no-store' })
    if (!res.ok) return null
    const body = (await res.json()) as Record<string, unknown>
    if (body.signed_in !== true) return { signedIn: false }
    if (typeof body.email !== 'string') return null
    return {
      signedIn: true,
      name: typeof body.name === 'string' ? body.name : null,
      picture: typeof body.picture === 'string' ? body.picture : null,
      email: body.email,
      dataUpdatedAt: typeof body.data_updated_at === 'number' ? body.data_updated_at : 0,
    }
  } catch {
    return null
  }
}

export function startSignIn(): void {
  window.location.assign(`${API}/auth_start.php`)
}

async function write(path: string, method: 'POST' | 'DELETE'): Promise<boolean> {
  try {
    const res = await fetch(`${API}/${path}`, { method, credentials: 'same-origin', headers: WRITE_HEADERS })
    // 401: the session was already gone — the outcome the player asked for.
    return res.ok || res.status === 401
  } catch {
    return false
  }
}

export function signOut(): Promise<boolean> {
  return write('auth_logout.php', 'POST')
}

export function deleteAccount(): Promise<boolean> {
  return write('account.php', 'DELETE')
}

export type PullResult = { kind: 'ok'; data: string | null; updatedAt: number } | { kind: 'unauthorized' } | { kind: 'failed' }

export async function pull(): Promise<PullResult> {
  try {
    const res = await fetch(`${API}/sync.php`, { credentials: 'same-origin', cache: 'no-store' })
    if (res.status === 401) return { kind: 'unauthorized' }
    if (!res.ok) return { kind: 'failed' }
    const body = (await res.json()) as Record<string, unknown>
    if (typeof body.updated_at !== 'number' || (body.data !== null && typeof body.data !== 'string')) return { kind: 'failed' }
    return { kind: 'ok', data: body.data as string | null, updatedAt: body.updated_at }
  } catch {
    return { kind: 'failed' }
  }
}

export type PushResult =
  | { kind: 'ok'; updatedAt: number }
  | { kind: 'conflict'; data: string | null; updatedAt: number }
  | { kind: 'unauthorized' }
  | { kind: 'failed' }

/** Replaces the account's blob if it is still at `baseUpdatedAt`; a 409 returns the current copy. */
export async function push(data: string, baseUpdatedAt: number, opts: { keepalive?: boolean } = {}): Promise<PushResult> {
  const body = JSON.stringify({ data, base_updated_at: baseUpdatedAt })
  try {
    const res = await fetch(`${API}/sync.php`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { ...WRITE_HEADERS, 'Content-Type': 'application/json' },
      body,
      keepalive: opts.keepalive === true && body.length < KEEPALIVE_MAX,
    })
    if (res.status === 401) return { kind: 'unauthorized' }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.status === 409 && typeof json.updated_at === 'number') {
      return { kind: 'conflict', data: typeof json.data === 'string' ? json.data : null, updatedAt: json.updated_at }
    }
    if (res.ok && typeof json.updated_at === 'number') return { kind: 'ok', updatedAt: json.updated_at }
    return { kind: 'failed' }
  } catch {
    return { kind: 'failed' }
  }
}

// ---- the return trip from Google ------------------------------------------------

export type SignInReturn = { kind: 'ok' } | { kind: 'error'; reason: string }

let signInReturn: SignInReturn | null = null

/**
 * The callback lands on `/?signed_in=1` or `/?signin=error&reason=…`. Sign-in
 * only starts from the archive, so this sends the player back there, strips
 * the parameters from the address bar, and remembers the outcome for the
 * first render. Call once, before the router reads the path.
 */
export function readSignInReturn(): void {
  const url = new URL(window.location.href)
  const ok = url.searchParams.get('signed_in') === '1'
  const failed = url.searchParams.get('signin') === 'error'
  if (!ok && !failed) return
  const reason = url.searchParams.get('reason') ?? ''
  signInReturn = ok ? { kind: 'ok' } : { kind: 'error', reason: /^[a-z_]{1,20}$/.test(reason) ? reason : 'unknown' }
  for (const key of ['signed_in', 'signin', 'reason']) url.searchParams.delete(key)
  url.pathname = '/archive'
  window.history.replaceState(window.history.state, '', url)
}

/** The outcome noted by readSignInReturn for this page load, if any. */
export function signInReturned(): SignInReturn | null {
  return signInReturn
}
