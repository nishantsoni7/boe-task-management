'use client'

// The builder's top panel (owner, 25 Nov 2026, quotation page version 2): STATUS (the lead's stage, read only, changed only in Lead Management),
// LEAD (its name opens a brief), SENIOR (only when something was asked) and SHARE (the downloads, the client link, the logo switch | Ask a senior,
// Open the PI draft when there is one, a ⋯ menu). Nothing here changes a status: Confirm → PI draft, Confirmed no PI, Mark as lost, Archive, the
// Lost box and the "what is missing" row are gone; a PI draft is made from Lead Management (LeadQuotes.tsx). "Save first" while there are unsaved
// edits, as before. Reopen of a locked quotation sits in the builder's lock notice.

import { AppLink as Link } from '@/components/ui/AppLink'
import { Check, Copy, FileCheck2, FileSpreadsheet, Link2, MessageCircle, Printer } from 'lucide-react'
import { MoreActionsMenu, type MoreActionItem } from '@/app/orders/[id]/MoreActionsMenu'
import type { createClient } from '@/lib/supabase/client'
import { draftDetailHref } from '@/lib/orders/draftsView'
import type { Quotation, QuotationStatus } from '@/lib/quotations/api'
import { whatsappLink } from '@/lib/quotations/math'
import { waitsFor } from '@/lib/quotations/piWorkbook'
import { AskButton, AskNote } from './AskCard'
import { LeadCard } from './LeadCard'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>

export const LOCKED: QuotationStatus[] = ['confirmed', 'lost', 'archived']

/** The "what Orders still needs" line; it lives in piWorkbook.ts so Lead Management says the same words. */
export { waitsFor }

export type Outcome = 'unshare' | 'delete'

type Props = {
  supabase: Supabase; id: string; base: Quotation; dirty: boolean; busy: boolean
  lineCount: number; phone: string; waText: string; copied: boolean
  /** The logo on the pictures (20270806000200): undefined until it has loaded; changing it is for people who may edit. */
  markOn?: boolean | null; onMark?: (on: boolean) => void
  onCopy: () => void; onExcel: () => void; onShare: (on: boolean) => void
  /** 20270817000000: the database says this person may delete this quotation now; the item opens the confirm. */
  canDelete?: boolean; onDelete?: () => void
  /** The lead or the ask changed something the quotation shows: read it again. */
  onChanged: () => void; onSentBack?: () => void
}

export function TopPanel({
  supabase, id, base, dirty, busy, lineCount, phone, waText, copied, markOn, onMark, onCopy, onExcel, onShare, canDelete, onDelete, onChanged, onSentBack,
}: Props) {
  const status = base.status
  const may = base.may_edit
  const off = busy || dirty
  const saveFirst = dirty ? 'Save first' : undefined

  // Turning the client link off and Delete, behind the ⋯ menu (it draws nothing when neither applies).
  const items: MoreActionItem<Outcome>[] = []
  if (may && base.share_token) items.push({ key: 'unshare', label: 'Turn the client link off', disabled: off, title: saveFirst })
  if (canDelete && onDelete) items.push({ key: 'delete', label: 'Delete…', disabled: busy, danger: true })
  const pick = (k: Outcome) => (k === 'unshare' ? onShare(false) : onDelete?.())

  const logoOn = markOn !== false

  return (
    <section className={s.panel} aria-label="Status, lead and sharing">
      <LeadCard supabase={supabase} base={base} dirty={dirty} onChanged={onChanged} />
      <AskNote supabase={supabase} base={base} />

      <div className={`${s.prow} ${s.pbar}`} role="group" aria-label="Share">
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
            {base.pi && <span className={s.leadMeta}>PI draft <b>{base.pi.draft_reference ?? ''}</b> · {base.pi.status.replace(/_/g, ' ')}</span>}
            {base.pi && <Link className={`${s.btn} ${s.btnPrimary} ${s.pnext}`} href={draftDetailHref(base.pi.id)}><FileCheck2 size={15} aria-hidden /> Open the PI draft</Link>}
            <span className={s.pmore}><MoreActionsMenu items={items} onSelect={pick} ariaLabel="More actions" triggerClassName={s.iconBox} /></span>
          </div>
        </div>
      </div>
    </section>
  )
}
