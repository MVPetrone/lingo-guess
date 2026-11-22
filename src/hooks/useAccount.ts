import { useCallback, useEffect, useRef, useState } from 'react'
import type { SyncPayload } from '../engine/syncMerge.ts'
import { deleteAccount, getMe, signInReturned, signOut, startSignIn } from '../lib/auth.ts'
import { createSyncer, type SyncState, type Syncer } from '../lib/sync.ts'
import { loadLastSyncedAt } from '../storage.ts'

export type Account =
  | { status: 'checking' }
  /** No answer from the server (offline, or a host without the backend). */
  | { status: 'unavailable' }
  | { status: 'out' }
  | { status: 'in'; name: string | null; email: string }

/** One line for the archive gate, after something the player did. */
export type AccountNotice =
  | { kind: 'signin_error'; reason: string }
  | { kind: 'signed_out' }
  | { kind: 'deleted' }
  | { kind: 'action_failed' }

export interface AccountApi {
  account: Account
  sync: SyncState
  /** From the last confirmed sync in this tab session; never from an attempt. */
  lastSyncedAt: number | null
  notice: AccountNotice | null
  signIn: () => void
  signOut: () => Promise<void>
  deleteData: () => Promise<void>
  /** Sync after `delayMs` (debounced); no-op while signed out. */
  requestSync: (delayMs?: number) => void
  acceptOffer: () => Promise<void>
  declineOffer: () => void
}

function initialNotice(): AccountNotice | null {
  const r = signInReturned()
  return r?.kind === 'error' ? { kind: 'signin_error', reason: r.reason } : null
}

/**
 * Who is signed in, and the sync loop that keeps their archive in the
 * account. `get` / `apply` read and store the device's data; they may change
 * identity every render.
 */
export function useAccount(get: () => SyncPayload, apply: (payload: SyncPayload) => void): AccountApi {
  const [account, setAccount] = useState<Account>({ status: 'checking' })
  const [sync, setSync] = useState<SyncState>({ kind: 'idle' })
  const [lastSyncedAt, setLastSyncedAt] = useState(loadLastSyncedAt)
  const [notice, setNotice] = useState(initialNotice)

  const io = useRef({ get, apply })
  useEffect(() => {
    io.current = { get, apply }
  })

  // One controller per mount, made in the effect so render never touches it.
  const syncer = useRef<Syncer | null>(null)

  useEffect(() => {
    const s = createSyncer({
      get: () => io.current.get(),
      apply: (p) => io.current.apply(p),
      onState: (state) => {
        setSync(state)
        if (state.kind === 'synced') setLastSyncedAt(state.at)
        if (state.kind === 'idle') setLastSyncedAt(null)
      },
      onSignedOut: () => setAccount({ status: 'out' }),
    })
    syncer.current = s
    let live = true
    void getMe().then((me) => {
      if (!live) return
      if (me === null) return setAccount({ status: 'unavailable' })
      if (!me.signedIn) return setAccount({ status: 'out' })
      setAccount({ status: 'in', name: me.name, email: me.email })
      s.setActive(true)
      void s.run()
    })
    // Leaving the page (tab switch, app switch, close): push what changed now.
    const onHide = () => {
      if (document.visibilityState === 'hidden') void s.run({ keepalive: true })
    }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      live = false
      s.setActive(false)
      syncer.current = null
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [])

  const requestSync = useCallback((delayMs?: number) => syncer.current?.request(delayMs), [])
  const acceptOffer = useCallback(async () => {
    await syncer.current?.accept()
  }, [])
  const declineOffer = useCallback(() => syncer.current?.decline(), [])

  const doSignOut = useCallback(async () => {
    if (!(await signOut())) return setNotice({ kind: 'action_failed' })
    syncer.current?.reset()
    setAccount({ status: 'out' })
    setNotice({ kind: 'signed_out' })
  }, [])

  const deleteData = useCallback(async () => {
    if (!(await deleteAccount())) return setNotice({ kind: 'action_failed' })
    syncer.current?.reset()
    setAccount({ status: 'out' })
    setNotice({ kind: 'deleted' })
  }, [])

  return {
    account,
    sync,
    lastSyncedAt,
    notice,
    signIn: startSignIn,
    signOut: doSignOut,
    deleteData,
    requestSync,
    acceptOffer,
    declineOffer,
  }
}
