'use client'

// The price brief (owner, 20 Nov 2026): when the owner or Nitish sends a priced quotation back, or shares it, the page asks how each price was
// worked out, so the price calculator can be taught. Always asked, always optional: Skip is as easy as Save. A product left blank is not
// stored; a product briefed before on this quotation comes back pre-filled.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { createClient } from '@/lib/supabase/client'
import { briefKey, errorText, fetchBriefs, saveBriefs, type BriefLine } from '@/lib/quotations/api'
import { formatINR } from '@/lib/currency'
import { useDialogFocus } from '@/components/salesLeads/useDialogFocus'
import type { QuoteLine } from '@/lib/quotations/math'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>

export function PriceBrief({ supabase, quotationId, lines, onClose }: { supabase: Supabase; quotationId: string; lines: QuoteLine[]; onClose: (saved: number) => void }) {
  const priced = lines.filter(l => l.name.trim() && (l.unit_price ?? 0) > 0 && !l.is_optional)
  const before = useQuery({ queryKey: briefKey(quotationId), queryFn: () => fetchBriefs(supabase, quotationId), retry: false, staleTime: 0 })
  const [text, setText] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const value = (l: QuoteLine) => text[l.key] ?? before.data?.[l.name.trim()] ?? ''
  const dialogRef = useDialogFocus<HTMLDivElement>(() => { if (!busy && !Object.values(text).some(v => v.trim())) onClose(0) })

  const save = async () => {
    const items: BriefLine[] = priced.map(l => ({
      name: l.name.trim(), size: l.size_text || undefined, material: l.material || undefined, finish: l.finish || undefined,
      qty: l.qty, price: Number(l.unit_price), reason: value(l).trim(),
    })).filter(i => i.reason)
    if (!items.length) { onClose(0); return }
    setBusy(true); setErr('')
    try { onClose(await saveBriefs(supabase, quotationId, items)) } catch (e) { setErr(errorText(e)); setBusy(false) }
  }

  return (
    <div className={s.scrim}>
      <div ref={dialogRef} tabIndex={-1} className={s.modal} style={{ maxWidth: 720 }} role="dialog" aria-modal="true" aria-labelledby="brief-title">
        <div className={s.cardHead}><h2 id="brief-title">How were these prices worked out?</h2></div>
        <div className={s.cardBody} style={{ display: 'grid', gap: 12 }}>
          <p className={`${s.small} ${s.muted}`} style={{ margin: 0 }}>Optional. A line or two per product (wood, size, labour, margin, what you compared it with) teaches the price calculator. Leave a product blank to skip it.</p>
          {priced.length === 0 && <div className={s.muted}>There are no priced products to brief.</div>}
          <div style={{ display: 'grid', gap: 10, maxHeight: '52vh', overflow: 'auto' }}>
            {priced.map(l => (
              <label key={l.key} className={s.field}>
                <span>{l.name} <span className={s.muted}>· {formatINR(Number(l.unit_price))}{l.size_text ? ` · ${l.size_text}` : ''}{l.material ? ` · ${l.material}` : ''}</span></span>
                <textarea className={s.input} style={{ height: 'auto', minHeight: 52, padding: 8, resize: 'vertical' }} rows={2} maxLength={1000} value={value(l)} disabled={busy}
                  onChange={e => setText(p => ({ ...p, [l.key]: e.target.value }))} placeholder="e.g. Teak 2.1 cft at 4,200 + labour 1,800 + 25% margin" />
              </label>
            ))}
          </div>
          {err && <div className={`${s.notice} ${s.noticeBad}`} role="alert">{err}</div>}
        </div>
        <div className={s.cardHead} style={{ borderTop: '1px solid var(--boe-border)', borderBottom: 0, justifyContent: 'flex-end' }}>
          <button type="button" className={s.btn} disabled={busy} onClick={() => onClose(0)}>Skip</button>
          <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={busy || priced.length === 0} onClick={save}>{busy ? 'Saving…' : 'Save the briefs'}</button>
        </div>
      </div>
    </div>
  )
}
