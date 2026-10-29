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
//
// Layout B (owner, 2026-10-30): the answer first (goods sent + advance −
// already received = balance, bank and cash under each), then Plan settings
// with help that stays visible, the goods in this lot (11 columns, rates under
// the name), the working folded away, and Save in a bar that stays at the
// bottom of the screen. Excel and PDF keep the full sheet unchanged.

import { Fragment, useCallback, useEffect, useId, useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { ORDER_FILES_BUCKET } from '@/lib/orders/draftsView'
import { planItemKey } from '@/lib/orders/paymentPlan'
import {
  PLAN_PROBLEM_TEXT,
  computePaymentPlan,
  inputFromData,
  parsePlanData,
  parseTypedNumber,
  plannedLinesPayload,
  plannedLotOf,
  plannedQuantities,
  type PlanData,
} from '@/lib/orders/paymentPlan'
import {
  BANK_CASH_NOTE, BILLING_MISSING_NOTE, buildPaymentPlanSheet, paymentPlanFileName,
} from '@/lib/orders/paymentPlanSheet'
import {
  ADVANCE_HELP, AMOUNT_PROBLEM, PERCENT_PROBLEM, balanceText, billingHelp, lineRatesText, lotPiecesText,
  lotQuantityProblem, moneyText, receivedHelp,
} from '@/lib/orders/paymentPlanScreen'
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

const OP_WORD: Record<string, string> = { '+': 'plus', '−': 'minus', '=': 'equals' }

/** An empty amount: nothing of this line is in the lot yet. */
const Dash = () => <span className="opp-dash">—</span>

/** One Plan settings box: a label above, help that stays visible below, and the problem in words. */
function SettingField({ id, label, help, problem, value, onChange }: {
  id: string; label: string; help: string; problem: string | null; value: string; onChange: (v: string) => void
}) {
  return (
    <div className="opp-setting">
      <label htmlFor={id} className="opp-setting-label">{label}</label>
      <input id={id} className={`boe-input${problem ? ' opp-bad' : ''}`} inputMode="decimal" value={value}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${id}-help ${id}-problem` : `${id}-help`}
        onChange={e => onChange(e.target.value)} />
      <span id={`${id}-help`} className="opp-help">{help}</span>
      {problem && (
        <span id={`${id}-problem`} className="opp-field-problem">
          <AlertTriangle aria-hidden="true" />{problem}
        </span>
      )}
    </div>
  )
}

export default function OrderPaymentPlan({
  orderId, submissionId, bdpiId = null, canEdit, isAdmin,
}: { orderId: string; submissionId: string | null; bdpiId?: string | null; canEdit: boolean; isAdmin: boolean }) {
  const supabase = useMemo(() => createClient(), [])
  const uid = useId()
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
  const rs = moneyText
  const qty = (n: number) => (Math.round(n * 1000) / 1000).toLocaleString('en-IN')
  const sheet = sheetFor()
  const typedBad = (text: string) => { const n = parseTypedNumber(text); return n !== null && Number.isNaN(n) }
  const downloadsOff = dirty || busy
  const lotNo = planned?.lotNo ?? dispatchedLots.length + 1
  // The sum at the top reads the same rows the Excel and PDF draw: Bank, Cash, Total.
  const [bankRow, cashRow] = sheet.payRows
  const totalRow = sheet.payRows.find(r => r.total) ?? sheet.payRows[sheet.payRows.length - 1]
  const screenNotes = sheet.notes.filter(n => n !== BANK_CASH_NOTE && n !== BILLING_MISSING_NOTE)
  const sum = (pick: (l: (typeof result.lines)[number]) => number) => result.lines.reduce((s, l) => s + pick(l), 0)
  const lotTotal = result.lot.items + result.lot.packing + result.lot.fabric
  const saveHintId = `${uid}-save-hint`

  return (
    <section className="opp" aria-label="Payment plan" id="order-payment-plan">
      <header className="opp-head">
        <ul className="opp-chips" aria-label="About this plan">
          {data.kind === 'order' && data.clientName && <li>{data.clientName}</li>}
          <li>Lot {lotNo} · {lotPiecesText(result.lines)}</li>
          <li>{dispatchedLots.length === 0 ? 'Nothing sent yet'
            : `${dispatchedLots.length} ${dispatchedLots.length === 1 ? 'lot' : 'lots'} sent`}</li>
        </ul>
        <div className="opp-downloads">
          {dirty && <span id={saveHintId} className="opp-hint">Save first to download</span>}
          <button type="button" className="boe-btn boe-btn-ghost" disabled={downloadsOff}
            aria-describedby={dirty ? saveHintId : undefined} onClick={() => void downloadExcel()}>
            Excel
          </button>
          <a className={`boe-btn boe-btn-ghost${downloadsOff ? ' opp-disabled' : ''}`}
            aria-disabled={downloadsOff} aria-describedby={dirty ? saveHintId : undefined}
            href={downloadsOff ? undefined : bdpiId ? `/api/orders/bdpi/${bdpiId}/pdf` : `/api/orders/${orderId}/payment-plan/pdf`}>
            PDF
          </a>
        </div>
      </header>

      {/* ── 1. The answer: goods sent + advance − already received = balance ── */}
      <section className="opp-total" aria-labelledby={`${uid}-total`}>
        <h2 className="opp-section-title" id={`${uid}-total`}>To pay before this dispatch</h2>
        <div className="opp-tiles">
          {sheet.payColumns.map((c, i) => {
            const money = c.balance ? balanceText : rs
            return (
              <Fragment key={c.title}>
                {i > 0 && c.op && (
                  <span className="opp-tile-op"><span aria-hidden="true">{c.op}</span><span className="opp-sr">{OP_WORD[c.op]}</span></span>
                )}
                <div className={`opp-tile${c.balance ? ' opp-tile-bal' : ''}`}>
                  <span className="opp-tile-k">{c.balance ? 'Balance to pay now' : c.title}</span>
                  <span className="opp-tile-v">{money(totalRow.cells[i])}</span>
                  {!c.balance && <span className="opp-tile-s">{c.sub}</span>}
                  <span className="opp-tile-s">Bank {money(bankRow.cells[i])} · Cash {money(cashRow.cells[i])}</span>
                </div>
              </Fragment>
            )
          })}
        </div>
        {screenNotes.map(n => <p key={n} className="opp-block-note">{n}</p>)}
      </section>

      {result.billingMissing && (
        <p className="opp-attention" role="status">
          <AlertTriangle aria-hidden="true" />
          <span>
            <strong>The PI has no billing %.</strong> Everything counts as cash and no GST is added.
            {canEdit ? ' If part of this order is billed, type the billing % in Plan settings.' : ' Someone who can edit this plan can set it.'}
          </span>
        </p>
      )}
      {result.problems.map(p => <p key={p} className="opp-warn" role="alert">{PLAN_PROBLEM_TEXT[p]}</p>)}

      {/* ── 2. Plan settings: a label above each box, help that stays visible below ── */}
      <fieldset className="opp-settings" disabled={!canEdit || busy}>
        <legend className="opp-section-title">Plan settings</legend>
        <div className="opp-settings-grid">
          <SettingField id={`${uid}-advance`} label="Advance on goods still to come (%)" help={ADVANCE_HELP}
            problem={percentBad(edit.pending, false) ? PERCENT_PROBLEM : null}
            value={edit.pending} onChange={v => set({ pending: v })} />
          <SettingField id={`${uid}-billing`} label="Billing (%)" help={billingHelp(data.piBillingPercent)}
            problem={percentBad(edit.billing, true) ? PERCENT_PROBLEM : null}
            value={edit.billing} onChange={v => set({ billing: v })} />
          <SettingField id={`${uid}-account`} label="Received in account (₹)" help={receivedHelp(data.financeAccountVerified)}
            problem={typedBad(edit.advanceAccount) ? AMOUNT_PROBLEM : null}
            value={edit.advanceAccount} onChange={v => set({ advanceAccount: v })} />
          <SettingField id={`${uid}-cash`} label="Received in cash (₹)" help={receivedHelp(data.financeCashVerified)}
            problem={typedBad(edit.advanceCash) ? AMOUNT_PROBLEM : null}
            value={edit.advanceCash} onChange={v => set({ advanceCash: v })} />
        </div>
      </fieldset>

      {/* ── 3. The goods in this lot: 11 columns under three headings, the rates under the name ── */}
      <section className="opp-card" aria-labelledby={`${uid}-goods`}>
        <div className="opp-card-head">
          <h2 className="opp-section-title" id={`${uid}-goods`}>Goods in this lot</h2>
          <p className="opp-block-note">
            {canEdit ? 'Type how many of each item leave in this lot. Amounts fill in as you type.' : 'How many of each item leave in this lot.'}
          </p>
        </div>
        <div className="opp-scroll">
          <table className="opp-grid">
            <colgroup>
              <col style={{ width: 60 }} /><col style={{ width: 74 }} /><col />
              <col style={{ width: 76 }} /><col style={{ width: 64 }} /><col style={{ width: 100 }} /><col style={{ width: 64 }} />
              <col style={{ width: 100 }} /><col style={{ width: 92 }} /><col style={{ width: 92 }} /><col style={{ width: 108 }} />
            </colgroup>
            <thead>
              <tr className="opp-grid-groups">
                <th className="l" colSpan={3} scope="colgroup">Product</th>
                <th className="opp-gs" colSpan={4} scope="colgroup">Quantity</th>
                <th className="opp-gs" colSpan={4} scope="colgroup">Amount in this lot</th>
              </tr>
              <tr>
                <th className="l"><span className="opp-sr">Picture</span></th><th className="l">Code</th><th className="l">Item and rates</th>
                <th className="opp-gs">Ordered</th><th>Sent</th><th className="opp-lot">This lot</th><th>Left</th>
                <th className="opp-gs">Items</th><th>Packing</th><th>Fabric</th><th>Total</th>
              </tr>
            </thead>
            <tbody>
              {result.lines.map(l => {
                const text = edit.planned[l.itemSequence] ?? ''
                const n = parseTypedNumber(text)
                const issue = lotQuantityProblem(l, n !== null && Number.isNaN(n))
                const issueId = `${uid}-qty-${l.itemSequence}`
                const none = l.planned <= 0
                return (
                  <tr key={l.itemSequence}>
                    <td className="l">
                      {pictures[l.itemSequence]
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={pictures[l.itemSequence]} alt={l.productName ?? `Line ${l.itemSequence}`} className="opp-thumb" loading="lazy" />
                        : <span className="opp-thumb opp-thumb--none">No image</span>}
                    </td>
                    <td className="l">{l.itemSequence}</td>
                    <td className="l">
                      <span className="opp-name">{l.productName ?? '—'}</span>
                      <span className="opp-rates">{lineRatesText(l)}</span>
                    </td>
                    <td className="opp-gs">{qty(l.ordered)}</td>
                    <td>{qty(l.previouslyDispatched)}</td>
                    <td className="opp-lot">
                      <input className={`boe-input opp-qty${issue ? ' opp-bad' : ''}`} inputMode="decimal"
                        aria-label={`Quantity of ${l.productName ?? l.itemSequence} in this lot`}
                        aria-invalid={issue ? true : undefined} aria-describedby={issue ? issueId : undefined}
                        value={text} disabled={!canEdit || busy} onChange={e => setQty(l.itemSequence, e.target.value)} />
                      {issue && (
                        <span id={issueId} className="opp-field-problem"><AlertTriangle aria-hidden="true" />{issue}</span>
                      )}
                    </td>
                    <td>{qty(Math.max(0, l.remaining))}</td>
                    <td className="opp-gs">{none ? <Dash /> : rs(l.plannedPaise)}</td>
                    <td>{none || l.plannedPackingPaise === 0 ? <Dash /> : rs(l.plannedPackingPaise)}</td>
                    <td>{none || l.plannedFabricPaise === 0 ? <Dash /> : rs(l.plannedFabricPaise)}</td>
                    <td><strong>{none ? <Dash /> : rs(l.plannedLineTotalPaise)}</strong></td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="l" colSpan={3}>This lot · {qty(sum(l => l.planned))} pieces</td>
                <td className="opp-gs">{qty(sum(l => l.ordered))}</td>
                <td>{qty(sum(l => l.previouslyDispatched))}</td>
                <td className="opp-lot">{qty(sum(l => l.planned))}</td>
                <td>{qty(sum(l => Math.max(0, l.remaining)))}</td>
                <td className="opp-gs">{hasPlanned ? rs(result.lot.items) : <Dash />}</td>
                <td>{hasPlanned && result.lot.packing !== 0 ? rs(result.lot.packing) : <Dash />}</td>
                <td>{hasPlanned && result.lot.fabric !== 0 ? rs(result.lot.fabric) : <Dash />}</td>
                <td>{hasPlanned ? rs(lotTotal) : <Dash />}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* ── 4. How the amount is worked out: folded, one click opens it ── */}
      <details className="opp-fold">
        <summary>
          <span className="opp-fold-title">How the amount is worked out</span>
          <span className="opp-fold-sub">Value, the billed and cash parts, and what is needed in bank and in cash</span>
        </summary>
        <div className="opp-fold-body">
          <div className="opp-scroll">
            <table className="opp-calc">
              <thead>
                <tr><th className="l"></th>{sheet.calcColumns.map(c => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {sheet.calcRows.map((r, i) => r.kind === 'gap'
                  ? <tr key={`gap${i}`} className="opp-calc-gap" aria-hidden="true"><td colSpan={5}></td></tr>
                  : (
                    <tr key={r.label} className={r.kind === 'line' ? undefined : `opp-calc-${r.kind}`}>
                      <td className="l">{r.label}</td>
                      {r.cells.map((c, j) => (
                        <td key={j} className={r.carried && j < 3 ? 'opp-carried' : undefined}>
                          {c === null ? '' : typeof c === 'string' ? c : rs(c)}
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p className="opp-block-note">Shaded figures are what is needed before this dispatch; they make up the sum at the top. Bank = HDFC. Cash = PNB, Paytm, Canara. All amounts in ₹, rounded to the rupee.</p>
        </div>
      </details>

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
      {problem && !canEdit && <p className="opp-warn" role="alert">{problem}</p>}

      {dispatchedLots.length > 0 && (
        <div className="opp-history">
          <h2 className="opp-section-title">Dispatched lots</h2>
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

      {/* ── 5. Save: a bar that stays at the bottom of the screen while the page scrolls ── */}
      {canEdit && (
        <div className="opp-bar">
          {problem && <p className="opp-warn opp-bar-problem" role="alert">{problem}</p>}
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
          <span className={`opp-status${dirty ? ' opp-status-dirty' : ''}`} role="status">
            <i aria-hidden="true" />{busy ? 'Saving…' : dirty ? 'Unsaved changes' : 'No unsaved changes'}
          </span>
          <button type="button" className="boe-btn boe-btn-primary" disabled={busy || !dirty || parsed.invalid}
            onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save plan'}
          </button>
        </div>
      )}
    </section>
  )
}
