'use client'

// The builder's Share card (owner-approved layout, 18 Nov 2026): the two downloads, then the client link and its WhatsApp message.
// Moved out of BuilderScreen with its behaviour unchanged: everything works on the SAVED quotation, so each button waits while
// there are unsaved edits.

import { AppLink as Link } from '@/components/ui/AppLink'
import { Check, Copy, FileSpreadsheet, Link2, MessageCircle, Printer, Share2 } from 'lucide-react'
import type { Quotation } from '@/lib/quotations/api'
import { whatsappLink } from '@/lib/quotations/math'
import s from './quotations.module.css'

type Props = {
  id: string; base: Quotation; dirty: boolean; busy: boolean; lineCount: number; phone: string
  link: string; waText: string; copied: boolean
  onCopy: () => void; onExcel: () => void; onShare: (on: boolean) => void
}

export function ShareCard({ id, base, dirty, busy, lineCount, phone, link, waText, copied, onCopy, onExcel, onShare }: Props) {
  return (
    <section className={`${s.card} ${s.tile}`} aria-labelledby="q-share">
      <h2 id="q-share" className={s.tileLab}><Share2 size={15} aria-hidden /> Share with the client</h2>
      <div className={s.acts2}>
        {dirty
          ? <button type="button" className={s.btn} disabled><Printer size={15} aria-hidden /> Download PDF</button>
          : <Link className={s.btn} href={`/quotations/${id}/print`} target="_blank"><Printer size={15} aria-hidden /> Download PDF</Link>}
        <button type="button" className={s.btn} onClick={onExcel} disabled={dirty || busy || lineCount === 0}><FileSpreadsheet size={15} aria-hidden /> Download Excel</button>
      </div>
      {!base.share_token && <p className={s.tileText}>One link shows the quotation with pictures and a Save as PDF button. No login needed. Turning it on marks a draft as Sent.</p>}
      {base.share_token && (
        <>
          <div className={s.linkBox}><input id="q-link" className={s.input} value={link} readOnly aria-label="Client link" onFocus={e => e.currentTarget.select()} /><button type="button" className={s.iconBtn} onClick={onCopy} aria-label="Copy link">{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>
          <div className={s.acts2}>
            {dirty
              ? <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled title="Save first"><MessageCircle size={15} aria-hidden /> Open WhatsApp with the message (save first)</button>
              : <a className={`${s.btn} ${s.btnPrimary}`} href={whatsappLink(phone, waText)} target="_blank" rel="noreferrer"><MessageCircle size={15} aria-hidden /> Open WhatsApp with the message</a>}
          </div>
          <p className={s.tileText}>WhatsApp opens with the text ready{phone ? ` for ${phone}` : ''}; you press send. The message carries the link, which shows the version you last sent (before any version is sent, the latest saved copy) and has its own Save as PDF button. After changing prices, use Send as new version below.</p>
        </>
      )}
      {base.may_edit && (dirty ? <p className={`${s.tileText} ${s.dirty}`}>Save first: the PDF, the Excel and the link all use the saved quotation.</p>
        : <div className={s.tileAct}>
          {base.share_token
            ? <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => onShare(false)}>Turn the link off</button>
            : <button type="button" className={s.btn} disabled={busy || lineCount === 0 || base.status === 'archived' || !!base.price?.blocked} title={base.price?.blocked ? 'Waiting for price approval' : undefined} onClick={() => onShare(true)}><Link2 size={15} aria-hidden /> Create client link</button>}
        </div>)}
    </section>
  )
}
