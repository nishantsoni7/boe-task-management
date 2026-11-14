'use client'

import { useMemo } from 'react'
import { AppLink as Link } from '@/components/ui/AppLink'
import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Download } from 'lucide-react'
import { LoadingScreen } from '@/components/ui/atoms'
import { useQuotations } from '@/hooks/useQuotations'
import { createClient } from '@/lib/supabase/client'
import { errorText, fetchPublic, fetchQuotation, pictureUrl, quotationKeys } from '@/lib/quotations/api'
import { documentFileName } from '@/lib/quotations/documentPlan'
import { QuotationDocument } from './QuotationDocument'
import p from './screens.module.css'

// Two ways to the same printed quotation: the salesperson's print page (signed in, inside the module gate) and
// the client's link (no session; only the client-safe fields quotation_public returns).
//
// "Download PDF" is the browser's own Save as PDF over the very same pages (the document is laid out in A4 sheets, see
// document.module.css): one design to keep, an exact match with the screen. The file takes the page title, so it is set to
// the quotation number and project while the dialog is open. The fonts and pictures are waited for first, or the PDF would
// be made from fallback type and empty frames.

async function savePdf(fileName: string) {
  const old = document.title
  document.title = fileName
  window.addEventListener('afterprint', () => { document.title = old }, { once: true })
  try {
    await document.fonts?.ready
    // the pictures below the first screen are lazy: ask for all of them now, and give them 20 s at most
    for (const i of document.images) i.loading = 'eager'
    const later = new Promise<void>(r => setTimeout(r, 20_000))
    await Promise.race([Promise.all(Array.from(document.images, i => i.decode().catch(() => undefined))), later])
  } catch { /* print anyway: a missing font or picture is better than no PDF */ }
  window.print()
}

function Bar({ back, fileName }: { back?: React.ReactNode; fileName: string }) {
  return (
    <div className={p.bar}>
      {back}
      <span style={{ flex: 1 }} />
      <span className={p.barHint}>In the print window, choose “Save as PDF”</span>
      <button className={p.btn} onClick={() => void savePdf(fileName)}><Download size={15} aria-hidden /> Download PDF</button>
    </div>
  )
}

export function PrintScreen() {
  const { id } = useParams<{ id: string }>()
  const { supabase, loading, accessLoaded } = useQuotations()
  const q = useQuery({ queryKey: quotationKeys.one(id), queryFn: () => fetchQuotation(supabase, id), enabled: accessLoaded, retry: false })
  if (loading || q.isLoading || (!q.data && !q.isError)) return <LoadingScreen />
  if (q.isError || !q.data) return <div className={p.page}><div className={p.msg}>{errorText(q.error)}</div></div>
  const x = q.data
  return (
    <div className={p.page}>
      <Bar fileName={documentFileName(x.quote_no, x.header.project_name, x.header.client_name)} back={<Link className={p.btn} href={`/quotations/${id}`}><ArrowLeft size={15} aria-hidden /> Back to the quotation</Link>} />
      <QuotationDocument pictureUrl={path => pictureUrl(supabase, path)} doc={{
        quote_no: x.quote_no, issued_at: x.sent_at ?? x.created_at, valid_days: x.header.valid_days, client_name: x.header.client_name,
        project_name: x.header.project_name || null, contact_name: x.header.contact_name || null, salesperson: x.owner_name,
        company_name: x.header.company_name || null, client_gstin: x.header.client_gstin || null, dimension_unit: x.header.dimension_unit,
        project_type: x.header.project_type || null, seats: x.header.seats, lead_time_weeks: x.header.lead_time_weeks,
        salesperson_phone: x.owner_phone, salesperson_email: x.owner_email,
        gst_mode: x.header.gst_mode, discount_pct: x.header.discount_pct, fabric_amount: x.header.fabric_amount,
        packing_amount: x.header.packing_amount, transport_note: x.header.transport_note || null, notes: x.header.notes || null,
        areas: x.areas, lines: x.lines,
      }} />
    </div>
  )
}

export function PublicScreen() {
  const { token } = useParams<{ token: string }>()
  const supabase = useMemo(() => createClient(), [])
  const q = useQuery({ queryKey: ['quotations', 'public', token], queryFn: () => fetchPublic(supabase, token), retry: false, staleTime: 60_000 })
  if (q.isLoading) return <LoadingScreen />
  if (q.isError || !q.data) {
    return (
      <div className={p.page}><div className={p.msg}>
        <h1>This quotation link is not active</h1>
        <p>It may have been turned off or replaced. Please ask your Best of Exports contact for the latest link.</p>
      </div></div>
    )
  }
  return (
    <div className={p.page}>
      <Bar fileName={documentFileName(q.data.quote_no, q.data.project_name, q.data.client_name)} />
      <QuotationDocument doc={q.data} pictureUrl={path => pictureUrl(supabase, path)} />
      <p className={p.privacy}>Opening this link is recorded so your Best of Exports contact knows it reached you.</p>
    </div>
  )
}
