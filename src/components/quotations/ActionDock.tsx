'use client'

// The bar that floats at the bottom of the builder (owner, 25 Nov 2026, from an approved mockup): the grand total, always in view while prices are typed; a
// Share menu (the downloads, the client link, WhatsApp, the logo switch); and the next step, Create PI draft. They were the Share row of the top panel.
// Behaviour is unchanged: the same actions under the same conditions, "Save first" while there are unsaved edits, and Create PI draft works on the SAVED
// quotation (nothing is sent to anyone, the PI stays a Draft until it is submitted in Orders).

import { useEffect, useRef, useState } from 'react'
import { AppLink as Link } from '@/components/ui/AppLink'
import { Check, ChevronUp, Copy, FileCheck2, FileSpreadsheet, Link2, Link2Off, MessageCircle, Printer, Share2 } from 'lucide-react'
import { draftDetailHref } from '@/lib/orders/draftsView'
import { formatINR } from '@/lib/currency'
import type { Quotation } from '@/lib/quotations/api'
import { whatsappLink } from '@/lib/quotations/math'
import type { ConversionProblem } from '@/lib/quotations/piWorkbook'
import { PI_STAGE_LABEL, type PiStage } from '@/lib/quotations/toPiDraft'
import s from './quotations.module.css'

type Props = {
  id: string; base: Quotation; dirty: boolean; busy: boolean
  /** The grand total, the amount before GST and the piece count, as the totals show them. */
  grand: number; taxable: number; pieces: number; lineCount: number
  canConfirm: boolean; piProblems: readonly ConversionProblem[]; piStage: PiStage | null; onConfirm: () => void
  phone: string; waText: string; copied: boolean
  /** The logo on the pictures (20270806000200): undefined until it has loaded; changing it is for people who may edit. */
  markOn?: boolean | null; onMark?: (on: boolean) => void
  onCopy: () => void; onExcel: () => void; onShare: (on: boolean) => void
}

export function ActionDock({
  id, base, dirty, busy, grand, taxable, pieces, lineCount, canConfirm, piProblems, piStage, onConfirm, phone, waText, copied, markOn, onMark, onCopy, onExcel, onShare,
}: Props) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  const status = base.status
  const may = base.may_edit
  const off = busy || dirty
  const saveFirst = dirty ? 'Save first' : undefined
  const logoOn = markOn !== false

  // The menu closes on Escape and on a click outside it, like the other menus.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <>
      <div className={s.dockWrap}>
        <div className={s.dock} role="region" aria-label="Total, share and next step">
          <div className={s.dockTotal}>
            <small>Grand total</small>
            <b>{formatINR(grand)}</b>
            <span>{formatINR(taxable)} before GST · {lineCount} {lineCount === 1 ? 'line' : 'lines'} · {pieces.toLocaleString('en-IN')} {pieces === 1 ? 'piece' : 'pieces'}</span>
          </div>
          <span className={s.spacer} />
          {dirty && may && <span className={`${s.dirty} ${s.hideOnPhone}`}>Save first</span>}

          <span ref={wrap} className={s.shareW}>
            <button type="button" className={`${s.btn} ${s.btnLg}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
              <Share2 size={16} aria-hidden /> <span className={s.dockLbl}>Share</span> <ChevronUp size={16} aria-hidden />
            </button>
            {open && (
              <div className={s.sharePop} role="menu" aria-label="Share">
                {dirty
                  ? <button type="button" role="menuitem" className={s.shareItem} disabled title="Save first"><Printer size={16} aria-hidden /> Download PDF</button>
                  : <Link role="menuitem" className={s.shareItem} href={`/quotations/${id}/print`} target="_blank"><Printer size={16} aria-hidden /> Download PDF</Link>}
                <button type="button" role="menuitem" className={s.shareItem} onClick={() => { setOpen(false); onExcel() }} disabled={dirty || busy || lineCount === 0} title={saveFirst}><FileSpreadsheet size={16} aria-hidden /> Download Excel</button>
                {base.share_token ? (
                  <>
                    <button type="button" role="menuitem" className={s.shareItem} onClick={onCopy}>{copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />} {copied ? 'Copied' : 'Copy link'}</button>
                    {dirty
                      ? <button type="button" role="menuitem" className={s.shareItem} disabled title="Save first"><MessageCircle size={16} aria-hidden /> WhatsApp</button>
                      : <a role="menuitem" className={s.shareItem} href={whatsappLink(phone, waText)} target="_blank" rel="noreferrer"
                        title={`WhatsApp opens with the text ready${phone ? ` for ${phone}` : ''}; you press send. The link shows the version you last sent (before one is sent, the saved copy): after changing prices, use Send as new version below.`}><MessageCircle size={16} aria-hidden /> WhatsApp</a>}
                    {may && <button type="button" role="menuitem" className={s.shareItem} disabled={off} title={saveFirst} onClick={() => { setOpen(false); onShare(false) }}><Link2Off size={16} aria-hidden /> Turn the client link off</button>}
                  </>
                ) : may && (
                  <button type="button" role="menuitem" className={s.shareItem} disabled={off || lineCount === 0 || status === 'archived'}
                    title={saveFirst ?? 'One link with the pictures and a Save as PDF button; no login. Turning it on marks a draft as Sent.'} onClick={() => { setOpen(false); onShare(true) }}><Link2 size={16} aria-hidden /> Create client link</button>
                )}
                {onMark && (
                  <>
                    <hr className={s.shareSep} />
                    <label className={s.psw} style={{ padding: '4px 8px' }} title={logoOn ? 'Best of Exports strip on each picture' : 'Clean pictures, no strip'}>
                      <input type="checkbox" role="switch" id="q-mark" checked={logoOn} onChange={e => onMark(e.target.checked)}
                        disabled={busy || !may || status === 'archived' || markOn === undefined || markOn === null} />
                      <span>Logo on pictures</span>
                    </label>
                  </>
                )}
              </div>
            )}
          </span>

          {base.pi && <span className={s.leadMeta}>PI draft <b>{base.pi.draft_reference ?? ''}</b> · {base.pi.status.replace(/_/g, ' ')}</span>}
          {base.pi && <Link className={`${s.btn} ${s.btnLg} ${s.btnPrimary}`} href={draftDetailHref(base.pi.id)}><FileCheck2 size={16} aria-hidden /> Open the PI draft</Link>}
          {canConfirm && (
            <button type="button" className={`${s.btn} ${s.btnLg} ${s.btnPrimary}`} disabled={off || piProblems.length > 0}
              title={saveFirst ?? 'Makes a PI draft in Orders from the saved quotation. Nothing is sent to anyone: the PI stays a Draft until you submit it there.'} onClick={onConfirm}>
              <FileCheck2 size={16} aria-hidden /> {piStage ? PI_STAGE_LABEL[piStage] : 'Create PI draft'}
            </button>
          )}
        </div>
      </div>
      <div className={s.dockSpacer} aria-hidden />
    </>
  )
}
