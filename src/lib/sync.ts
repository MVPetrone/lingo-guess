/**
 * The sync loop: pull, merge, push, with one merge-and-retry on a conflict.
 *
 * Framework-free; the useAccount hook owns one controller and feeds it the
 * current data. Runs are serialised (a request during a run queues exactly
 * one more), and nothing is pushed for a device that has not been linked to
 * the account yet — that needs the player's say-so (`accept`).
 */
import { isNewerVersion, localOnlyDays, mergeAll, parse, serialize, type SyncPayload } from '../engine/syncMerge.ts'
import { loadSyncLinked, saveLastSyncedAt, saveSyncLinked } from '../storage.ts'
import { pull, push } from './auth.ts'

export type SyncState =
  | { kind: 'idle' }
  | { kind: 'syncing' }
  /** The account holds exactly what this device holds. */
  | { kind: 'synced'; at: number }
  /** This device has days the account lacks; nothing is pushed until the player chooses. */
  | { kind: 'offer'; days: number; remote: SyncPayload }
  | { kind: 'declined'; days: number; remote: SyncPayload }
  /** Two conflicts in a row, or the account was written by a newer version. Local data is untouched. */
  | { kind: 'paused' }
  /** Network or server trouble; the next trigger tries again. */
  | { kind: 'failed' }

export interface SyncHost {
  /** The device's data right now. */
  get: () => SyncPayload
  /** Store a merged payload locally (it only ever adds to what `get` returned). */
  apply: (payload: SyncPayload) => void
  onState: (state: SyncState) => void
  /** The session is gone (expired, or deleted elsewhere). */
  onSignedOut: () => void
}

export interface Syncer {
  /** Sync now; resolves when this run (and any queued one) is done. */
  run: (opts?: { keepalive?: boolean }) => Promise<void>
  /** Sync after `delayMs`, replacing any pending request (a debounce). */
  request: (delayMs?: number) => void
  /** Link this device and bring its local days into the account. */
  accept: () => Promise<void>
  decline: () => void
  /** Forget the account (sign-out, deletion). Local data is left as it is. */
  reset: () => void
  setActive: (active: boolean) => void
}

const wireOf = (p: SyncPayload) => serialize(p.archive, p.daily)

export function createSyncer(host: SyncHost): Syncer {
  let active = false
  /** The account's updated_at and blob as last seen; null until the first pull. */
  let base: number | null = null
  let remoteWire: string | null = null
  let declined = false
  let running: Promise<void> | null = null
  let queued = false
  let queuedKeepalive = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let last: SyncState = { kind: 'idle' }

  const set = (state: SyncState) => {
    last = state
    host.onState(state)
  }

  const synced = (wire: string) => {
    remoteWire = wire
    const at = Date.now()
    saveLastSyncedAt(at)
    set({ kind: 'synced', at })
  }

  const signedOut = () => {
    reset()
    host.onSignedOut()
  }

  /** Pushes `wire` at the known base; on a 409, merges the account's copy in and retries once. */
  async function pushWire(wire: string, keepalive: boolean): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await push(wire, base ?? 0, { keepalive })
      if (res.kind === 'ok') {
        base = res.updatedAt
        return synced(wire)
      }
      if (res.kind === 'unauthorized') return signedOut()
      if (res.kind === 'failed') return set({ kind: 'failed' })
      base = res.updatedAt
      remoteWire = res.data
      if (isNewerVersion(res.data)) return set({ kind: 'paused' })
      const merged = mergeAll(host.get(), parse(res.data))
      host.apply(merged)
      wire = wireOf(merged)
      if (wire === res.data) return synced(wire)
    }
    set({ kind: 'paused' })
  }

  async function once(keepalive: boolean): Promise<void> {
    if (!active) return
    const linked = loadSyncLinked()

    // Linked and in step with the account: push only what changed.
    if (linked && base !== null) {
      const wire = wireOf(host.get())
      if (wire === remoteWire) {
        if (last.kind !== 'synced') synced(wire)
        return
      }
      set({ kind: 'syncing' })
      return pushWire(wire, keepalive)
    }

    set({ kind: 'syncing' })
    const res = await pull()
    if (!active) return
    if (res.kind === 'unauthorized') return signedOut()
    if (res.kind === 'failed') return set({ kind: 'failed' })
    base = res.updatedAt
    remoteWire = res.data
    if (isNewerVersion(res.data)) return set({ kind: 'paused' })

    const remote = parse(res.data)
    const local = host.get()
    if (!linked) {
      const days = localOnlyDays(local.archive, remote.archive).length
      if (days > 0) return set({ kind: declined ? 'declined' : 'offer', days, remote })
      // Nothing here the account lacks: joining can only add days to this device.
      saveSyncLinked(true)
    }
    const merged = mergeAll(local, remote)
    const wire = wireOf(merged)
    if (wire !== wireOf(local)) host.apply(merged)
    if (wire === res.data) return synced(wire)
    return pushWire(wire, keepalive)
  }

  function run(opts: { keepalive?: boolean } = {}): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (running) {
      queued = true
      queuedKeepalive ||= opts.keepalive === true
      return running
    }
    running = (async () => {
      let keepalive = opts.keepalive === true
      try {
        do {
          queued = false
          await once(keepalive)
          keepalive = queuedKeepalive
          queuedKeepalive = false
        } while (queued && active)
      } finally {
        running = null
      }
    })()
    return running
  }

  function request(delayMs = 0): void {
    if (!active) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void run()
    }, delayMs)
  }

  async function accept(): Promise<void> {
    saveSyncLinked(true)
    declined = false
    // Pull again so the merge is against the account's latest copy.
    base = null
    await run()
  }

  function decline(): void {
    declined = true
    if (last.kind === 'offer') set({ ...last, kind: 'declined' })
  }

  function reset(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
    active = false
    base = null
    remoteWire = null
    declined = false
    saveSyncLinked(false)
    saveLastSyncedAt(null)
    set({ kind: 'idle' })
  }

  return {
    run,
    request,
    accept,
    decline,
    reset,
    setActive: (on) => {
      active = on
    },
  }
}

// ---- copy -----------------------------------------------------------------------

const clock = (at: number) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(at)

/**
 * The archive's foot note, by sync state. It only says "synced" when the
 * account confirmed it this visit; an attempt or a failure never reads as
 * one.
 */
export function syncNoteText(sync: SyncState, lastSyncedAt: number | null): string {
  switch (sync.kind) {
    case 'synced':
      return `Synced with your Google account · ${clock(sync.at)}`
    case 'offer':
    case 'declined':
      return 'These are the days stored with your Google account.'
    case 'paused':
      return 'Sync paused. Your days are kept on this device.'
    case 'failed':
      return lastSyncedAt
        ? `Last synced with your Google account at ${clock(lastSyncedAt)}. Newer days stay on this device until it reconnects.`
        : 'Not synced yet. Your days stay on this device until it reconnects.'
    default:
      return 'Syncing with your Google account…'
  }
}
