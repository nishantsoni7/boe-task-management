'use client'

// Phase 5, the pricing desk: the price hint under each product's price, the price-approval card on a quotation,
// and, on the list, the desk's "Waiting for price approval" list and the administrator's limits.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AppLink as Link } from '@/components/ui/AppLink'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BadgeCheck } from 'lucide-react'
import type { createClient } from '@/lib/supabase/client'
import { formatINR } from '@/lib/currency'
import { formatDateIN } from '@/lib/quotations/math'
import { suggestPrice } from '@/lib/pricing/suggest'
import type { ModelSuggestion } from '@/lib/pricing/model'
import { SuggestionFeedback, type FeedbackLine } from '@/components/pricing/learning/SuggestionFeedback'
import { istDateOf } from '@/lib/istDate'
import {
  errorText, fetchPriceQueue, fetchPriceSettings, savePriceSettings,
  type PriceHint, type PriceReason, type PriceState,
} from '@/lib/quotations/api'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>

type WhyCtx = { line: FeedbackLine; clientType: string | null; quotationId: string | null; isDesk: boolean }

/**
 * The suggested price, kept to one line for everyone: "Suggested ₹4,790 (₹3,800–₹6,050)  Use", or "Last ordered ₹7,300  Use" when
 * only history is known (owner, 15 Nov 2026: the old block was "extremely messy"). How it was worked out, the history, and the
 * way to correct the logic sit behind "Why?", which only people who pass `feedback` see (the builder gives it to holders of the
 * Pricing module: Admin, or granted per person). Hiding is a need-to-see filter, not a security boundary: the model is fitted
 * in the browser from the shared price pool.
 */
export function PriceHintLine({ hint, model, price, editable, onUse, feedback }: {
  hint?: PriceHint; model?: ModelSuggestion | null; price: number | null; editable: boolean; onUse: (p: number) => void
  feedback?: WhyCtx
}) {
  const [why, setWhy] = useState(false)
  if (!model && (!hint || (!hint.ordered && !hint.quoted))) return null
  const o = hint?.ordered ?? null
  const sug = model ?? (hint?.points ? suggestPrice(hint.points) : null)
  const last = sug ? sug.price : o ? Number(o.last) : Number(hint!.quoted!.last)
  return (
    <div className={`${s.small} ${s.muted}`} style={{ lineHeight: 1.35 }}>
      {sug
        ? <>Suggested <b>{formatINR(sug.price)}</b>{sug.low !== sug.high && <> ({formatINR(sug.low)}–{formatINR(sug.high)})</>}</>
        : o ? <>Last ordered <b>{formatINR(Number(o.last))}</b></> : <>Last quoted <b>{formatINR(Number(hint!.quoted!.last))}</b></>}
      {editable && price !== last && <> <button type="button" className={s.linkBtn} onClick={() => onUse(last)}>Use</button></>}
      {feedback && <> <button type="button" className={s.linkBtn} onClick={() => setWhy(true)} aria-haspopup="dialog">Why?</button></>}
      {why && feedback && <PriceWhy ctx={feedback} hint={hint} model={model} sug={sug} onClose={() => setWhy(false)} />}
    </div>
  )
}

/** The popup behind "Why?": what the suggestion rests on, the history, and the form to share feedback or correct the logic. */
function PriceWhy({ ctx, hint, model, sug, onClose }: { ctx: WhyCtx; hint?: PriceHint; model?: ModelSuggestion | null; sug: { price: number; low: number; high: number; confidence: string; basis: string } | null; onClose: () => void }) {
  const o = hint?.ordered ?? null
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // In the body, not inside the product row: the row sits in a muted small-print block that a popup must not inherit.
  return createPortal(
    <div className={s.scrim} onClick={onClose}>
      <div className={s.modal} style={{ maxWidth: 480, color: 'var(--boe-text)', fontSize: 14 }} role="dialog" aria-modal="true" aria-labelledby="why-title" onClick={e => e.stopPropagation()}>
        <div className={s.cardHead}><h2 id="why-title">{ctx.line.name.trim() || 'This product'}: the price</h2><span className={s.spacer} /><button type="button" className={s.iconBtn} onClick={onClose} aria-label="Close" autoFocus>×</button></div>
        <div className={s.cardBody} style={{ display: 'grid', gap: 10 }}>
          {sug && (
            <div>
              <div>Suggested <b>{formatINR(sug.price)}</b>{sug.low !== sug.high && <> · range {formatINR(sug.low)}–{formatINR(sug.high)}</>} · {sug.confidence} confidence</div>
              <div className={`${s.small} ${s.muted}`}>From {sug.basis}</div>
            </div>
          )}
          {model && model.reasons.length > 0 && <ul className={s.small} style={{ margin: 0, paddingLeft: 18 }}>{model.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
          {(o || hint?.quoted) && (
            <div className={s.small}>
              {o && <div>Last ordered <b>{formatINR(Number(o.last))}</b>{Number(o.count) > 1 && <> · {formatINR(Number(o.min))}–{formatINR(Number(o.max))} over {o.count} orders</>}</div>}
              {hint?.quoted && <div>Last quoted <b>{formatINR(Number(hint.quoted.last))}</b></div>}
            </div>
          )}
          {sug && (
            <SuggestionFeedback source="quotation" line={ctx.line} clientType={ctx.clientType} quotationId={ctx.quotationId} isDesk={ctx.isDesk} defaultOpen
              suggestion={{ price: sug.price, low: sug.low, high: sug.high, confidence: sug.confidence, basis: sug.basis, reasons: model?.reasons ?? [] }} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function reasonText(r: PriceReason): string {
  return r.kind === 'discount'
    ? `Discount ${Number(r.pct)}% is above ${Number(r.limit)}%`
    : `${r.line}: ${formatINR(Number(r.price))} is ${Number(r.pct)}% of the last ordered ${formatINR(Number(r.last))} (limit ${Number(r.limit)}%)`
}

const STATE_TEXT: Record<PriceState['state'], string> = {
  not_needed: 'No approval needed', to_ask: 'Needs price approval', requested: 'Waiting for the pricing desk',
  approved: 'Prices approved', returned: 'Sent back by the pricing desk',
}

/** The approval card on a quotation. Hidden when nothing needs approval and nothing was ever asked. */
export function PriceCard({ id, price, mayEdit, dirty, busy, onAsk, onDecide }: {
  id?: string; price: PriceState | null; mayEdit: boolean; dirty: boolean; busy: boolean
  onAsk: () => void; onDecide: (approve: boolean, note: string | null) => void
}) {
  const [note, setNote] = useState<string | null>(null)
  if (!price || (price.state === 'not_needed')) return null
  const tone = price.state === 'approved' ? s.noticeOk : price.state === 'returned' ? s.noticeBad : s.noticeWarn
  return (
    <section id={id} className={s.card}>
      <div className={s.cardHead}><h2>Price approval</h2></div>
      <div className={s.cardBody} style={{ display: 'grid', gap: 8 }}>
        <div className={`${s.notice} ${tone}`}>
          <b>{STATE_TEXT[price.state]}</b>
          {price.reasons.map((r, i) => <div key={i}>{reasonText(r)}</div>)}
          {price.note && <div style={{ marginTop: 4 }}>“{price.note}”{price.by ? ` · ${price.by}` : ''}</div>}
        </div>
        {price.blocked && <div className={`${s.small} ${s.muted}`}>The client link and Confirm → PI wait for approval.</div>}
        {dirty && <div className={`${s.small} ${s.dirty}`}>Save first: approval is for the saved prices.</div>}
        {mayEdit && !dirty && (price.state === 'to_ask' || price.state === 'returned') && (
          <button className={`${s.btn} ${s.btnPrimary}`} disabled={busy} onClick={onAsk}>Ask for price approval</button>
        )}
        {price.may_decide && !dirty && price.state !== 'approved' && (
          note === null ? (
            <div className={s.row}>
              <button className={`${s.btn} ${s.btnPrimary} ${s.btnSm}`} disabled={busy} onClick={() => onDecide(true, null)}><BadgeCheck size={14} aria-hidden /> Approve prices</button>
              <button className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => setNote('')}>Send back…</button>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 6 }}>
              <label className={s.field}><span>What should change?</span><input id="price-note" className={s.input} value={note} onChange={e => setNote(e.target.value)} placeholder="Hold the bed at ₹55,000" autoFocus /></label>
              <div className={s.row}>
                <button className={`${s.btn} ${s.btnSm} ${s.btnDanger}`} disabled={busy || note.trim().length < 3} onClick={() => { onDecide(false, note); setNote(null) }}>Send back</button>
                <button className={`${s.btn} ${s.btnSm}`} onClick={() => setNote(null)}>Cancel</button>
              </div>
            </div>
          )
        )}
      </div>
    </section>
  )
}

/** The desk's list on the Quotations page. */
export function PriceQueue({ supabase }: { supabase: Supabase }) {
  const q = useQuery({ queryKey: ['quotations', 'price-queue'], queryFn: () => fetchPriceQueue(supabase), staleTime: 20_000, retry: false })
  if (!q.data || q.data.length === 0) return null
  return (
    <div className={s.card}>
      <div className={s.cardHead}><h2>Waiting for price approval</h2><span className={s.spacer} /><span className={s.muted}>{q.data.length}</span></div>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead><tr><th>Quotation</th><th>Why</th><th className={s.right}>Before GST</th><th className={s.desktopOnly}>Asked</th></tr></thead>
          <tbody>
            {q.data.map(r => (
              <tr key={r.id}>
                <td><Link href={`/quotations/${r.id}`} className={s.name}>{r.quote_no}</Link><div className={s.sub}>{r.client_name}{r.owner_name ? ` · ${r.owner_name}` : ''}</div></td>
                <td className={s.small}>{r.reasons.map((x, i) => <div key={i}>{reasonText(x)}</div>)}</td>
                <td className={s.right}>{formatINR(Number(r.value_before_gst))}</td>
                <td className={s.desktopOnly}>{formatDateIN(istDateOf(r.requested_at))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** The two limits; an administrator changes them, everyone else reads them. Empty = off. */
export function PriceLimits({ supabase }: { supabase: Supabase }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['quotations', 'price-settings'], queryFn: () => fetchPriceSettings(supabase), retry: false })
  const [edit, setEdit] = useState<{ d: string; p: string } | null>(null)
  const [err, setErr] = useState('')
  if (!q.data || !q.data.may_change) return null
  const v = q.data
  const show = (x: number | null, unit: string) => (x === null ? 'off' : `${Number(x)}${unit}`)
  const save = async () => {
    setErr('')
    try {
      await savePriceSettings(supabase, edit!.d.trim() === '' ? null : Number(edit!.d), edit!.p.trim() === '' ? null : Number(edit!.p))
      setEdit(null); await qc.invalidateQueries({ queryKey: ['quotations'] })
    } catch (e) { setErr(errorText(e)) }
  }
  return (
    <div className={s.card}>
      <div className={s.cardBody} style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
        {edit === null ? (
          <>
            <div className={s.small}><b>Price approval</b> is needed above a {show(v.max_discount_pct, '%')} discount, or below {show(v.min_price_pct, '%')} of the last ordered price.</div>
            <button className={`${s.btn} ${s.btnSm}`} onClick={() => setEdit({ d: v.max_discount_pct === null ? '' : String(Number(v.max_discount_pct)), p: v.min_price_pct === null ? '' : String(Number(v.min_price_pct)) })}>Change limits</button>
          </>
        ) : (
          <>
            <label className={s.field}><span>Discount above (%)</span><input id="lim-d" className={s.input} style={{ width: 110 }} inputMode="decimal" value={edit.d} onChange={e => setEdit({ ...edit, d: e.target.value })} placeholder="off" /></label>
            <label className={s.field}><span>Price below (% of last ordered)</span><input id="lim-p" className={s.input} style={{ width: 110 }} inputMode="decimal" value={edit.p} onChange={e => setEdit({ ...edit, p: e.target.value })} placeholder="off" /></label>
            <button className={`${s.btn} ${s.btnPrimary} ${s.btnSm}`} onClick={save}>Save limits</button>
            <button className={`${s.btn} ${s.btnSm}`} onClick={() => setEdit(null)}>Cancel</button>
            <span className={`${s.small} ${s.muted}`}>Leave empty to switch that check off.</span>
          </>
        )}
        {err && <div className={`${s.notice} ${s.noticeBad}`}>{err}</div>}
      </div>
    </div>
  )
}
