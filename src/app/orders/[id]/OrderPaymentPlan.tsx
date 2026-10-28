'use client'

// ── PAYMENT PLAN, on the Confirmed Order page ────────────────────────────────
//
// How much more the client must pay before a dispatch: the goods leaving in
// full (with their share of every charge, and GST on the billed part), plus a
// chosen share of the goods still to come. Every figure is computed live by
// computePaymentPlan (lib/orders/paymentPlan.ts); this file only draws it and
// saves the inputs.
//
// Self-loading on purpose: the Order page's startup reads are counted and
// pinned (orderStartupShape.test.ts), and this is a section only the people
// granted view_payment_plan ever open. One read (order_payment_plan_read), and
// writes only through the order_payment_plan_* / order_dispatch_lot_* functions
// of 20270428000000, which re-derive who may. `canEdit` and `isAdmin` decide
// only which controls are drawn.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
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
import { buildPaymentPlanSheet, paymentPlanFileName } from '@/lib/orders/paymentPlanSheet'
import { downloadPaymentPlanXlsx } from '@/lib/orders/paymentPlanXlsx'

type Edit = {
  planned: Record<string, string>
  plannedOn: string
  pending: string
  billing: string
  advance: string
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
    advance: data.advanceOverride === null ? '' : String(data.advanceOverride),
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

const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
const showDate = (iso: string | null) => {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  return y && m && d ? `${d}-${m}-${y}` : iso
}

export default function OrderPaymentPlan({
  orderId, canEdit, isAdmin,
}: { orderId: string; canEdit: boolean; isAdmin: boolean }) {
  const supabase = useMemo(() => createClient(), [])
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
    const { data: raw, error } = await supabase.rpc('order_payment_plan_read', { p_order_id: orderId })
    if (error) return { ok: false as const }
    return { ok: true as const, plan: parsePlanData(raw) }
  }, [supabase, orderId])

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
    const advance = parseTypedNumber(edit.advance)
    if (pending === null || Number.isNaN(pending) || pending > 100) invalid = true
    if (billing !== null && (Number.isNaN(billing) || billing > 100)) invalid = true
    if (advance !== null && Number.isNaN(advance)) invalid = true
    const safe = (n: number | null) => (n === null || Number.isNaN(n) ? null : n)
    const result = computePaymentPlan(inputFromData(data, {
      planned,
      pendingPercent: safe(pending) ?? data.pendingPercent,
      billingPercentOverride: safe(billing),
      advanceOverride: safe(advance),
    }))
    return { planned, pending: safe(pending), billing: safe(billing), advance: safe(advance), invalid, result }
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
      || (saved.advance.trim() === '') !== (edit.advance.trim() === '') || (saved.advance !== '' && Number(saved.advance) !== Number(edit.advance))
      || saved.note.trim() !== edit.note.trim()
  }, [data, edit, parsed])

  if (unreadable) return null
  if (data === undefined) return null
  // No PI behind this Order: nothing to plan against, so nothing to draw.
  if (data === null || !edit || !parsed) return null

  const { result } = parsed
  const set = (patch: Partial<Edit>) => { setProblem(null); setEdit({ ...edit, ...patch }) }
  const setQty = (seq: string, value: string) => set({ planned: { ...edit.planned, [seq]: value } })

  const reload = async () => apply(await fetchPlan())

  const save = async () => {
    if (parsed.invalid || !result.ok) { setProblem('Fix the highlighted figures first.'); return }
    setBusy(true); setProblem(null)
    const a = await supabase.rpc('order_payment_plan_save', {
      p_order_id: orderId,
      p_pending_percent: parsed.pending,
      p_billing_percent: parsed.billing,
      p_advance_override: parsed.advance,
      p_note: edit.note.trim() === '' ? null : edit.note.trim(),
    })
    if (a.error) { setProblem(describeError(a.error.message)); setBusy(false); return }
    const b = await supabase.rpc('order_dispatch_lot_save', {
      p_order_id: orderId,
      p_lines: plannedLinesPayload(parsed.planned),
      p_planned_on: edit.plannedOn === '' ? null : edit.plannedOn,
    })
    if (b.error) setProblem(describeError(b.error.message))
    await reload()
    setBusy(false)
  }

  const markDispatched = async () => {
    setBusy(true); setProblem(null)
    const { error } = await supabase.rpc('order_dispatch_lot_mark_dispatched', {
      p_order_id: orderId, p_dispatched_on: dispatchOn,
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
  const showToCollect = result.toCollectPaise >= 0
  const percentBad = (text: string, allowBlank: boolean) => {
    const n = parseTypedNumber(text)
    return allowBlank && n === null ? false : n === null || Number.isNaN(n) || n > 100
  }
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
            href={downloadsOff ? undefined : `/api/orders/${orderId}/payment-plan/pdf`}>
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
          <span>Advance received (₹)
            <em>{data.financePaymentCount > 0
              ? ` Finance: ${formatPaise(result.financeVerifiedPaise)} verified${result.financeAwaitingPaise > 0 ? `, ${formatPaise(result.financeAwaitingPaise)} awaiting` : ''}`
              : ' Nothing found in Finance'}</em>
          </span>
          <input className={`boe-input${(() => { const n = parseTypedNumber(edit.advance); return n !== null && Number.isNaN(n) ? ' opp-bad' : '' })()}`}
            inputMode="decimal"
            placeholder={data.financePaymentCount > 0 ? 'Using Finance’s verified figure' : 'Type the advance received'}
            value={edit.advance} disabled={!canEdit || busy} onChange={e => set({ advance: e.target.value })} />
        </label>
      </div>

      <div className="opp-scroll">
        <table className="opp-table">
          <thead>
            <tr>
              <th>Line</th><th>Product</th>
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
                  <td className="opp-name">{l.productName ?? '—'}</td>
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
              <td colSpan={7}>Goods ordered {formatPaise(result.orderedValuePaise)} · leaving ({result.dispatchSharePercent.toFixed(2)}% with earlier lots)</td>
              <td className="opp-num">{formatPaise(result.plannedPaise)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <dl className="opp-sum">
        <div><dt>Total before GST on the PI (goods and all charges)</dt><dd>{formatPaise(result.totalBeforeGstPaise ?? 0)}</dd></div>
        <div><dt>Goods leaving, with their share of charges (paid in full)</dt><dd>{formatPaise(result.dispatchAmountPaise)}</dd></div>
        <div><dt>GST on the billed part ({result.billingPercent === null ? 'billing % not set' : `${result.billingPercent}% × ${rateText}`})</dt><dd>{formatPaise(result.gstOnDispatchPaise)}</dd></div>
        <div><dt>{result.pendingPercent}% of goods still to come, charges included (no GST)</dt><dd>{formatPaise(result.pendingShareAmountPaise)}</dd></div>
        <div className="opp-strong"><dt>Total required</dt><dd>{formatPaise(result.requiredPaise)}</dd></div>
        <div>
          <dt>Advance received ({result.advanceSource === 'typed' ? 'typed' : result.advanceSource === 'finance' ? 'from Finance, verified' : 'none yet'})</dt>
          <dd>{formatPaise(result.advancePaise)}</dd>
        </div>
        <div className={`opp-strong ${showToCollect ? 'opp-due' : 'opp-ok'}`}>
          <dt>{showToCollect ? 'Still to collect from the client' : 'Surplus already paid'}</dt>
          <dd>{formatPaise(Math.abs(result.toCollectPaise))}</dd>
        </div>
      </dl>
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
