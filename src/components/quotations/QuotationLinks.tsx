'use client'

// Links back (20270629000000): the "From quotation" mark on a PI draft, and "Make it in Quotations" on a quotation
// request. Plain effects and a plain navigation (no data provider, no router hook), so the PI and request screens and
// their render tests are unchanged until these draw. The mark loads AFTER the page has drawn.

import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FileText } from 'lucide-react'
import { AppLink as Link } from '@/components/ui/AppLink'

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

/** On a quotation request, for the person it is assigned to: start (or reopen) its quotation in Quotations. */
export function MakeInQuotations({ supabase, taskId }: { supabase: SupabaseClient; taskId: string }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const go = async () => {
    setBusy(true); setErr('')
    const { data, error } = await supabase.rpc('quotation_create_from_request', { p_task_id: taskId })
    if (error || typeof data !== 'string') {
      setBusy(false)
      setErr(/Could not find the function|does not exist/i.test(error?.message ?? '') ? 'Quotations is being set up for requests. Try again later.'
        : (error?.message ?? 'Could not open the quotation.').replace(/^.*(QUOTATIONS_FORBIDDEN|QUOTATION_LOCKED|QUOTATION_NOT_FOUND):\s*/, ''))
      return
    }
    window.location.assign(`/quotations/${data}`)
  }
  return (
    <div className="boe-card" style={{ padding: '14px 22px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
      <span style={{ fontSize: 13, flex: '1 1 260px' }}>Build this quotation in BOE One: the client and requirement are filled in, the salesperson gets it in their quotations, and <b>Send to sales</b> there completes this request.</span>
      <button type="button" className="boe-btn boe-btn-primary" onClick={go} disabled={busy}><FileText size={15} aria-hidden /> {busy ? 'Opening…' : 'Make it in Quotations'}</button>
      {err && <span role="alert" style={{ color: '#7E1B2B', fontSize: 13, flexBasis: '100%' }}>{err}</span>}
    </div>
  )
}
