// The archive as an image: streak on top, a wall of every flag collected,
// totals at the foot. Drawn on a canvas with no dependencies; the flags are
// the same-origin SVGs the UI uses, so drawImage never taints the canvas and
// toBlob always works.
import { useEffect, useRef, useState } from 'react'
import { FLAG_ISO, flagSrc } from '../data/flags.ts'
import { LANGUAGES, type LangCode } from '../data/languages.ts'
import { track } from '../lib/analytics.ts'
import { copyText } from '../share.ts'
import { archiveFileName } from '../storage.ts'
import { Icon } from './Icon.tsx'

interface Props {
  today: string
  streak: number
  /** Every distinct language collected, oldest first. */
  languages: readonly LangCode[]
  days: number
  onClose: () => void
}

const W = 1080
const H = 1350
const COLS = 8
// Several languages share a flag (Spanish, Catalan, Galician); the wall shows
// each flag once, out of every flag the roster can ever give.
const ALL_FLAGS = new Set(LANGUAGES.map((l) => FLAG_ISO[l.code])).size

// The canvas cannot wait on the app's webfonts, so it uses the system stack.
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

/** Brand colours, read from the frozen tokens so the card matches the app. */
function palette() {
  const css = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  return {
    page: token('--ink-950', '#06080c'),
    lift: token('--ink-900', '#0a0d13'),
    surface: token('--ink-800', '#10141d'),
    text: token('--fog-100', '#edf1f7'),
    text2: token('--fog-200', '#c7ceda'),
    text3: token('--fog-300', '#98a2b3'),
    voice: token('--signal-500', '#ffb020'),
    machine: token('--caliber-500', '#57e3c9'),
    line: token('--line', 'rgba(255, 255, 255, 0.1)'),
    lineStrong: token('--line-strong', 'rgba(255, 255, 255, 0.18)'),
  }
}

type Flagged = { img: HTMLImageElement; aspect: number }

/**
 * Width ÷ height of a flag SVG, from its width/height or viewBox. Several
 * flags carry only a viewBox, and for those the image's naturalWidth/Height
 * are the 300×150 default, not the flag's shape.
 */
function svgAspect(text: string): number {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? ''
  const attr = (name: string) => Number(new RegExp(`\\b${name}="([\\d.]+)"`).exec(tag)?.[1])
  const [w, h] = [attr('width'), attr('height')]
  if (w > 0 && h > 0) return w / h
  const box = (/\bviewBox="([^"]+)"/.exec(tag)?.[1] ?? '').trim().split(/[\s,]+/).map(Number)
  const [bw, bh] = [box[2] ?? 0, box[3] ?? 0]
  return bw > 0 && bh > 0 ? bw / bh : 4 / 3
}

/** A loaded flag, or null if it failed: one broken flag must not sink the card. */
async function loadFlag(src: string): Promise<Flagged | null> {
  try {
    const res = await fetch(src)
    if (!res.ok) return null
    const aspect = svgAspect(await res.text())
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => resolve(null)
      el.src = src
    })
    return img ? { img, aspect } : null
  } catch {
    return null
  }
}

/** One code per distinct flag, in the order first collected. */
function flagCodes(languages: readonly LangCode[]): LangCode[] {
  const seen = new Set<string>()
  return languages.filter((c) => {
    const iso = FLAG_ISO[c]
    if (seen.has(iso)) return false
    seen.add(iso)
    return true
  })
}

function shareCaption(streak: number, languages: number, days: number, url: string): string {
  const parts = [`${streak}-day streak`, `${languages} language${languages === 1 ? '' : 's'}`, `${days} day${days === 1 ? '' : 's'}`]
  return `My Lingo Guess archive: ${parts.join(' · ')}\n${url}`
}

async function drawCard(streak: number, languages: readonly LangCode[], days: number): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  const c = palette()
  const codes = flagCodes(languages)
  const images = await Promise.all(codes.map((code) => loadFlag(flagSrc(code))))

  const bg = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, H * 0.9)
  bg.addColorStop(0, c.lift)
  bg.addColorStop(1, c.page)
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = c.machine
  ctx.font = `500 28px ${MONO}`
  ctx.fillText('LINGO GUESS · DAILY ARCHIVE', W / 2, 104)

  ctx.fillStyle = c.voice
  ctx.font = `800 200px ${SANS}`
  ctx.fillText(String(streak), W / 2, 300)
  ctx.fillStyle = c.text
  ctx.font = `600 54px ${SANS}`
  ctx.fillText('day streak', W / 2, 372)

  // The wall: every collectable flag's slot, collected ones filled in order.
  const margin = 90
  const pitchX = (W - margin * 2) / COLS
  const fw = 88
  const fh = 66
  const pitchY = 84
  const top = 430
  const slots = Math.ceil(Math.max(ALL_FLAGS, codes.length) / COLS) * COLS
  for (let i = 0; i < slots; i++) {
    const x = margin + (i % COLS) * pitchX + (pitchX - fw) / 2
    const y = top + Math.floor(i / COLS) * pitchY
    const flag = images[i]
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(x, y, fw, fh, 8)
    if (flag) {
      ctx.clip()
      // Cover: flags come in many shapes and every slot is 4:3. The whole
      // image is drawn oversize and clipped; a source-rect crop would depend
      // on naturalWidth, which is wrong for viewBox-only SVGs.
      const dw = Math.max(fw, fh * flag.aspect)
      const dh = dw / flag.aspect
      ctx.drawImage(flag.img, x + (fw - dw) / 2, y + (fh - dh) / 2, dw, dh)
      ctx.restore()
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(x, y, fw, fh, 8)
      ctx.strokeStyle = c.lineStrong
      ctx.lineWidth = 2
      ctx.stroke()
    } else {
      ctx.fillStyle = c.surface
      ctx.fill()
      ctx.strokeStyle = c.line
      ctx.lineWidth = 2
      ctx.stroke()
    }
    ctx.restore()
  }

  ctx.fillStyle = c.line
  ctx.fillRect(margin, 1212, W - margin * 2, 2)
  ctx.fillStyle = c.text2
  ctx.font = `500 36px ${SANS}`
  const n = languages.length
  ctx.fillText(`${n} language${n === 1 ? '' : 's'} · ${days} day${days === 1 ? '' : 's'} · lingoguess.com`, W / 2, 1276)
  return canvas
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

type Status = 'idle' | 'shared' | 'downloaded' | 'downloaded-copied'

/** A modal with the rendered card and the ways to get it off the device. */
export function ShareCard({ today, streak, languages, days, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const linkRef = useRef<HTMLAnchorElement>(null)
  const [png, setPng] = useState<{ blob: Blob; url: string } | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const fileName = archiveFileName(today, 'png')

  useEffect(() => {
    const dialog = dialogRef.current
    // No close() on cleanup: StrictMode's rehearsal unmount would fire the
    // close event and dismiss the card. Unmounting removes it from the top layer.
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  useEffect(() => {
    let cancelled = false
    let url = ''
    void (async () => {
      const card = await drawCard(streak, languages, days)
      if (cancelled) return
      const preview = previewRef.current
      preview?.getContext('2d')?.drawImage(card, 0, 0, preview.width, preview.height)
      const blob = await toPng(card)
      if (cancelled || !blob) return
      url = URL.createObjectURL(blob)
      setPng({ blob, url })
    })()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [streak, languages, days])

  const caption = shareCaption(streak, languages.length, days, `${window.location.origin}${import.meta.env.BASE_URL}daily`)

  const onShare = async () => {
    if (!png) return
    const file = new File([png.blob], fileName, { type: 'image/png' })
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text: caption })
        setStatus('shared')
        track('archive_share', { via: 'native' })
        return
      } catch (err) {
        // Dismissing the share sheet is a choice, not a failure.
        if (err instanceof DOMException && err.name === 'AbortError') return
      }
    }
    linkRef.current?.click()
    setStatus((await copyText(caption)) ? 'downloaded-copied' : 'downloaded')
    track('archive_share', { via: 'download' })
  }

  return (
    <dialog
      ref={dialogRef}
      className="share-card"
      aria-labelledby="share-card-title"
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === e.currentTarget) onClose()
      }}
      data-testid="share-card"
      data-ready={png ? 'true' : 'false'}
    >
      <div className="share-card__body">
        <h2 id="share-card-title" className="share-card__title">
          Your archive card
        </h2>
        <canvas
          ref={previewRef}
          className="share-card__preview"
          width={W / 2}
          height={H / 2}
          role="img"
          aria-label="Your Lingo Guess archive card"
          data-testid="share-card-canvas"
        />
        <div className="actions share-card__actions">
          <button type="button" className="btn btn--signal" onClick={onShare} disabled={!png} data-testid="share-card-share">
            <Icon name="share" className="btn__icon" />
            Share
          </button>
          <a
            ref={linkRef}
            className="btn btn--ghost"
            href={png?.url}
            download={fileName}
            aria-disabled={png ? undefined : 'true'}
            onClick={() => track('archive_download')}
            data-testid="share-card-download"
          >
            Download PNG
          </a>
        </div>
        <p className="share-card__status" role="status">
          {status === 'shared' && 'Shared.'}
          {status === 'downloaded' && 'Card downloaded.'}
          {status === 'downloaded-copied' && 'Card downloaded and caption copied.'}
        </p>
        <button type="button" className="link link--quiet share-card__close" onClick={onClose} autoFocus>
          Close
        </button>
      </div>
    </dialog>
  )
}
