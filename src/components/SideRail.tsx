import { Icon } from './Icon.tsx'

/**
 * The way into the archive, kept out of the start screen's flow: one fixed
 * ghost button in the top-right corner, start screen only.
 */
export function SideRail({ onArchive }: { onArchive: () => void }) {
  return (
    <nav className="side-rail" aria-label="Your progress">
      <button type="button" className="side-rail__btn" onClick={onArchive} aria-label="Archive" data-testid="archive-open">
        <Icon name="calendar" className="side-rail__icon" />
      </button>
    </nav>
  )
}
