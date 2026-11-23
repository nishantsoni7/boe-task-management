'use client'

// The builder's Share card (owner-approved layout, 18 Nov 2026; tidied 23 Nov 2026): the two downloads, the logo switch, then the client link
// and its WhatsApp message. Everything works on the SAVED quotation, so each button waits while there are unsaved edits. The explanations
// under the controls are one or two lines each (they were three).

import { AppLink as Link } from '@/components/ui/AppLink'
import { Check, Copy, FileSpreadsheet, Link2, MessageCircle, Printer, Share2 } from 'lucide-react'
import type { Quotation } from '@/lib/quotations/api'
import { whatsappLink } from '@/lib/quotations/math'
import s from './quotations.module.css'

type Props = {
  id: string; base: Quotation; dirty: boolean; busy: boolean; lineCount: number; phone: string
  link: string; waText: string; copied: boolean
  onCopy: () => void; onExcel: () => void; onShare: (on: boolean) => void
  /** The logo on the pictures (20270806000200): undefined until it has loaded; changing it is for people who may edit. */
  markOn?: boolean | null; onMark?: (on: boolean) => void
}

export function ShareCard({ id, base, dirty, busy, lineCount, phone, link, waText, copied, onCopy, onExcel, onShare, markOn, onMark }: Props) {
  const on = markOn !== false
  return (
    <section className={`${s.card} ${s.tile}`} aria-labelledby="q-share">
      <h2 id="q-share" className={s.tileLab}><Share2 size={15} aria-hidden /> Share with the client</h2>
      <div className={s.acts2}>
        {dirty
          ? <button type="button" className={s.btn} disabled><Printer size={15} aria-hidden /> Download PDF</button>
          : <Link className={s.btn} href={`/quotations/${id}/print`} target="_blank"><Printer size={15} aria-hidden /> Download PDF</Link>}
        <button type="button" className={s.btn} onClick={onExcel} disabled={dirty || busy || lineCount === 0}><FileSpreadsheet size={15} aria-hidden /> Download Excel</button>
      </div>
      {onMark && <label className={s.markRow}>
        <input type="checkbox" role="switch" id="q-mark" checked={on} onChange={e => onMark(e.target.checked)}
          disabled={busy || !base.may_edit || base.status === 'archived' || markOn === undefined || markOn === null} />
        <span><b>Logo on pictures</b> <span className={`${s.small} ${s.muted}`}>· {on ? 'Best of Exports strip on each picture' : 'clean pictures, no strip'}</span></span>
      </label>}
      <div className={s.shareFoot}>
        {base.share_token && (
          <>
            <div className={s.linkBox}><input id="q-link" className={s.input} value={link} readOnly aria-label="Client link" onFocus={e => e.currentTarget.select()} /><button type="button" className={s.iconBtn} onClick={onCopy} aria-label="Copy link">{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>
            <div className={s.acts2}>
              {dirty
                ? <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled title="Save first"><MessageCircle size={15} aria-hidden /> Open WhatsApp with the message (save first)</button>
                : <a className={`${s.btn} ${s.btnPrimary}`} href={whatsappLink(phone, waText)} target="_blank" rel="noreferrer"><MessageCircle size={15} aria-hidden /> Open WhatsApp with the message</a>}
            </div>
            <p className={s.tileText}>WhatsApp opens with the text ready{phone ? ` for ${phone}` : ''}; you press send. The link shows the version you last sent (before one is sent, the saved copy): after changing prices, use Send as new version below.</p>
          </>
        )}
        {base.may_edit && (dirty ? <p className={`${s.tileText} ${s.dirty}`}>Save first: the PDF, the Excel and the link all use the saved quotation.</p>
          : <div className={s.tileAct}>
            {base.share_token
              ? <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => onShare(false)}>Turn the link off</button>
              : <button type="button" className={s.btn} disabled={busy || lineCount === 0 || base.status === 'archived' || !!base.price?.blocked} title={base.price?.blocked ? 'Waiting for price approval' : undefined} onClick={() => onShare(true)}><Link2 size={15} aria-hidden /> Create client link</button>}
          </div>)}
        {!base.share_token && <p className={s.tileText}>One link with the pictures and a Save as PDF button; no login. Turning it on marks a draft as Sent.</p>}
      </div>
    </section>
  )
}
