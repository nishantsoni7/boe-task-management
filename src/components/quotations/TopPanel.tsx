'use client'

// The builder's top panel (owner, 24 Nov 2026, from an approved mockup; it replaces the Status, Share, Lead and Ask a senior cards): one card of slim
// rows. LEAD (the lead's stage is the status: no tracker and no sent / negotiating buttons), SENIOR (only when something was asked), SHARE and the next step
// (the downloads, the client link, the logo switch | Ask a senior, Confirm → PI draft, a ⋯ menu for the rarer outcomes), then the Lost box and the amber
// "what is missing" row while they apply. The prices-outside-the-limits block is not drawn (the owner: the system is not trained for it yet; its component
// stays in PricingDesk.tsx for later). Behaviour is the cards' own: the same actions under the same conditions, "Save first" while there are unsaved
// edits, the "Why was it lost?" box, and Confirm → PI draft (it works on the SAVED quotation; nothing is sent to anyone, the PI stays a Draft).

import { AppLink as Link } from '@/components/ui/AppLink'
import { Check, Copy, FileCheck2, FileSpreadsheet, Link2, MessageCircle, Printer, TriangleAlert } from 'lucide-react'
import { MoreActionsMenu, type MoreActionItem } from '@/app/orders/[id]/MoreActionsMenu'
import type { createClient } from '@/lib/supabase/client'
import { draftDetailHref } from '@/lib/orders/draftsView'
import { DEAD_REASONS } from '@/lib/salesLeads/board'
import type { Quotation, QuotationStatus } from '@/lib/quotations/api'
import { whatsappLink } from '@/lib/quotations/math'
import { waitsFor, type ConversionProblem } from '@/lib/quotations/piWorkbook'
import { PI_STAGE_LABEL, type PiStage } from '@/lib/quotations/toPiDraft'
import { AskButton, AskNote } from './AskCard'
import { LeadCard } from './LeadCard'
import { StatusPill } from './ListScreen'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>

export const LOCKED: QuotationStatus[] = ['confirmed', 'lost', 'archived']

const KIND: Record<Exclude<ConversionProblem['code'], 'NO_LINES'>, string> = { NAME_MISSING: 'Name', QTY_MISSING: 'Quantity', PRICE_MISSING: 'Price', PICTURE_MISSING: 'Picture' }
const SHOWN = 6

/** The one line the panel says while Confirm waits (it lives in piWorkbook.ts now, so Lead Management says the same words). */
export { waitsFor }

export type Outcome = 'unshare' | 'no_pi' | 'lost' | 'archive' | 'delete'

type Props = {
  supabase: Supabase; id: string; base: Quotation; dirty: boolean; busy: boolean; isAdmin: boolean
  canConfirm: boolean; piProblems: readonly ConversionProblem[]; piStage: PiStage | null
  lineCount: number; phone: string; waText: string; copied: boolean
  /** The logo on the pictures (20270806000200): undefined until it has loaded; changing it is for people who may edit. */
  markOn?: boolean | null; onMark?: (on: boolean) => void
  /** The Lost box is open while `lostNote` is not null; the reason is one of the lead's eleven (20270813000000). */
  lostNote: string | null; setLostNote: (v: string | null) => void; lostReason: string; setLostReason: (v: string) => void
  onMove: (status: QuotationStatus, note?: string, reason?: string) => void; onConfirm: () => void
  onCopy: () => void; onExcel: () => void; onShare: (on: boolean) => void
  /** 20270817000000: the database says this person may delete this quotation now; the item opens the confirm. */
  canDelete?: boolean; onDelete?: () => void
  /** The lead or the ask changed something the quotation shows: read it again. */
  onChanged: () => void; onSentBack?: () => void
}

export function TopPanel({
  supabase, id, base, dirty, busy, isAdmin, canConfirm, piProblems, piStage, lineCount, phone, waText, copied, markOn, onMark,
  lostNote, setLostNote, lostReason, setLostReason, onMove, onConfirm, onCopy, onExcel, onShare, canDelete, onDelete, onChanged, onSentBack,
}: Props) {
  const status = base.status
  const locked = LOCKED.includes(status)
  const may = base.may_edit
  const off = busy || dirty
  const saveFirst = dirty ? 'Save first' : undefined
  const reopen = may && locked && (status !== 'confirmed' || isAdmin)

  // The rarer ways a quotation ends, and turning the client link off, behind the ⋯ menu (the menu draws nothing when none applies).
  const items: MoreActionItem<Outcome>[] = []
  if (may && base.share_token) items.push({ key: 'unshare', label: 'Turn the client link off', disabled: off, title: saveFirst })
  if (may && !locked) items.push({ key: 'no_pi', label: 'Confirmed, no PI', disabled: off, title: 'Confirmed without making a PI from it' })
  if (may && !locked) items.push({ key: 'lost', label: 'Mark as lost…', disabled: off, title: saveFirst })
  if (may && status !== 'archived' && status !== 'confirmed') items.push({ key: 'archive', label: 'Archive', disabled: off, title: saveFirst })
  if (canDelete && onDelete) items.push({ key: 'delete', label: 'Delete…', disabled: busy, danger: true })
  const pick = (k: Outcome) => (k === 'unshare' ? onShare(false) : k === 'no_pi' ? onMove('confirmed') : k === 'lost' ? setLostNote('') : k === 'archive' ? onMove('archived') : onDelete?.())

  const logoOn = markOn !== false
  const waiting = canConfirm && piProblems.length > 0

  return (
    <section className={s.panel} aria-label="Quotation, sharing and next step">
      <LeadCard supabase={supabase} base={base} dirty={dirty} onChanged={onChanged} />
      <AskNote supabase={supabase} base={base} />

      <div className={`${s.prow} ${s.pbar}`} role="group" aria-label="Share and next step">
        <span className={s.tileLab}>Share</span>
        <div className={s.prc}>
          <div className={s.pgrp}>
            {dirty
              ? <button type="button" className={s.btn} disabled title="Save first"><Printer size={15} aria-hidden /> Download PDF</button>
              : <Link className={s.btn} href={`/quotations/${id}/print`} target="_blank"><Printer size={15} aria-hidden /> Download PDF</Link>}
            <button type="button" className={s.btn} onClick={onExcel} disabled={dirty || busy || lineCount === 0} title={saveFirst}><FileSpreadsheet size={15} aria-hidden /> Download Excel</button>
            {base.share_token ? (
              <>
                <button type="button" className={s.btn} onClick={onCopy}>{copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />} {copied ? 'Copied' : 'Copy link'}</button>
                {dirty
                  ? <button type="button" className={s.btn} disabled title="Save first"><MessageCircle size={15} aria-hidden /> WhatsApp</button>
                  : <a className={s.btn} href={whatsappLink(phone, waText)} target="_blank" rel="noreferrer"
                    title={`WhatsApp opens with the text ready${phone ? ` for ${phone}` : ''}; you press send. The link shows the version you last sent (before one is sent, the saved copy): after changing prices, use Send as new version below.`}><MessageCircle size={15} aria-hidden /> WhatsApp</a>}
              </>
            ) : may && (
              <button type="button" className={s.btn} disabled={off || lineCount === 0 || status === 'archived'} title={saveFirst ?? 'One link with the pictures and a Save as PDF button; no login. Turning it on marks a draft as Sent.'} onClick={() => onShare(true)}><Link2 size={15} aria-hidden /> Create client link</button>
            )}
          </div>
          {onMark && (
            <label className={s.psw} title={logoOn ? 'Best of Exports strip on each picture' : 'Clean pictures, no strip'}>
              <input type="checkbox" role="switch" id="q-mark" checked={logoOn} onChange={e => onMark(e.target.checked)}
                disabled={busy || !may || status === 'archived' || markOn === undefined || markOn === null} />
              <span>Logo on pictures</span>
            </label>
          )}

          <div className={s.pright}>
            {dirty && may && <span className={s.dirty}>Save first</span>}
            <AskButton supabase={supabase} base={base} dirty={dirty} onChanged={onChanged} onSentBack={onSentBack} />
            {locked && <StatusPill status={status} />}
            {base.pi && <span className={s.leadMeta}>PI draft <b>{base.pi.draft_reference ?? ''}</b> · {base.pi.status.replace(/_/g, ' ')}</span>}
            {base.pi && <Link className={`${s.btn} ${s.btnPrimary} ${s.pnext}`} href={draftDetailHref(base.pi.id)}><FileCheck2 size={15} aria-hidden /> Open the PI draft</Link>}
            {canConfirm && (
              <button type="button" className={`${s.btn} ${s.btnPrimary} ${s.pnext}`} disabled={off || piProblems.length > 0}
                title={saveFirst ?? 'Makes a PI draft in Orders from the saved quotation. Nothing is sent to anyone: the PI stays a Draft until you submit it there.'} onClick={onConfirm}>
                <FileCheck2 size={15} aria-hidden /> {piStage ? PI_STAGE_LABEL[piStage] : 'Confirm → PI draft'}
              </button>
            )}
            {reopen && <button type="button" className={s.btn} disabled={busy} onClick={() => onMove('negotiating')}>Reopen</button>}
            <span className={s.pmore}><MoreActionsMenu items={items} onSelect={pick} ariaLabel="More actions" triggerClassName={s.iconBox} /></span>
          </div>
        </div>
      </div>

      {lostNote !== null && (
        <div className={s.prow} role="group" aria-label="Lost">
          <span className={s.tileLab}>Lost</span>
          <div className={s.prc}>
            <label className={s.field}><span>Why was it lost?</span>
              <select id="q-lost-reason" className={s.input} value={lostReason} onChange={e => setLostReason(e.target.value)} autoFocus>
                <option value="">Choose a reason…</option>
                {DEAD_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select></label>
            <label className={s.field}><span>Note{lostReason === 'other' ? ' (required)' : ' (optional)'}</span><input id="q-lost" className={s.input} value={lostNote} maxLength={300} onChange={e => setLostNote(e.target.value)} placeholder="Anything worth remembering" /></label>
            <div className={s.row}>
              <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnDanger}`} disabled={busy || !lostReason || (lostReason === 'other' && lostNote.trim().length < 3)} onClick={() => { onMove('lost', lostNote.trim() || undefined, lostReason); setLostNote(null); setLostReason('') }}>Mark lost</button>
              <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => { setLostNote(null); setLostReason('') }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {waiting && (
        <div className={`${s.prow} ${s.pfix}`}>
          <details>
            <summary><TriangleAlert size={15} aria-hidden /> <span>{waitsFor(piProblems)}</span><span className={s.hintMore}>Show which</span></summary>
            <div className={s.hintBody}>
              {piProblems.filter(p => p.lines.length > 0).map(p => (
                <div key={p.code} className={s.hintRow}>
                  {piProblems.length > 1 && p.code !== 'NO_LINES' && <b>{KIND[p.code]} needed:</b>}
                  {p.lines.slice(0, SHOWN).map((name, i) => <span key={i} className={s.chip}>{name}</span>)}
                  {p.lines.length > SHOWN && <span className={s.chip}>+ {p.lines.length - SHOWN} more</span>}
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </section>
  )
}
