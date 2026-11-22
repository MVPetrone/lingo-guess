import { useState } from 'react'
import type { Account, AccountNotice } from '../hooks/useAccount.ts'
import type { SyncState } from '../lib/sync.ts'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const SIGNIN_ERRORS: Record<string, string> = {
  cancelled: 'Sign-in was cancelled.',
  rate_limited: 'Too many sign-in attempts. Try again in a minute.',
  unavailable: 'Sign-in isn’t available right now.',
}

function noticeText(notice: AccountNotice | null): string {
  switch (notice?.kind) {
    case 'signin_error':
      return SIGNIN_ERRORS[notice.reason] ?? 'Sign-in didn’t complete. Please try again.'
    case 'signed_out':
      return 'Signed out. This device keeps its own copy of your days.'
    case 'deleted':
      return 'Your account and the archive stored with it are deleted. This device still has its own copy.'
    case 'action_failed':
      return 'That didn’t go through. Check your connection and try again.'
    default:
      return ''
  }
}

/** /archive while signed out: why to sign in, one way to do it, and a way back. No data. */
export function ArchiveGate({
  account,
  notice,
  onSignIn,
  onBack,
}: {
  account: Account
  notice: AccountNotice | null
  onSignIn: () => void
  onBack: () => void
}) {
  const unavailable = account.status === 'unavailable'
  const status = unavailable && !notice ? 'Sign-in isn’t available right now. Your days are still saved on this device.' : noticeText(notice)
  return (
    <main className="screen screen--archive archive-gate" data-testid="archive-gate">
      <header className="archive-head">
        <p className="eyebrow archive-head__eyebrow">Daily Archive</p>
        <h1 className="archive-head__title">Sign in to keep this record</h1>
        <p className="archive-head__lede">Your archive is stored with your Google account, so a new phone keeps it.</p>
      </header>

      <button
        type="button"
        className="btn btn--signal btn--xl archive__cta"
        onClick={onSignIn}
        disabled={account.status !== 'out'}
        data-testid="gate-signin"
      >
        Continue with Google
      </button>
      <p className="archive-foot__status" role="status" data-testid="gate-status">
        {status}
      </p>

      <footer className="archive-foot">
        <p className="archive-foot__note">
          <span>Playing never needs an account. Signing in redirects you to Google; no Google code runs on this site.</span>
          <a className="link link--quiet" href="/privacy/">
            What is stored, and how to delete it
          </a>
        </p>
        <button type="button" className="link link--quiet archive-foot__back" onClick={onBack} data-testid="archive-back">
          Back to menu
        </button>
      </footer>
    </main>
  )
}

/** The quiet line at the archive's foot: who is signed in, sign out, delete (with a confirm step). */
export function AccountRow({
  name,
  email,
  notice,
  onSignOut,
  onDelete,
}: {
  name: string | null
  email: string
  notice: AccountNotice | null
  onSignOut: () => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const act = (fn: () => Promise<void>) => async () => {
    setBusy(true)
    await fn()
    setBusy(false)
  }
  return (
    <div className="archive-account" data-testid="account-row">
      {confirming ? (
        <div className="archive-account__confirm" role="group" aria-label="Delete my data">
          <p>Delete your account and the archive stored with it? This can’t be undone. This device keeps its own copy.</p>
          <div className="archive-account__actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={act(onDelete)} disabled={busy} data-testid="account-delete-confirm">
              Delete my data
            </button>
            <button type="button" className="link link--quiet" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="archive-account__line">
          <span>
            Signed in as <span className="archive-account__name">{name ?? email}</span>
          </span>
          <span aria-hidden="true">·</span>
          <button type="button" className="link link--quiet" onClick={act(onSignOut)} disabled={busy} data-testid="account-signout">
            Sign out
          </button>
          <span aria-hidden="true">·</span>
          <button type="button" className="link link--quiet" onClick={() => setConfirming(true)} data-testid="account-delete">
            Delete my data
          </button>
        </p>
      )}
      {notice?.kind === 'action_failed' && (
        <p className="archive-account__error" role="alert">
          {noticeText(notice)}
        </p>
      )}
    </div>
  )
}

/**
 * First sign-in on a device that already has days the account lacks: one
 * button merges them in. Declining keeps them on the device (never
 * discarded) and offers an export instead.
 */
export function SyncOffer({
  state,
  onAccept,
  onDecline,
  onExport,
}: {
  state: Extract<SyncState, { kind: 'offer' | 'declined' }>
  onAccept: () => void
  onDecline: () => void
  onExport: () => void
}) {
  const days = plural(state.days, 'local day')
  return (
    <section className="archive-offer panel" aria-label="Days on this device" data-testid="sync-offer">
      {state.kind === 'offer' ? (
        <>
          <p className="archive-offer__lede">This device has {plural(state.days, 'day')} your account doesn’t.</p>
          <button type="button" className="btn btn--signal" onClick={onAccept} data-testid="sync-offer-accept">
            Bring your {days} into your account
          </button>
          <button type="button" className="link link--quiet" onClick={onDecline} data-testid="sync-offer-decline">
            Not now
          </button>
        </>
      ) : (
        <>
          <p className="archive-offer__lede">
            Your {days} stay on this device only, and new days here won’t reach your account. Export a copy to keep them safe.
          </p>
          <button type="button" className="btn btn--ghost" onClick={onExport} data-testid="sync-offer-export">
            Export them
          </button>
          <button type="button" className="link link--quiet" onClick={onAccept} data-testid="sync-offer-accept">
            Bring them in after all
          </button>
        </>
      )}
    </section>
  )
}
