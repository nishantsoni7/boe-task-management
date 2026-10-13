'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronLeft, ChevronRight, ImageIcon, Info, Minus, Plus, X } from 'lucide-react'
import { STAGES, conditionLabel, stageLabel, type InventoryItem } from '@/lib/inventory/constants'
import { readyState, readyText, sortedImages, stockState, stockText } from '@/lib/inventory/format'
import s from './inventory.module.css'

// ── Badges ──────────────────────────────────────────────────────────────

export function StageBadge({ stage, className = '' }: { stage: string; className?: string }) {
  return (
    <span className={`${s.badge} ${s[`st_${stage}`] ?? ''} ${className}`}>
      <span className={s.badgeDot} aria-hidden="true" />{stageLabel(stage)}
    </span>
  )
}

export const ConditionBadge = ({ condition }: { condition: string }) => (
  <span className={`${s.badge} ${s.cond}`}>{conditionLabel(condition)}</span>
)

export function StockBadge({ item }: { item: Pick<InventoryItem, 'qty_available' | 'qty_total'> }) {
  const st = stockState(item)
  return <span className={`${s.badge} ${st === 'out' ? s.stockOut : st === 'low' ? s.stockLow : s.stockIn}`}>{stockText(item)}</span>
}

export function BookingBadge({ status }: { status: string }) {
  const label = status === 'pending' ? 'Pending' : status === 'confirmed' ? 'Confirmed' : status === 'rejected' ? 'Rejected' : 'Cancelled'
  return <span className={`${s.badge} ${s[`sp_${status}`] ?? ''}`}>{label}</span>
}

// ── Picture with a calm fallback ───────────────────────────────────────

export function Pic({ src, alt, eager = false }: { src: string | null; alt: string; eager?: boolean }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return <div className={s.noImg} role="img" aria-label={alt}><ImageIcon size={30} strokeWidth={1.5} /></div>
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} loading={eager ? 'eager' : 'lazy'} decoding="async" onError={() => setFailed(true)} />
}

// ── Notice ──────────────────────────────────────────────────────────────

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'err'; children: React.ReactNode }) {
  const cls = kind === 'err' ? s.noticeErr : kind === 'warn' ? s.noticeWarn : s.noticeInfo
  return (
    <div className={`${s.notice} ${cls}`} role={kind === 'err' ? 'alert' : 'status'}>
      {kind === 'info' ? <Info size={18} style={{ flexShrink: 0, marginTop: 1 }} /> : <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 1 }} />}
      <div>{children}</div>
    </div>
  )
}

// ── Sheet: bottom sheet on a phone, dialog on a desktop ────────────────

export function Sheet({
  title, subtitle, onClose, children, footer, wide = false, busy = false,
}: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const opener = document.activeElement as HTMLElement | null
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button:not([data-close])')
    first?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) closeRef.current()
      if (e.key === 'Tab' && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')]
        if (!f.length) return
        const a = f[0], z = f[f.length - 1]
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus() }
        else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      document.removeEventListener('keydown', onKey)
      opener?.focus?.({ preventScroll: true })
    }
  }, [busy])

  return (
    <div className={`${s.sheetOverlay} boe-sheet-overlay`} onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div ref={ref} className={`${s.sheet}${wide ? ` ${s.sheetWide}` : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className={s.sheetHead}>
          <div style={{ minWidth: 0 }}>
            <h2 className={s.sheetTitle}>{title}</h2>
            {subtitle && <div className={s.sheetSub}>{subtitle}</div>}
          </div>
          <button type="button" data-close className={s.iconBtn} onClick={onClose} disabled={busy} aria-label="Close"><X size={20} /></button>
        </div>
        <div className={s.sheetBody}>{children}</div>
        {footer && <div className={s.sheetFoot}>{footer}</div>}
      </div>
    </div>
  )
}

// ── Quantity stepper ────────────────────────────────────────────────────

export function QtyStepper({
  value, onChange, min = 1, max = 100000, label,
}: { value: number; onChange: (n: number) => void; min?: number; max?: number; label: string }) {
  const clamp = (n: number) => Math.min(max, Math.max(min, Number.isFinite(n) ? Math.trunc(n) : min))
  return (
    <div className={s.stepper} role="group" aria-label={label}>
      <button type="button" className={s.stepBtn} onClick={() => onChange(clamp(value - 1))} disabled={value <= min} aria-label="One less"><Minus size={20} /></button>
      <input
        className={s.stepInput} inputMode="numeric" pattern="[0-9]*" aria-label={label} value={String(value)}
        onChange={e => { const d = e.target.value.replace(/\D/g, ''); onChange(d === '' ? min : clamp(Number(d))) }}
        onFocus={e => e.target.select()}
      />
      <button type="button" className={s.stepBtn} onClick={() => onChange(clamp(value + 1))} disabled={value >= max} aria-label="One more"><Plus size={20} /></button>
    </div>
  )
}

// ── Stage tracker ───────────────────────────────────────────────────────

const TRACK = STAGES.filter(x => x.value !== 'under_repair')

export function StageTracker({ item, today }: { item: InventoryItem; today?: string }) {
  const st = readyState(item, today)
  const repair = item.stage === 'under_repair'
  const now = TRACK.findIndex(x => x.value === item.stage)
  const cls = st.kind === 'ready' ? s.readyOk : st.kind === 'overdue' ? s.readyLate : st.kind === 'unknown' ? s.readyNone : s.readySoon
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {repair ? (
        <div className={s.repairBand}><AlertTriangle size={18} /> Under repair, back in the pipeline once restored</div>
      ) : (
        <ol className={s.track} aria-label={`Stage: ${stageLabel(item.stage)}`}>
          {TRACK.map((step, i) => {
            const done = i < now
            const current = i === now
            const readyNow = current && step.value === 'ready'
            return (
              <li key={step.value} className={`${s.trackStep}${done ? ` ${s.trackDone}` : ''}${current ? ` ${s.trackNow}` : ''}${readyNow ? ` ${s.trackNowReady}` : ''}`} aria-current={current ? 'step' : undefined}>
                <span className={s.trackDot}>{(done || readyNow) && <Check size={13} strokeWidth={3.5} />}</span>
                <span className={s.trackLbl}>{step.short}</span>
              </li>
            )
          })}
        </ol>
      )}
      <div className={`${s.readyBox} ${cls}`}>{readyText(item, today)}</div>
    </div>
  )
}

// ── Lightbox ────────────────────────────────────────────────────────────

export function Lightbox({
  urls, index, alt, onClose, onIndex,
}: { urls: string[]; index: number; alt: string; onClose: () => void; onIndex: (i: number) => void }) {
  const [zoom, setZoom] = useState(false)
  const touch = useRef<{ x: number; y: number } | null>(null)
  const n = urls.length
  const go = useCallback((d: number) => { setZoom(false); onIndex((index + d + n) % n) }, [index, n, onIndex])

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' && n > 1) go(1)
      else if (e.key === 'ArrowLeft' && n > 1) go(-1)
    }
    document.addEventListener('keydown', onKey)
    return () => { document.body.style.overflow = prev; document.removeEventListener('keydown', onKey) }
  }, [go, n, onClose])

  return (
    <div className={`${s.lightbox} boe-sheet-overlay`} role="dialog" aria-modal="true" aria-label={`${alt}, picture ${index + 1} of ${n}`}>
      <div className={s.lbTop}>
        <span className={s.lbCount}>{index + 1} / {n}</span>
        <button type="button" className={s.lbBtn} onClick={onClose} aria-label="Close pictures" autoFocus><X size={22} /></button>
      </div>
      <div
        className={`${s.lbStage}${zoom ? ` ${s.lbZoomed}` : ''}`}
        onClick={e => { if (e.target === e.currentTarget) onClose() }}
        onTouchStart={e => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY } }}
        onTouchEnd={e => {
          const t = touch.current; touch.current = null
          if (!t || zoom || n < 2) return
          const dx = e.changedTouches[0].clientX - t.x, dy = e.changedTouches[0].clientY - t.y
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1)
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={urls[index]} alt={`${alt}, picture ${index + 1}`} onClick={() => setZoom(z => !z)} draggable={false} style={{ cursor: zoom ? 'zoom-out' : 'zoom-in' }} />
        {n > 1 && !zoom && (
          <>
            <button type="button" className={`${s.lbBtn} ${s.lbNav} ${s.lbPrev}`} onClick={() => go(-1)} aria-label="Previous picture"><ChevronLeft size={24} /></button>
            <button type="button" className={`${s.lbBtn} ${s.lbNav} ${s.lbNext}`} onClick={() => go(1)} aria-label="Next picture"><ChevronRight size={24} /></button>
          </>
        )}
      </div>
      {n > 1 && (
        <div className={s.lbStrip}>
          {urls.map((u, i) => (
            <button key={u} type="button" className={`${s.lbThumb}${i === index ? ` ${s.lbThumbOn}` : ''}`} onClick={() => { setZoom(false); onIndex(i) }} aria-label={`Show picture ${i + 1}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export const imagesOf = (item: InventoryItem, toUrl: (p: string) => string) => sortedImages(item).map(i => toUrl(i.path))
