'use client'

// ── PAYMENT PLAN, its own page: /orders/[id]/payment-plan ───────────────────
//
// How much more the client must pay before a dispatch: the goods leaving in
// full (with their share of every charge, and GST on the billed part), plus a
// chosen share of the goods still to come. Every figure is computed live by
// computePaymentPlan (lib/orders/paymentPlan.ts); this file only draws it and
// saves the inputs.
//
// Self-loading: the Order page only links here, so its counted startup reads
// are unchanged. One read (order_payment_plan_read), plus the product pictures
// (read under the person's own access; no picture just shows "No image"), and
// writes only through the order_payment_plan_* / order_dispatch_lot_* functions
// of 20270428000000, which re-derive who may. `canEdit` and `isAdmin` decide
// only which controls are drawn.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ORDER_FILES_BUCKET } from '@/lib/orders/draftsView'
import { planItemKey } from '@/lib/orders/paymentPlan'
import {
  PLAN_PROBLEM_TEXT,
  computePaymentPlan,
  formatPaise,
  inputFromData,
  parsePlanData,
  parseTypedNumber,
  plannedLinesPayload,
  plannedLotOf,
  plannedQuantities,
  type PlanData,
} from '@/lib/orders/paymentPlan'
import { buildPaymentPlanSheet, paymentPlanFileName, planSummaryRows } from '@/lib/orders/paymentPlanSheet'
import { downloadPaymentPlanXlsx } from '@/lib/orders/paymentPlanXlsx'

type Edit = {
  planned: Record<string, string>
  plannedOn: string
  pending: string
  billing: string
  advanceAccount: string
  advanceCash: string
  note: string
}

const qtyText = (n: number | undefined) => (n && n > 0 ? String(n) : '')

function editFromData(data: PlanData): Edit {
  const planned = plannedQuantities(data.lots)
  return {
    planned: Object.fromEntries(Object.entries(planned).map(([k, v]) => [k, qtyText(v)])),
    plannedOn: plannedLotOf(data.lots)?.plannedOn ?? '',
    pending: String(data.pendingPercent),
    billing: data.billingPercentOverride === null ? '' : String(data.billingPercentOverride),
    advanceAccount: data.advanceAccountOverride === null ? '' : String(data.advanceAccountOverride),
    advanceCash: data.advanceCashOverride === null ? '' : String(data.advanceCashOverride),
    note: data.note ?? '',
  }
}

function describeError(message: string): string {
  if (/PAYMENT_PLAN_FORBIDDEN/.test(message)) return 'You do not have access to change this Payment plan.'
  if (/PAYMENT_PLAN_ORDER_CANCELLED/.test(message)) return 'This Order is cancelled, so its Payment plan can no longer change.'
  if (/DISPATCH_QUANTITY_EXCEEDS_ORDER/.test(message)) return 'A line has more sent or planned than was ordered. Lower the quantity.'
  if (/DISPATCH_QUANTITY_INVALID/.test(message)) return 'Quantities must be above zero with at most two decimals.'
  if (/DISPATCH_LINE_NOT_ON_PI/.test(message)) return 'A line in this lot is no longer on the PI. Reload the page.'
  if (/DISPATCH_NO_PLANNED_LOT/.test(message)) return 'There is no planned lot to mark as dispatched. Enter quantities and save first.'
  if (/DISPATCH_DATE_IN_FUTURE/.test(message)) return 'The dispatch date cannot be in the future.'
  if (/DISPATCH_DATE_REQUIRED/.test(message)) return 'Choose the dispatch date.'
  if (/DISPATCH_REASON_REQUIRED/.test(message)) return 'Give a reason of at least 10 characters.'
  if (/PAYMENT_PLAN_PERCENT_INVALID/.test(message)) return 'Percentages must be between 0 and 100 with at most two decimals.'
  if (/PAYMENT_PLAN_ADVANCE_INVALID/.test(message)) return 'The advance must be an amount with at most two decimals.'
  return 'That could not be saved. Please try again.'
}

/** A typed figure changed: blank vs filled, or a different number. */
const numberChanged = (a: string, b: string) =>
  (a.trim() === '') !== (b.trim() === '') || (a.trim() !== '' && Number(a) !== Number(b))

const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
const showDate = (iso: string | null) => {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  return y && m && d ? `${d}-${m}-${y}` : iso
}

const PICTURE_URL_TTL_SECONDS = 3600

/** One representative picture URL per PI line, keyed like the plan's lines. Silent on any failure. */
function useProductPictures(
  supabase: ReturnType<typeof createClient>, submissionId: string | null, enabled: boolean,
): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!enabled || !submissionId) return
    let live = true
    void (async () => {
      const [items, images] = await Promise.all([
        supabase.from('order_submission_items').select('id, item_sequence').eq('submission_id', submissionId),
        supabase.from('order_submission_item_images').select('item_id, role, position, storage_path')
          .eq('submission_id', submissionId).eq('role', 'representative').order('position', { ascending: true }),
      ])
      if (!live || items.error || images.error) return
      const keyOf = new Map<string, string>()
      for (const i of (items.data ?? []) as { id: string; item_sequence: string | null }[]) {
        keyOf.set(i.id, planItemKey(i.item_sequence, i.id))
      }
      const pathByKey = new Map<string, string>()
      for (const m of (images.data ?? []) as { item_id: string; storage_path: string }[]) {
        const key = keyOf.get(m.item_id)
        if (key && !pathByKey.has(key)) pathByKey.set(key, m.storage_path)
      }
      const paths = [...pathByKey.values()]
      if (paths.length === 0) return
      const signed = await supabase.storage.from(ORDER_FILES_BUCKET).createSignedUrls(paths, PICTURE_URL_TTL_SECONDS)
      if (!live || signed.error) return
      const urlByPath = new Map<string, string>()
      for (const s of signed.data ?? []) if (s.path && s.signedUrl) urlByPath.set(s.path, s.signedUrl)
      const out: Record<string, string> = {}
      for (const [key, path] of pathByKey) {
        const url = urlByPath.get(path)
        if (url) out[key] = url
      }
      setUrls(out)
    })()
    return () => { live = false }
  }, [supabase, submissionId, enabled])
  return urls
}

/** A BDPI's pictures are private files signed by the app's server after it asks the database. */
function useBdpiPictures(bdpiId: string | null): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!bdpiId) return
    let live = true
    void fetch(`/api/orders/bdpi/${bdpiId}/pictures`)
      .then(r => (r.ok ? r.json() : { urls: {} }))
      .then((body: { urls?: Record<string, string> }) => { if (live) setUrls(body.urls ?? {}) })
      .catch(() => {})
    return () => { live = false }
  }, [bdpiId])
  return urls
}

// The same plan runs for a Confirmed Order and for an OLD order kept as a BDPI
// (20270503000000). Only the doors differ; their answers have the same shape.
const ORDER_DOORS = {
  read: 'order_payment_plan_read', save: 'order_payment_plan_save',
  lotSave: 'order_dispatch_lot_save', markDispatched: 'order_dispatch_lot_mark_dispatched', key: 'p_order_id',
} as const
const BDPI_DOORS = {
  read: 'bdpi_payment_plan_read', save: 'bdpi_payment_plan_save',
  lotSave: 'bdpi_dispatch_lot_save', markDispatched: 'bdpi_dispatch_lot_mark_dispatched', key: 'p_bdpi_id',
} as const

export default function OrderPaymentPlan({
  orderId, submissionId, bdpiId = null, canEdit, isAdmin,
}: { orderId: string; submissionId: string | null; bdpiId?: string | null; canEdit: boolean; isAdmin: boolean }) {
  const supabase = useMemo(() => createClient(), [])
  const doors = bdpiId ? BDPI_DOORS : ORDER_DOORS
  const targetId = bdpiId ?? orderId
  const orderPictures = useProductPictures(supabase, submissionId, !bdpiId)
  const bdpiPictures = useBdpiPictures(bdpiId)
  const pictures = bdpiId ? bdpiPictures : orderPictures
  const [data, setData] = useState<PlanData | null | undefined>(undefined)   // undefined = loading
  const [unreadable, setUnreadable] = useState(false)
  const [edit, setEdit] = useState<Edit | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [dispatchOn, setDispatchOn] = useState(todayIso())
  // The dispatched lot an administrator is changing.
  const [fixing, setFixing] = useState<string | null>(null)
  const [fixQty, setFixQty] = useState<Record<string, string>>({})
  const [fixDate, setFixDate] = useState('')
  const [fixReason, setFixReason] = useState('')

  const fetchPlan = useCallback(async () => {
    const { data: raw, error } = await supabase.rpc(doors.read, { [doors.key]: targetId })
    if (error) return { ok: false as const }
    return { ok: true as const, plan: parsePlanData(raw) }
  }, [supabase, doors, targetId])

  const apply = useCallback((res: Awaited<ReturnType<typeof fetchPlan>>) => {
    if (!res.ok) { setUnreadable(true); return }
    setUnreadable(false)
    setData(res.plan)
    if (res.plan) setEdit(editFromData(res.plan))
  }, [])

  useEffect(() => {
    let live = true
    void fetchPlan().then(res => { if (live) apply(res) })
    return () => { live = false }
  }, [fetchPlan, apply])

  // ── Live figures from what is typed ──
  const parsed = useMemo(() => {
    if (!data || !edit) return null
    let invalid = false
    const planned: Record<string, number> = {}
    for (const item of data.items) {
      const n = parseTypedNumber(edit.planned[item.itemSequence] ?? '')
      if (n !== null && Number.isNaN(n)) invalid = true
      else if (n !== null && n > 0) planned[item.itemSequence] = n
    }
    const pending = parseTypedNumber(edit.pending)
    const billing = parseTypedNumber(edit.billing)
    const advanceAccount = parseTypedNumber(edit.advanceAccount)
    const advanceCash = parseTypedNumber(edit.advanceCash)
    if (pending === null || Number.isNaN(pending) || pending > 100) invalid = true
    if (billing !== null && (Number.isNaN(billing) || billing > 100)) invalid = true
    if (advanceAccount !== null && Number.isNaN(advanceAccount)) invalid = true
    if (advanceCash !== null && Number.isNaN(advanceCash)) invalid = true
    const safe = (n: number | null) => (n === null || Number.isNaN(n) ? null : n)
    const result = computePaymentPlan(inputFromData(data, {
      planned,
      pendingPercent: safe(pending) ?? data.pendingPercent,
      billingPercentOverride: safe(billing),
      advanceAccountOverride: safe(advanceAccount),
      advanceCashOverride: safe(advanceCash),
    }))
    return {
      planned, pending: safe(pending), billing: safe(billing),
      advanceAccount: safe(advanceAccount), advanceCash: safe(advanceCash), invalid, result,
    }
  }, [data, edit])

  const dirty = useMemo(() => {
    if (!data || !edit || !parsed) return false
    const saved = editFromData(data)
    const norm = (p: Record<string, string>) =>
      JSON.stringify(Object.entries(p).filter(([, v]) => v.trim() !== '' && Number(v) > 0).sort(([a], [b]) => a.localeCompare(b)))
    return norm(saved.planned) !== norm(edit.planned)
      || saved.plannedOn !== edit.plannedOn
      || Number(saved.pending) !== Number(edit.pending)
      || (saved.billing.trim() === '') !== (edit.billing.trim() === '') || (saved.billing !== '' && Number(saved.billing) !== Number(edit.billing))
      || numberChanged(saved.advanceAccount, edit.advanceAccount)
      || numberChanged(saved.advanceCash, edit.advanceCash)
      || saved.note.trim() !== edit.note.trim()
  }, [data, edit, parsed])

  if (unreadable) {
    return <p className="opp-warn" role="alert">The Payment plan could not be opened. You may not have access, or the page needs a reload.</p>
  }
  if (data === undefined) return <p className="opp-note" role="status">Opening the Payment plan…</p>
  if (data === null || !edit || !parsed) {
    return <p className="opp-note" role="status">This Order has no PI to plan against.</p>
  }

  const { result } = parsed
  const set = (patch: Partial<Edit>) => { setProblem(null); setEdit({ ...edit, ...patch }) }
  const setQty = (seq: string, value: string) => set({ planned: { ...edit.planned, [seq]: value } })

  const reload = async () => apply(await fetchPlan())

  const save = async () => {
    if (parsed.invalid || !result.ok) { setProblem('Fix the highlighted figures first.'); return }
    setBusy(true); setProblem(null)
    const a = await supabase.rpc(doors.save, {
      [doors.key]: targetId,
      p_pending_percent: parsed.pending,
      p_billing_percent: parsed.billing,
      p_advance_account: parsed.advanceAccount,
      p_advance_cash: parsed.advanceCash,
      p_note: edit.note.trim() === '' ? null : edit.note.trim(),
    })
    if (a.error) { setProblem(describeError(a.error.message)); setBusy(false); return }
    const b = await supabase.rpc(doors.lotSave, {
      [doors.key]: targetId,
      p_lines: plannedLinesPayload(parsed.planned),
      p_planned_on: edit.plannedOn === '' ? null : edit.plannedOn,
    })
    if (b.error) setProblem(describeError(b.error.message))
    await reload()
    setBusy(false)
  }

  const markDispatched = async () => {
    setBusy(true); setProblem(null)
    const { error } = await supabase.rpc(doors.markDispatched, {
      [doors.key]: targetId, p_dispatched_on: dispatchOn,
    })
    if (error) setProblem(describeError(error.message))
    await reload()
    setBusy(false)
  }

  const openFix = (lotId: string) => {
    const lot = data.lots.find(l => l.id === lotId)
    if (!lot) return
    setFixing(lotId)
    setFixQty(Object.fromEntries(lot.lines.map(l => [l.itemSequence, String(l.quantity)])))
    setFixDate(lot.dispatchedOn ?? '')
    setFixReason('')
    setProblem(null)
  }

  const applyFix = async (lotKey: string, deleting: boolean) => {
    const lotId = lotKey
    if (!data.lots.some(l => l.id === lotId)) return
    const lines: { item_sequence: string; quantity: number }[] = []
    if (!deleting) {
      for (const item of data.items) {
        const n = parseTypedNumber(fixQty[item.itemSequence] ?? '')
        if (n !== null && Number.isNaN(n)) { setProblem('Quantities must be numbers with at most two decimals.'); return }
        if (n !== null && n > 0) lines.push({ item_sequence: item.itemSequence, quantity: n })
      }
      if (lines.length === 0) { setProblem('Enter at least one quantity, or delete the lot.'); return }
    }
    setBusy(true); setProblem(null)
    const { error } = await supabase.rpc('order_dispatch_lot_admin_change', {
      p_lot_id: lotId, p_reason: fixReason, p_lines: lines, p_dispatched_on: fixDate === '' ? null : fixDate,
    })
    if (error) setProblem(describeError(error.message))
    else setFixing(null)
    await reload()
    setBusy(false)
  }

  const sheetFor = () => buildPaymentPlanSheet(data, result, {
    lotLines: parsed.planned,
    generatedOn: showDate(todayIso()),
    plannedOn: edit.plannedOn === '' ? null : edit.plannedOn,
  })
  const downloadExcel = async () => {
    setProblem(null)
    try { await downloadPaymentPlanXlsx(sheetFor(), paymentPlanFileName(data.displayNumber, 'xlsx')) }
    catch { setProblem('The Excel file could not be made. Please try again.') }
  }

  const planned = plannedLotOf(data.lots)
  const dispatchedLots = data.lots.filter(l => l.status === 'dispatched')
  const hasPlanned = Object.keys(parsed.planned).length > 0
  const percentBad = (text: string, allowBlank: boolean) => {
    const n = parseTypedNumber(text)
    return allowBlank && n === null ? false : n === null || Number.isNaN(n) || n > 100
  }
  const detailsOf = new Map(data.items.map(i => [i.itemSequence, i.details ?? []]))
  const typedBad = (text: string) => { const n = parseTypedNumber(text); return n !== null && Number.isNaN(n) }
  const rateText = `${(result.gstRate * 100).toFixed(2).replace(/\.?0+$/, '')}%`
  const downloadsOff = dirty || busy

  return (
    <section className="opp" aria-label="Payment plan" id="order-payment-plan">
      <header className="opp-head">
        <div>
          <h2 className="opp-title">Payment plan</h2>
          <p className="opp-sub">What the client must already have paid before the next dispatch.</p>
        </div>
        <div className="opp-downloads">
          <button type="button" className="boe-btn boe-btn-ghost" disabled={downloadsOff}
            title={dirty ? 'Save your changes first' : undefined} onClick={() => void downloadExcel()}>
            Excel
          </button>
          <a className={`boe-btn boe-btn-ghost${downloadsOff ? ' opp-disabled' : ''}`}
            aria-disabled={downloadsOff} title={dirty ? 'Save your changes first' : undefined}
            href={downloadsOff ? undefined : bdpiId ? `/api/orders/bdpi/${bdpiId}/pdf` : `/api/orders/${orderId}/payment-plan/pdf`}>
            PDF
          </a>
        </div>
      </header>

      {data.piDiffersFromOrder && (
        <p className="opp-note" role="status">The Order value was amended after its PI. This sheet uses the PI&apos;s totals.</p>
      )}
      {result.problems.map(p => <p key={p} className="opp-warn" role="alert">{PLAN_PROBLEM_TEXT[p]}</p>)}

      <div className="opp-inputs">
        <label className="opp-field">
          <span>Pending goods to pay in advance (%)</span>
          <input className={`boe-input${percentBad(edit.pending, false) ? ' opp-bad' : ''}`} inputMode="decimal"
            value={edit.pending} disabled={!canEdit || busy} onChange={e => set({ pending: e.target.value })} />
        </label>
        <label className="opp-field">
          <span>Billing (%) <em>{data.piBillingPercent === null ? 'PI has none' : `PI says ${data.piBillingPercent}%`}</em></span>
          <input className={`boe-input${percentBad(edit.billing, true) ? ' opp-bad' : ''}`} inputMode="decimal"
            placeholder={data.piBillingPercent === null ? 'Type the billing %' : `${data.piBillingPercent}`}
            value={edit.billing} disabled={!canEdit || busy} onChange={e => set({ billing: e.target.value })} />
        </label>
        <label className="opp-field">
          <span>Received in account (₹) <em>Confirmed: {formatPaise(Math.round(data.financeAccountVerified * 100))}</em></span>
          <input className={`boe-input${typedBad(edit.advanceAccount) ? ' opp-bad' : ''}`} inputMode="decimal"
            placeholder="Blank = use confirmed payments"
            value={edit.advanceAccount} disabled={!canEdit || busy} onChange={e => set({ advanceAccount: e.target.value })} />
        </label>
        <label className="opp-field">
          <span>Received in cash (₹) <em>Confirmed: {formatPaise(Math.round(data.financeCashVerified * 100))}</em></span>
          <input className={`boe-input${typedBad(edit.advanceCash) ? ' opp-bad' : ''}`} inputMode="decimal"
            placeholder="Blank = use confirmed payments"
            value={edit.advanceCash} disabled={!canEdit || busy} onChange={e => set({ advanceCash: e.target.value })} />
        </label>
      </div>

      <div className="opp-scroll">
        <table className="opp-table">
          <thead>
            <tr>
              <th>Line</th><th>Picture</th><th>Product</th>
              <th className="opp-num">Rate</th>
              <th className="opp-num">Ordered</th>
              <th className="opp-num">Sent earlier</th>
              <th className="opp-num opp-lot">This lot</th>
              <th className="opp-num">Still to come</th>
              <th className="opp-num">This lot value</th>
            </tr>
          </thead>
          <tbody>
            {result.lines.map(l => {
              const text = edit.planned[l.itemSequence] ?? ''
              const n = parseTypedNumber(text)
              const bad = (n !== null && Number.isNaN(n)) || l.remaining < 0
              return (
                <tr key={l.itemSequence}>
                  <td>{l.itemSequence}</td>
                  <td className="opp-pic">
                    {pictures[l.itemSequence]
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={pictures[l.itemSequence]} alt={l.productName ?? `Line ${l.itemSequence}`} className="opp-thumb" loading="lazy" />
                      : <span className="opp-thumb opp-thumb--none">No image</span>}
                  </td>
                  <td className="opp-name">
                    {l.productName ?? '—'}
                    {(detailsOf.get(l.itemSequence) ?? []).map(d => <span key={d} className="opp-detail">{d}</span>)}
                  </td>
                  <td className="opp-num">{formatPaise(Math.round(l.rate * 100))}</td>
                  <td className="opp-num">{l.ordered}</td>
                  <td className="opp-num">{l.previouslyDispatched || '—'}</td>
                  <td className="opp-num opp-lot">
                    <input className={`boe-input opp-qty${bad ? ' opp-bad' : ''}`} inputMode="decimal"
                      aria-label={`Quantity of line ${l.itemSequence} in this lot`}
                      value={text} disabled={!canEdit || busy} onChange={e => setQty(l.itemSequence, e.target.value)} />
                  </td>
                  <td className={`opp-num${l.remaining < 0 ? ' opp-neg' : ''}`}>{l.remaining}</td>
                  <td className="opp-num">{l.plannedPaise > 0 ? formatPaise(l.plannedPaise) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={8}>Goods ordered {formatPaise(result.orderedValuePaise)} · leaving ({result.dispatchSharePercent.toFixed(2)}% with earlier lots)</td>
              <td className="opp-num">{formatPaise(result.plannedPaise)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="opp-scroll">
        <table className="opp-table opp-sum-table">
          <thead>
            <tr><th></th><th className="opp-num">Account</th><th className="opp-num">Cash</th><th className="opp-num">Total</th></tr>
          </thead>
          <tbody>
            {planSummaryRows(result).map(r => (
              <tr key={r.label} className={r.kind === 'line' ? undefined : `opp-sum-${r.kind}`}>
                <td>{r.label}</td>
                {[r.account, r.cash, r.total].map((v, i) => (
                  <td key={i} className={`opp-num${v !== null && v < 0 ? ' opp-extra' : ''}`}>
                    {v === null ? '—' : r.kind === 'balance' && v < 0 ? `${formatPaise(-v)} paid extra` : formatPaise(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="opp-note">
        Account = payments into the company bank account (HDFC). Cash = all other payments (PNB, Paytm, Canara).
        The billed part ({result.billingPercent === null ? 'billing % not set' : `${result.billingPercent}%`}) and all GST ({rateText}) are paid in account; the rest in cash.
        {(result.split.awaiting.account > 0 || result.split.awaiting.cash > 0) &&
          ` Still being checked in Finance, not counted yet: ${formatPaise(result.split.awaiting.account)} in account, ${formatPaise(result.split.awaiting.cash)} in cash.`}
      </p>
      {result.billingMissing && <p className="opp-warn" role="status">No billing % on the PI or here, so GST is not included yet.</p>}

      {canEdit && (
        <div className="opp-actions">
          <label className="opp-field opp-grow">
            <span>Note (optional)</span>
            <input className="boe-input" maxLength={1000} value={edit.note} disabled={busy}
              onChange={e => set({ note: e.target.value })} />
          </label>
          <label className="opp-field">
            <span>Planned dispatch date</span>
            <input className="boe-input" type="date" value={edit.plannedOn} disabled={busy}
              onChange={e => set({ plannedOn: e.target.value })} />
          </label>
          <button type="button" className="boe-btn boe-btn-primary" disabled={busy || !dirty || parsed.invalid}
            onClick={() => void save()}>
            {busy ? 'Saving…' : dirty ? 'Save plan' : 'Saved'}
          </button>
        </div>
      )}

      {canEdit && planned && !dirty && hasPlanned && (
        <div className="opp-actions opp-mark">
          <label className="opp-field">
            <span>Dispatched on</span>
            <input className="boe-input" type="date" value={dispatchOn} max={todayIso()} disabled={busy}
              onChange={e => setDispatchOn(e.target.value)} />
          </label>
          <button type="button" className="boe-btn boe-btn-ghost" disabled={busy || dispatchOn === ''}
            onClick={() => void markDispatched()}>
            Mark this lot as dispatched
          </button>
          <span className="opp-hint">It then counts as sent and the next lot starts empty.</span>
        </div>
      )}
      {problem && <p className="opp-warn" role="alert">{problem}</p>}

      {dispatchedLots.length > 0 && (
        <div className="opp-history">
          <h3 className="opp-h3">Dispatched lots</h3>
          <ul className="opp-lots">
            {dispatchedLots.map(l => {
              const key = l.id
              const open = fixing === key
              return (
                <li key={key} className="opp-lot-row">
                  <div className="opp-lot-line">
                    <strong>Lot {l.lotNo}</strong>
                    <span>{showDate(l.dispatchedOn)}</span>
                    <span className="opp-lot-items">
                      {l.lines.map(x => `${x.itemSequence}: ${x.quantity}`).join(' · ')}
                    </span>
                    {isAdmin && !busy && (
                      <button type="button" className="opp-link" onClick={() => (open ? setFixing(null) : openFix(key))}>
                        {open ? 'Close' : 'Change'}
                      </button>
                    )}
                  </div>
                  {isAdmin && open && (
                    <div className="opp-fix">
                      <div className="opp-fix-grid">
                        {data.items.map(item => (
                          <label key={item.itemSequence} className="opp-field">
                            <span>Line {item.itemSequence}</span>
                            <input className="boe-input opp-qty" inputMode="decimal" value={fixQty[item.itemSequence] ?? ''}
                              onChange={e => setFixQty({ ...fixQty, [item.itemSequence]: e.target.value })} />
                          </label>
                        ))}
                      </div>
                      <label className="opp-field">
                        <span>Dispatched on</span>
                        <input className="boe-input" type="date" value={fixDate} max={todayIso()} onChange={e => setFixDate(e.target.value)} />
                      </label>
                      <label className="opp-field">
                        <span>Reason (kept on record, at least 10 characters)</span>
                        <input className="boe-input" maxLength={500} value={fixReason} onChange={e => setFixReason(e.target.value)} />
                      </label>
                      <div className="opp-actions">
                        <button type="button" className="boe-btn boe-btn-primary" disabled={busy || fixReason.trim().length < 10}
                          onClick={() => void applyFix(key, false)}>Save change</button>
                        <button type="button" className="boe-btn boe-btn-ghost" disabled={busy || fixReason.trim().length < 10}
                          onClick={() => { if (window.confirm(`Delete lot ${l.lotNo}? Its goods count as not sent.`)) void applyFix(key, true) }}>
                          Delete lot
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}
