import { test as base, expect, type Request, type Route } from '@playwright/test'

/**
 * A stand-in for /admin/api, installed on every page (signed out unless a
 * test signs in). The static test server has no PHP, and an unanswered
 * me.php would surface as a console 404 in every spec.
 *
 * It mirrors the real endpoints' contracts: compare-and-set on PUT with a
 * 409 carrying the current copy, X-Lingo-Client required on writes, and
 * auth_start "completing" the Google round trip with a redirect to
 * /?signed_in=1.
 */
export class FakeApi {
  signedIn = false
  name: string | null = 'Ada Lovelace'
  email = 'ada@example.com'
  data: string | null = null
  updatedAt = 0
  /** Every PUT body the client sent, in order. */
  puts: { data: string; base: number }[] = []
  calls: string[] = []
  /** Writes that arrived without `X-Lingo-Client: 1`. */
  missingHeader: string[] = []
  /** Answer the next N PUTs with a 409 as if another device had just written. */
  conflictWith: { data: string; times: number } | null = null

  signIn(opts: { data?: string | null; updatedAt?: number } = {}) {
    this.signedIn = true
    this.data = opts.data ?? null
    this.updatedAt = opts.updatedAt ?? (opts.data ? 100 : 0)
  }

  /** The last blob the client pushed, parsed. */
  lastPushed(): { v: number; archive: { stamps: Record<string, { score: number }> }; daily: unknown } | null {
    const last = this.puts.at(-1)
    return last ? JSON.parse(last.data) : null
  }

  async handle(route: Route, request: Request) {
    const url = new URL(request.url())
    const endpoint = url.pathname.replace('/admin/api/', '')
    const method = request.method()
    this.calls.push(`${method} ${endpoint}`)
    const json = (status: number, body?: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body) })
    if (method !== 'GET' && request.headers()['x-lingo-client'] !== '1') {
      this.missingHeader.push(`${method} ${endpoint}`)
      return json(403, { error: 'forbidden' })
    }

    switch (`${method} ${endpoint}`) {
      case 'GET me.php':
        return json(200, this.signedIn ? { signed_in: true, name: this.name, picture: null, email: this.email, data_updated_at: this.updatedAt } : { signed_in: false })
      case 'GET auth_start.php':
        this.signedIn = true
        return route.fulfill({ status: 302, headers: { location: '/?signed_in=1' } })
      case 'GET sync.php':
        return this.signedIn ? json(200, { data: this.data, updated_at: this.updatedAt }) : json(401, { error: 'unauthorized' })
      case 'PUT sync.php': {
        if (!this.signedIn) return json(401, { error: 'unauthorized' })
        const body = request.postDataJSON() as { data: string; base_updated_at: number }
        this.puts.push({ data: body.data, base: body.base_updated_at })
        if (this.conflictWith && this.conflictWith.times > 0) {
          this.conflictWith.times--
          this.data = this.conflictWith.data
          this.updatedAt += 1
        }
        if (body.base_updated_at !== this.updatedAt) return json(409, { error: 'conflict', data: this.data, updated_at: this.updatedAt })
        this.data = body.data
        this.updatedAt += 1
        return json(200, { updated_at: this.updatedAt })
      }
      case 'POST auth_logout.php':
        if (!this.signedIn) return json(401, { error: 'unauthorized' })
        this.signedIn = false
        return json(204)
      case 'DELETE account.php':
        if (!this.signedIn) return json(401, { error: 'unauthorized' })
        this.signedIn = false
        this.data = null
        this.updatedAt = 0
        return json(204)
      default:
        return json(404, { error: 'not_found' })
    }
  }
}

export const test = base.extend<{ api: FakeApi }>({
  api: [
    async ({ page }, use) => {
      const api = new FakeApi()
      await page.route('**/admin/api/**', (route, request) => api.handle(route, request))
      await use(api)
    },
    { auto: true },
  ],
})

export { expect }
