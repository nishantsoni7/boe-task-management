'use client'

// Links back (20270629000000): the "From quotation" mark on a PI draft, and "Make it in Quotations" on a quotation
// request. Plain effects and a plain navigation (no data provider, no router hook), so the PI and request screens and
// their render tests are unchanged until these draw. The mark loads AFTER the page has drawn.

import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FileText, MessageCircle, Printer } from 'lucide-react'
import { AppLink as Link } from '@/components/ui/AppLink'
import { STATUS_LABEL, type QuotationStatus } from '@/lib/quotations/api'
import { formatDateIN, whatsappLink } from '@/lib/quotations/math'
import { formatINR } from '@/lib/currency'
import { istDateOf } from '@/lib/istDate'

type Mark = { id: string; quote_no: string; version_no: number | null }

/** "From quotation QT-… v2 → open", or nothing (no quotation, no access, or not set up yet). */
export function FromQuotationMark({ supabase, submissionId }: { supabase: SupabaseClient; submissionId: string }) {
  const [mark, setMark] = useState<Mark | null>(null)
  useEffect(() => {
    let live = true
    void supabase.rpc('quotation_for_pi', { p_submission_id: submissionId }).then(({ data }) => { if (live) setMark((data as Mark | null) ?? null) })
    return () => { live = false }
  }, [supabase, submissionId])
  if (!mark) return null
  return (
    <Link href={`/quotations/${mark.id}`} className="boe-btn boe-btn-ghost" style={{ alignSelf: 'flex-start', gap: 6 }}>
      <FileText size={14} aria-hidden /> From quotation {mark.quote_no}{mark.version_no ? ` · v${mark.version_no}` : ''}
    </Link>
  )
}

export type RequestQuotationInfo = {
  id: string; quote_no: string; status: QuotationStatus; value_before_gst: number | string | null
  version_no: number | null; sent_at: string | null; last_opened_at: string | null
  share_token: string | null; contact_phone: string | null
}

/** "version 2 · sent 18 Nov 2026 · client opened 19 Nov 2026", or "not sent yet". */
export function requestQuotationMeta(q: Pick<RequestQuotationInfo, 'sent_at' | 'last_opened_at' | 'version_no'>): string {
  const day = (iso: string) => formatDateIN(istDateOf(iso))
  return [
    q.version_no ? `version ${q.version_no}` : null,
    q.sent_at ? `sent ${day(q.sent_at)}` : 'not sent yet',
    q.last_opened_at ? `client opened ${day(q.last_opened_at)}` : null,
  ].filter(Boolean).join(' · ')
}

/**
 * The request page's quotation (owner, 18 Nov 2026: Tasks is the front door, the work happens in Quotations): the
 * quotation this request led to, with Open builder / PDF / WhatsApp, for whoever may see it (quotation_for_request,
 * 20270805000000). With none yet, the person the request is assigned to gets "Build in BOE One".
 */
export function RequestQuotation({ supabase, taskId, canMake }: { supabase: SupabaseClient; taskId: string; canMake: boolean }) {
  const [q, setQ] = useState<RequestQuotationInfo | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void supabase.rpc('quotation_for_request', { p_task_id: taskId })
      .then(({ data }) => { if (live) setQ((data as RequestQuotationInfo | null) ?? null) }, () => { if (live) setQ(null) })
    return () => { live = false }
  }, [supabase, taskId])
  if (q === undefined) return null
  if (!q) return canMake ? <MakeInQuotations supabase={supabase} taskId={taskId} /> : null
  const link = q.share_token ? `${window.location.origin}/q/${q.share_token}` : null
  const wa = link && q.contact_phone ? whatsappLink(q.contact_phone, `Here is our quotation ${q.quote_no}: ${link}`) : null
  return (
    <div className="boe-card" style={{ padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 10, borderLeft: '3px solid var(--boe-brand)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--boe-text-muted)' }}>Quotation in BOE One</span>
        <span style={{ fontSize: 12, fontWeight: 700, padding: '1px 8px', borderRadius: 10, background: 'var(--boe-surface-sunken)', color: 'var(--boe-text)' }}>{STATUS_LABEL[q.status] ?? q.status}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 17 }}>{q.quote_no}</b>
        <span style={{ fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatINR(Number(q.value_before_gst || 0))}</span>
        <span style={{ fontSize: 12.5, color: 'var(--boe-text-muted)' }}>before GST</span>
      </div>
      <span style={{ fontSize: 12.5, color: 'var(--boe-text-muted)' }}>{requestQuotationMeta(q)}</span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Link href={`/quotations/${q.id}`} className="boe-btn boe-btn-primary" style={{ gap: 6 }}><FileText size={15} aria-hidden /> Open builder</Link>
        <Link href={`/quotations/${q.id}/print`} className="boe-btn" style={{ gap: 6 }}><Printer size={15} aria-hidden /> PDF</Link>
        {wa && <a href={wa} target="_blank" rel="noreferrer" className="boe-btn" style={{ gap: 6 }}><MessageCircle size={15} aria-hidden /> WhatsApp</a>}
      </div>
    </div>
  )
}

/**
 * On an old quotation request (made in Task Management before 20 Nov 2026): no quotation can be made from the request any more,
 * because every quotation starts from a Sales lead (owner, 20 Nov 2026). This points to New quotation, where the lead is chosen.
 * The old create-from-request database function is no longer called from the app.
 */
export function MakeInQuotations({ supabase }: { supabase: SupabaseClient; taskId: string }) {
  void supabase
  return (
    <div className="boe-card" style={{ padding: '14px 22px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
      <span style={{ fontSize: 13, flex: '1 1 260px' }}><b>Make it in Quotations:</b> every quotation now starts from the client&apos;s Sales lead, and the details come from it. Choose the lead there; the quotation goes to the salesperson&apos;s own list.</span>
      <Link href="/quotations?new=1" className="boe-btn boe-btn-primary"><FileText size={15} aria-hidden /> Start from the lead</Link>
    </div>
  )
}
